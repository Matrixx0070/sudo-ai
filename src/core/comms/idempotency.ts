/**
 * @file comms/idempotency.ts
 * @description Tool-level idempotency guard for side-effecting comms sends.
 *
 * Problem: a task that SENDS something (email, Telegram, SMS, …) can be
 * re-dispatched after a crash/timeout/retry. With no guard, the provider call
 * fires again and the recipient gets a duplicate. retryFailed() in the task
 * queue re-queues failed tasks blindly; nothing records that a send already
 * succeeded.
 *
 * Guard: a persisted `sent_side_effects` ledger keyed on a deterministic
 * idempotency key (caller-supplied, or hash of channel+recipient+body). A send
 * `begin()`s a claim transactionally; a duplicate claim (in-flight, or a
 * confirmed send still inside the dedup window) short-circuits to the prior
 * result instead of re-calling the provider. On provider failure the claim is
 * `release()`d so a genuine retry can proceed — successful sends are never
 * re-fired, failed ones still can be.
 *
 * Opt-in (default off, preserving prior always-send behaviour): enable with
 * SUDO_COMMS_IDEMPOTENCY=1. Window tunable via SUDO_COMMS_IDEMPOTENCY_WINDOW_MS
 * (default 1h) — long enough to absorb a crash-then-redispatch, short enough
 * that an intentionally-repeated message later still goes through.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIND_DB } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('comms:idempotency');

/** Opt-in flag, read per-call so the daemon can toggle without a code change. */
export function isCommsIdempotencyEnabled(): boolean {
  return process.env['SUDO_COMMS_IDEMPOTENCY'] === '1';
}

