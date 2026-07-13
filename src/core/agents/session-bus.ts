/**
 * @file session-bus.ts
 * @description Inter-session messaging primitives (Spec 6). Backs sessions.send:
 * a per-session HOP registry (depth + visited chain for hop-limit + cycle
 * detection) and an append-only audit log. Delivery itself is done by the tool
 * via the injected agentLoop.run seam; this module tracks the safety state that
 * must survive across the delivered turn (so a target's onward sends inherit the
 * chain). PR2 adds the SQLite durable queue for offline delivery-on-next-run.
 */

import { appendFileSync, mkdirSync, existsSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';

const log = createLogger('agents:session-bus');

/** Max chain length A→B→C… (hop depth). A root send is depth 0. */
export const MAX_HOP_DEPTH = 3;
const AUDIT_PATH = dataPath('session-bus.jsonl');
const QUEUE_PATH = dataPath('session-queue.json');
const REGISTRY_MAX = 5000;
const QUEUE_MAX_PER_TARGET = 50;

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
/** Clear a target's chain once its delivered turn ends — the chain is scoped to
 *  that delivery, NOT to the session forever (else it poisons later sends). */
export function clearSendChain(sessionId: string): void { _chains.delete(sessionId); }

// In-flight guard: sessions currently running a delivered turn. sessions.send
// must not start a CONCURRENT run() on a session that's already running (a
// second run corrupts shared session state) — deliver via the queue instead.
const _inflight = new Set<string>();
export function isInflight(sessionId: string): boolean { return _inflight.has(sessionId); }
export function markInflight(sessionId: string): void { _inflight.add(sessionId); }
export function clearInflight(sessionId: string): void { _inflight.delete(sessionId); }

export function __resetSessionBusForTests(): void { _chains.clear(); _inflight.clear(); }

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

// ---------------------------------------------------------------------------
// Durable offline queue — a message for a target that isn't delivered now is
// persisted and drained when that target next runs (acceptance 6). File-backed
// so it survives a restart. Low volume; whole-map read/write is fine.
// ---------------------------------------------------------------------------

export interface QueuedMessage { from: string; envelope: string; ts: string }
let _skipQueuePersist = false;

function _readQueue(): Record<string, QueuedMessage[]> {
  if (_skipQueuePersist) return _memQueue;
  try { if (existsSync(QUEUE_PATH)) return JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) as Record<string, QueuedMessage[]>; }
  catch (err) { log.warn({ err: String(err) }, 'session-queue read failed'); }
  return {};
}
function _writeQueue(q: Record<string, QueuedMessage[]>): void {
  if (_skipQueuePersist) { _memQueue = q; return; }
  try {
    const dir = dirname(QUEUE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(QUEUE_PATH, JSON.stringify(q), { mode: 0o600 });
  } catch (err) { log.warn({ err: String(err) }, 'session-queue write failed'); }
}
let _memQueue: Record<string, QueuedMessage[]> = {};

/** Persist an envelope for a target to deliver on its next run. */
export function enqueueForTarget(targetSessionId: string, from: string, envelope: string): void {
  const q = _readQueue();
  const arr = q[targetSessionId] ?? [];
  arr.push({ from, envelope, ts: new Date().toISOString() });
  while (arr.length > QUEUE_MAX_PER_TARGET) arr.shift();
  q[targetSessionId] = arr;
  _writeQueue(q);
}

/** Remove + return all queued envelopes for a session (called at its next run start). */
export function drainQueueForSession(sessionId: string): QueuedMessage[] {
  const q = _readQueue();
  const arr = q[sessionId];
  if (!arr || arr.length === 0) return [];
  delete q[sessionId];
  _writeQueue(q);
  return arr;
}

export function __resetQueueForTests(): void { _memQueue = {}; _skipQueuePersist = true; }

/** Append-only audit of every send attempt (delivered/blocked). Best-effort. */
export function auditSend(entry: Record<string, unknown>): void {
  try {
    const dir = dirname(AUDIT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    try { chmodSync(AUDIT_PATH, 0o600); } catch { /* best-effort */ }
  } catch (err) { log.warn({ err: String(err) }, 'session-bus audit append failed'); }
}
