/**
 * @file webhook-bridge.ts
 * @description Wiring seam for inbound webhooks (Spec 4). Boot registers a
 * bridge that turns a (hookId, prompt, allowlist) into an agent turn on session
 * `hook:<hookId>` and returns the reply. The webhook route reaches it through
 * this singleton without threading the session manager / agent loop.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('gateway:webhook-bridge');

export interface WebhookRunOpts {
  toolAllowlist?: string[];
  toolDeny?: string[];
  timeoutMs?: number;
}
export interface WebhookRunResult { ok: boolean; reply: string; sessionId?: string; reason?: string }

export interface WebhookBridgeDeps {
  /** Run a hook turn on session hook:<hookId>; returns the agent's reply text. */
  run(hookId: string, prompt: string, opts: WebhookRunOpts): Promise<{ reply: string; sessionId: string }>;
}

let _deps: WebhookBridgeDeps | null = null;

export function registerWebhookBridge(deps: WebhookBridgeDeps): void {
  _deps = deps;
  log.info('webhook bridge registered');
}
export function isWebhookBridgeReady(): boolean { return _deps !== null; }

/** Run a hook turn. Enforces a wall-clock timeout so a stuck turn can't hang the request. */
export async function runWebhookTurn(hookId: string, prompt: string, opts: WebhookRunOpts = {}): Promise<WebhookRunResult> {
  if (!_deps) return { ok: false, reply: '', reason: 'webhook bridge not wired' };
  const timeoutMs = opts.timeoutMs ?? 120_000;
  try {
    const raced = await Promise.race([
      _deps.run(hookId, prompt, opts),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('hook turn timed out')), timeoutMs)),
    ]);
    return { ok: true, reply: raced.reply, sessionId: raced.sessionId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ hookId, reason }, 'webhook turn failed');
    return { ok: false, reply: '', reason };
  }
}

export function __resetWebhookBridgeForTests(): void { _deps = null; }