function windowMs(): number {
  const raw = Number(process.env['SUDO_COMMS_IDEMPOTENCY_WINDOW_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000; // 1h default
}

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS sent_side_effects (
    key            TEXT PRIMARY KEY,
    channel        TEXT NOT NULL,
    recipient_hash TEXT NOT NULL,
    message_id     TEXT,
    status         TEXT NOT NULL,   -- 'pending' | 'sent'
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sse_created ON sent_side_effects(created_at);
`;

export interface SendIdentity {
  /** Delivery channel (e.g. 'email', 'telegram', 'sms'). */
  channel: string;
  /** Recipient identifier (email address, chat id, phone, …). */
  recipient: string;
  /** Message body (and any subject) — the content that must not double-send. */
  body: string;
  /**
   * Optional caller-supplied key (e.g. derived from a task id). When present it
   * is used verbatim, giving exact-once semantics independent of content.
   */
  explicitKey?: string;
}

export interface BeginResult {
  /** True when an identical send is in-flight or was confirmed within the window. */
  duplicate: boolean;
  /** Prior provider message id, when the duplicate was already confirmed. */
  messageId?: string;
  /** The resolved idempotency key — pass to confirm()/release(). */
  key: string;
}

/** Derive the idempotency key: explicit key if given, else hash of channel+recipient+body. */
export function deriveCommsKey(id: SendIdentity): string {
  if (id.explicitKey && id.explicitKey.trim()) return id.explicitKey.trim();
  return createHash('sha256')
    .update(JSON.stringify([id.channel, id.recipient, id.body]))
    .digest('hex');
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * SQLite-backed claim ledger. One row per (idempotency key); status moves
 * pending → sent on confirm, or the row is deleted on release.
 */
export class CommsIdempotencyStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = MIND_DB) {
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(CREATE_SQL);
  }

  /**
   * Transactionally claim a send. Returns `duplicate: true` when an identical
   * send is in-flight (`pending`) or was confirmed (`sent`) within the dedup
   * window; otherwise records a `pending` claim and returns `duplicate: false`.
   *
   * @param id    - Send identity (channel/recipient/body or explicit key).
   * @param nowMs - Clock injection point for tests; defaults to Date.now().
   */
  begin(id: SendIdentity, nowMs: number = Date.now()): BeginResult {
    const key = deriveCommsKey(id);
    const recipientHash = shortHash(id.recipient);
    const cutoff = new Date(nowMs - windowMs()).toISOString();
    const nowIso = new Date(nowMs).toISOString();

    const txn = this.db.transaction((): BeginResult => {
      const row = this.db
        .prepare('SELECT status, message_id, created_at FROM sent_side_effects WHERE key = ?')
        .get(key) as { status: string; message_id: string | null; created_at: string } | undefined;

      if (row) {
        if (row.created_at >= cutoff) {
          if (row.status === 'sent') {
            return { duplicate: true, messageId: row.message_id ?? undefined, key };
          }
          // pending within window — in-flight; block concurrent double-send
          return { duplicate: true, key };
        }
        // Stale (pending from a crashed sender, or old confirmed send) outside
        // the window → reclaim as a fresh pending so the send can proceed.
        this.db
          .prepare(
            "UPDATE sent_side_effects SET status='pending', message_id=NULL, created_at=?, channel=?, recipient_hash=? WHERE key=?",
          )
          .run(nowIso, id.channel, recipientHash, key);
        return { duplicate: false, key };
      }

      this.db
        .prepare(
          "INSERT INTO sent_side_effects (key, channel, recipient_hash, message_id, status, created_at) VALUES (?,?,?,NULL,'pending',?)",
        )
        .run(key, id.channel, recipientHash, nowIso);
      return { duplicate: false, key };
    });

    const result = txn.immediate();
    if (result.duplicate) {
      log.warn({ key, channel: id.channel }, 'comms idempotency: duplicate send suppressed');
    }
    return result;
  }

  /** Mark a claimed send confirmed, recording the provider message id. */
  confirm(key: string, messageId?: string): void {
    this.db.prepare("UPDATE sent_side_effects SET status='sent', message_id=? WHERE key=?").run(messageId ?? null, key);
  }

  /** Release a claim so a genuinely-failed send can be retried. */
  release(key: string): void {
    this.db.prepare('DELETE FROM sent_side_effects WHERE key=?').run(key);
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

let _store: CommsIdempotencyStore | null = null;

/** Lazily-constructed process-wide store over MIND_DB. */
export function getCommsIdempotencyStore(): CommsIdempotencyStore {
  if (!_store) _store = new CommsIdempotencyStore();
  return _store;
}

/**
 * Test-only: replace (or clear, with null) the process-wide store so a suite can
 * point maybeGuardedSend at an isolated DB instead of mutating the real MIND_DB.
 * Pass null in afterEach to restore the lazy MIND_DB singleton.
 */
export function __setCommsIdempotencyStoreForTests(store: CommsIdempotencyStore | null): void {
  _store = store;
}

/**
 * Separate opt-in (default OFF) for guarding raw channel-adapter sends — i.e.
 * live conversation replies that call adapter.send directly, NOT through a
 * guarded tool. Kept distinct from SUDO_COMMS_IDEMPOTENCY (the tool-layer guard,
 * which is enabled in prod) so the riskier live-reply dedup can be turned on
 * deliberately without touching task-redispatch coverage.
 */
export function isCommsAdapterIdempotencyEnabled(): boolean {
  return process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] === '1';
}

/**
 * Wrap a raw adapter send with the idempotency guard, gated by the adapter flag.
 * When the flag is off, `sendFn` runs unchanged. When on, an identical recent
 * send is suppressed; otherwise sendFn runs and the claim is confirmed (or
 * released on failure so a genuine retry proceeds).
 *
 * Safe to apply at a reply CALL SITE: any retries inside the adapter's own
 * send() run within `sendFn`, below this guard, so they are never re-suppressed.
 *
 * @returns true if the send was performed (or the flag is off), false if it was
 *          suppressed as a duplicate.
 */
/** Outcome of a {@link withCommsIdempotency}-wrapped send. */
export interface GuardedToolSend<T> {
  /** True when an identical send was already in-flight/confirmed in the window. */
  duplicate: boolean;
  /** Prior provider message id, when the duplicate was already confirmed. */
  messageId?: string;
  /** The send()'s own result, present only when the send was actually performed. */
  result?: T;
}

/**
 * Tool-level idempotency guard, gated by the SAME flag as message.send/email/sms
 * (`SUDO_COMMS_IDEMPOTENCY`) so one switch governs all builtin outbound tools.
 * Mirrors message.send's begin/confirm/release, made reusable so every comms tool
 * that produces an external side effect (Slack post, email, webhook POST, calendar
 * event) is replay-safe when a turn is re-run (consensus / best-of-N / task retry).
 *
 * Fail-open: any idempotency-machinery error sends unguarded rather than blocking
 * a live outbound. When the flag is off, `send` runs unchanged.
 *
 * @returns `{duplicate:true, messageId?}` if suppressed, else `{duplicate:false, result}`.
 */
export async function withCommsIdempotency<T>(
  id: SendIdentity,
  send: () => Promise<T>,
  extractMessageId?: (result: T) => string | undefined,
): Promise<GuardedToolSend<T>> {
  if (!isCommsIdempotencyEnabled()) {
    return { duplicate: false, result: await send() };
  }
  let claim: BeginResult | null = null;
  try {
    claim = getCommsIdempotencyStore().begin(id);
  } catch (err) {
    log.warn({ channel: id.channel, err: String(err) }, 'tool send: idempotency begin failed — sending unguarded (fail-open)');
    return { duplicate: false, result: await send() };
  }
  if (claim.duplicate) {
    log.warn({ channel: id.channel, key: claim.key }, 'tool send: duplicate suppressed (idempotency)');
    return { duplicate: true, messageId: claim.messageId };
  }
  try {
    const result = await send();
    try { getCommsIdempotencyStore().confirm(claim.key, extractMessageId?.(result)); } catch { /* confirm best-effort */ }
    return { duplicate: false, result };
  } catch (err) {
    try { getCommsIdempotencyStore().release(claim.key); } catch { /* release best-effort */ }
    throw err;
  }
}

export async function maybeGuardedSend(
  channel: string,
  recipient: string,
  body: string,
  sendFn: () => Promise<void>,
): Promise<boolean> {
  if (!isCommsAdapterIdempotencyEnabled()) {
    await sendFn();
    return true;
  }
  // Fail-open: a hiccup in the idempotency machinery (DB locked, etc.) must
  // NEVER block a live reply. If we can't claim, we send unguarded.
  let claim: BeginResult | null = null;
  try {
    claim = getCommsIdempotencyStore().begin({ channel, recipient, body });
  } catch (err) {
    log.warn({ channel, err: String(err) }, 'adapter send: idempotency begin failed — sending unguarded (fail-open)');
  }
  if (claim?.duplicate) {
    log.warn({ channel, key: claim.key }, 'adapter send: duplicate live reply suppressed (idempotency)');
    return false;
  }
  try {
    await sendFn();
    if (claim) { try { getCommsIdempotencyStore().confirm(claim.key); } catch { /* confirm is best-effort */ } }
    return true;
  } catch (err) {
    if (claim) { try { getCommsIdempotencyStore().release(claim.key); } catch { /* release is best-effort */ } }
    throw err; // the real send failed — propagate (this is the existing behaviour)
  }
}
