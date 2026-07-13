/**
 * @file webhook-config.ts
 * @description Loader for config/webhooks.json5 (Spec 4 — inbound webhooks).
 * Maps each hookId to a typed config: signature scheme, the ENV var holding its
 * secret (never the secret itself), prompt template, tool allowlist, response
 * mode, and rate limit. Fail-safe: a missing/unparseable file → no hooks (all
 * requests 404), so enabling the feature is opt-in by config + WEBHOOKS_ENABLED.
 */

import { readFileSync, existsSync } from 'node:fs';
import JSON5 from 'json5';
import { projectPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('gateway:webhook-config');

export type HookSignature = 'github' | 'stripe' | 'hmac' | 'bearer' | 'none';
export type HookMode = 'sync' | 'async';

export interface WebhookHook {
  id: string;
  description?: string;
  signature: HookSignature;
  /** ENV var name holding the secret (resolved at request time). */
  secretEnv?: string;
  prompt: string;
  /** Tool allowlist (globs allowed, e.g. "github.*"). Empty = no tools. */
  tools: string[];
  mode: HookMode;
  rateLimitPerMin: number;
  /** Operator-set URL to POST the async result to (SSRF-guarded). */
  callbackUrl?: string;
  /** Allow self-modify tools (meta.self-modify/self-update). Default false. */
  allowSelfModify: boolean;
}

export interface WebhooksConfig { hooks: Record<string, WebhookHook> }

const CONFIG_PATH = projectPath('config', 'webhooks.json5');
const SIGS: ReadonlySet<string> = new Set(['github', 'stripe', 'hmac', 'bearer', 'none']);

/** Master kill-switch — ingress is OFF unless WEBHOOKS_ENABLED is truthy. */
export function webhooksEnabled(): boolean {
  const v = process.env['WEBHOOKS_ENABLED'];
  return v === '1' || v === 'true' || v === 'yes';
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function normalizeHook(id: string, raw: unknown): WebhookHook | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const signature = (typeof o['signature'] === 'string' && SIGS.has(o['signature'])) ? o['signature'] as HookSignature : 'none';
  const prompt = typeof o['prompt'] === 'string' && o['prompt'].trim() ? o['prompt'] : '';
  if (!prompt) { log.warn({ id }, 'webhook has no prompt — skipped'); return null; }
  const mode: HookMode = o['mode'] === 'async' ? 'async' : 'sync';
  const rlRaw = Number(o['rateLimitPerMin']);
  return {
    id,
    ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
    signature,
    ...(typeof o['secretEnv'] === 'string' && o['secretEnv'].trim() ? { secretEnv: o['secretEnv'].trim() } : {}),
    prompt,
    tools: toStringArray(o['tools']),
    mode,
    rateLimitPerMin: Number.isFinite(rlRaw) && rlRaw > 0 ? Math.floor(rlRaw) : 60,
    ...(typeof o['callbackUrl'] === 'string' && /^https?:\/\//i.test(o['callbackUrl']) ? { callbackUrl: o['callbackUrl'] } : {}),
    allowSelfModify: o['allowSelfModify'] === true,
  };
}

let _cache: WebhooksConfig | null = null;

export function loadWebhooks(path: string = CONFIG_PATH, force = false): WebhooksConfig {
  if (_cache && !force) return _cache;
  if (!existsSync(path)) {
    log.info({ path }, 'no webhooks.json5 — inbound webhooks disabled (all hooks 404)');
    _cache = { hooks: {} };
    return _cache;
  }
  try {
    const raw = JSON5.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const rawHooks = (raw['hooks'] && typeof raw['hooks'] === 'object') ? raw['hooks'] as Record<string, unknown> : {};
    const hooks: Record<string, WebhookHook> = {};
    for (const [id, val] of Object.entries(rawHooks)) {
      const h = normalizeHook(id, val);
      if (h) hooks[id] = h;
    }
    _cache = { hooks };
    log.info({ hooks: Object.keys(hooks) }, 'webhooks.json5 loaded');
    return _cache;
  } catch (err) {
    log.error({ path, err: err instanceof Error ? err.message : String(err) }, 'webhooks.json5 parse failed — inbound webhooks disabled');
    _cache = { hooks: {} };
    return _cache;
  }
}

export function __resetWebhooksForTests(): void { _cache = null; }

/** Look up a hook by id, or null. */
export function getHook(id: string): WebhookHook | null {
  return loadWebhooks().hooks[id] ?? null;
}

/** Resolve the hook's secret from its env var (request time), or null. */
export function hookSecret(hook: WebhookHook): string | null {
  if (!hook.secretEnv) return null;
  const v = process.env[hook.secretEnv];
  return v && v.length > 0 ? v : null;
}
