/**
 * @file webhook-routes.ts
 * @description POST /v1/hooks/:hookId — inbound webhooks → agent turns (Spec 4).
 * Flow: kill-switch → hook lookup → body cap → constant-time signature verify →
 * per-hook rate limit → delivery dedupe → prompt template → dispatch to session
 * hook:<id> (tool allowlist, isOwner:false) → sync {ok,reply} or async 202.
 *
 * No GATEWAY_TOKEN here — each hook authenticates with its OWN secret/signature.
 * `/v1/hooks` must be in the http-api generic-guard defer list, or that guard
 * 401s the request (it wants GATEWAY_TOKEN) before this listener runs.
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { webhooksEnabled, getHook, hookSecret, type WebhookHook } from './webhook-config.js';
import { verifySignature, deliveryId } from './webhook-signatures.js';
import { runWebhookTurn } from './webhook-bridge.js';

const log = createLogger('gateway:webhook-routes');
const MAX_BODY = 1_048_576; // 1 MB
const BODY_IN_PROMPT_CAP = 8_000;
const DEDUPE_TTL_MS = 10 * 60_000;
const DEDUPE_MAX = 5_000;

// --- per-hook fixed-window rate limiter -------------------------------------
const rlWindows = new Map<string, { start: number; count: number }>();
function rateLimited(hookId: string, perMin: number): { limited: boolean; retryAfterS: number } {
  const now = Date.now();
  const w = rlWindows.get(hookId);
  if (!w || now - w.start >= 60_000) { rlWindows.set(hookId, { start: now, count: 1 }); return { limited: false, retryAfterS: 0 }; }
  w.count += 1;
  if (w.count > perMin) return { limited: true, retryAfterS: Math.max(1, Math.ceil((60_000 - (now - w.start)) / 1000)) };
  return { limited: false, retryAfterS: 0 };
}

// --- delivery dedupe (bounded, TTL) -----------------------------------------
const seen = new Map<string, number>();
function isDuplicate(key: string): boolean {
  const now = Date.now();
  if (seen.size > DEDUPE_MAX) { for (const [k, exp] of seen) if (exp < now) seen.delete(k); if (seen.size > DEDUPE_MAX) seen.clear(); }
  const exp = seen.get(key);
  if (exp && exp > now) return true;
  seen.set(key, now + DEDUPE_TTL_MS);
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

function readBodyRaw(req: IncomingMessage): Promise<{ raw: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let total = 0; let tooLarge = false;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) { tooLarge = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ raw: Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('error', (e) => (tooLarge ? resolve({ raw: '', tooLarge: true }) : reject(e)));
  });
}

function headerStr(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Resolve the logical event name for {{event}}. */
function eventName(req: IncomingMessage, raw: string): string {
  const h = headerStr(req, 'x-github-event') || headerStr(req, 'x-event-type') || headerStr(req, 'x-event');
  if (h) return h;
  try { const j = JSON.parse(raw) as { type?: unknown }; if (typeof j.type === 'string') return j.type; } catch { /* not json */ }
  return 'event';
}

/** Fill the prompt template. Supports {{event}}, {{delivery}}, {{body}}, {{header.NAME}}. */
function renderPrompt(hook: WebhookHook, req: IncomingMessage, raw: string, delivery: string): string {
  const event = eventName(req, raw);
  const body = raw.length > BODY_IN_PROMPT_CAP ? raw.slice(0, BODY_IN_PROMPT_CAP) + '\n…[truncated]' : raw;
  return hook.prompt
    .replace(/\{\{event\}\}/g, event)
    .replace(/\{\{delivery\}\}/g, delivery || '(none)')
    .replace(/\{\{body\}\}/g, body)
    .replace(/\{\{header\.([A-Za-z0-9_-]+)\}\}/g, (_m, name: string) => headerStr(req, name));
}

export function registerWebhookRoutes(server: HttpServer): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (!pathname.startsWith('/v1/hooks/')) return;

    if (method !== 'POST') { sendJson(res, 405, { error: { message: 'method not allowed', code: 405 } }); return; }
    if (!webhooksEnabled()) { sendJson(res, 503, { error: { message: 'webhooks disabled (set WEBHOOKS_ENABLED=1)', code: 503 } }); return; }

    const hookId = decodeURIComponent(pathname.slice('/v1/hooks/'.length).split('/')[0] ?? '');
    const hook = getHook(hookId);
    if (!hook) { sendJson(res, 404, { error: { message: `unknown hook "${hookId}"`, code: 404 } }); return; }

    readBodyRaw(req).then(async ({ raw, tooLarge }) => {
      if (tooLarge) { sendJson(res, 413, { error: { message: 'payload too large', code: 413 } }); return; }

      // 1. Authenticate (constant-time). Bad/missing secret → 401.
      const verdict = verifySignature(hook, hookSecret(hook), raw, req.headers);
      if (!verdict.ok) { sendJson(res, 401, { error: { message: `unauthorized: ${verdict.reason}`, code: 401 } }); return; }

      // 2. Rate limit → 429.
      const rl = rateLimited(hookId, hook.rateLimitPerMin);
      if (rl.limited) { sendJson(res, 429, { error: { message: 'rate limited', code: 429 } }, { 'Retry-After': String(rl.retryAfterS) }); return; }

      // 3. Dedupe by delivery id → { ok, deduped:true }.
      const delivery = deliveryId(req.headers) ?? '';
      if (delivery && isDuplicate(`${hookId}:${delivery}`)) {
        log.info({ hookId, delivery }, 'webhook duplicate delivery — skipped');
        sendJson(res, 200, { ok: true, deduped: true });
        return;
      }

      const prompt = renderPrompt(hook, req, raw, delivery);
      const runOpts = { ...(hook.tools.length ? { toolAllowlist: hook.tools } : {}), timeoutMs: 120_000 };
      log.info({ hookId, event: eventName(req, raw), mode: hook.mode, delivery }, 'webhook accepted → dispatching');

      // 4. Async → 202 now, run in background. Sync → await the reply.
      if (hook.mode === 'async') {
        sendJson(res, 202, { ok: true, accepted: true, hookId });
        void runWebhookTurn(hookId, prompt, runOpts).catch((e) => log.warn({ hookId, err: String(e) }, 'async hook turn error'));
        return;
      }
      const r = await runWebhookTurn(hookId, prompt, runOpts);
      sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true, reply: r.reply } : { ok: false, error: r.reason });
    }).catch((err: unknown) => {
      log.error({ hookId, err: String(err) }, 'webhook-routes: unhandled');
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error', code: 500 } });
    });
  });

  log.info('Webhook routes registered (POST /v1/hooks/:hookId)');
}
