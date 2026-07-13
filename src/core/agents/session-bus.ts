/**
 * @file session-bus.ts
 * @description Inter-session messaging primitives (Spec 6). Backs sessions.send:
 * a per-session HOP registry (depth + visited chain for hop-limit + cycle
 * detection) and an append-only audit log. Delivery itself is done by the tool
 * via the injected agentLoop.run seam; this module tracks the safety state that
 * must survive across the delivered turn (so a target's onward sends inherit the
 * chain). PR2 adds the SQLite durable queue for offline delivery-on-next-run.
 */

import { appendFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';

const log = createLogger('agents:session-bus');

/** Max chain length A→B→C… (hop depth). A root send is depth 0. */
export const MAX_HOP_DEPTH = 3;
const AUDIT_PATH = dataPath('session-bus.jsonl');
const REGISTRY_MAX = 5000;

export interface SendChain {
  /** Number of hops taken to reach this session (0 = a root/user session). */
  depth: number;
  /** Session ids visited on the way here (for cycle detection). */
  chain: string[];
}

// sessionId → the chain by which a message reached it. Read when THAT session
// sends onward, so depth/cycle are enforced across the whole pipeline.
const _chains = new Map<string, SendChain>();

export function getSendChain(sessionId: string): SendChain {
  return _chains.get(sessionId) ?? { depth: 0, chain: [sessionId] };
}
export function setSendChain(sessionId: string, chain: SendChain): void {
  if (_chains.size >= REGISTRY_MAX) _chains.clear();
  _chains.set(sessionId, chain);
}
export function __resetSessionBusForTests(): void { _chains.clear(); }

/**
 * Decide whether `from` may deliver to `target`, given the chain that reached
 * `from`. Enforces hop depth + cycle. Returns the chain to stamp on `target`.
 */
export function checkAndAdvance(fromSessionId: string, targetSessionId: string): { ok: boolean; reason?: string; next?: SendChain } {
  const cur = getSendChain(fromSessionId);
  if (cur.depth >= MAX_HOP_DEPTH) {
    return { ok: false, reason: `hop-depth limit (${MAX_HOP_DEPTH}) reached — chain: ${cur.chain.join(' → ')}` };
  }
  if (cur.chain.includes(targetSessionId)) {
    return { ok: false, reason: `cycle detected — ${targetSessionId} is already in the chain ${cur.chain.join(' → ')}` };
  }
  return { ok: true, next: { depth: cur.depth + 1, chain: [...cur.chain, targetSessionId] } };
}

/** Build the injected envelope the target session sees. */
export function buildEnvelope(fromSessionId: string, fromChannel: string | undefined, message: string): string {
  const from = fromChannel ? `session:${fromSessionId} channel:${fromChannel}` : `session:${fromSessionId}`;
  return `[inter-agent message from ${from}]\n${message}`;
}

/** Append-only audit of every send attempt (delivered/blocked). Best-effort. */
export function auditSend(entry: Record<string, unknown>): void {
  try {
    const dir = dirname(AUDIT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    try { chmodSync(AUDIT_PATH, 0o600); } catch { /* best-effort */ }
  } catch (err) { log.warn({ err: String(err) }, 'session-bus audit append failed'); }
}
