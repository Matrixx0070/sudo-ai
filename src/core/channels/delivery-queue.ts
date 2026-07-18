/**
 * @file delivery-queue.ts — GW-15 durable outbound delivery queue
 *
 * OpenClaw's delivery-queue model, scoped down. Outbound is SUDO's fragile half
 * (the #751 empty-reply → Telegram 400s → total silence incident; IMAP
 * starvation). This adds ack/claim semantics and — critically — distinguishes
 * "failed before the platform saw it" (safe to retry) from "platform may have
 * sent it" (retry = a duplicate message to a human).
 *
 * State machine:
 *   pending → claimed → dispatched → acked
 *                                  ↘ failed-presend (retryable, backoff, max 5)
 *                                  ↘ failed-postsend (terminal — platform rejected)
 *                                  ↘ unknown       (maybe delivered — NOT auto-retried)
 *
 * Crash-safety: `dispatched` is written BEFORE the platform call. If the process
 * dies between `dispatched` and `acked`, boot recovery moves the row to
 * `unknown` (never re-dispatches it) so a human is never double-messaged.
 *
 * Media payloads are spooled to disk (mediaDir/<id>/) so a crash can't orphan an
 * attachment mid-send; the spool is cleaned up on ack (or on terminal failure).
 *
 * This is the layer BELOW the #751 normalizeReplyText guard — it never inspects
 * or rewrites payloads, only persists and schedules them.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('channels:delivery-queue');

export type DeliveryState =
  | 'pending'
  | 'claimed'
  | 'dispatched'
  | 'acked'
  | 'failed-presend'
  | 'failed-postsend'
  | 'unknown';

/** How a send error is classified for retry-safety. */
export type DeliveryClass = 'presend' | 'postsend' | 'unknown';

export interface SpooledAttachment {
  filename: string;
  data: Buffer;
}

export interface DeliveryInput {
  channel: string;
  account: string;
  peer: string;
  text: string;
  media?: SpooledAttachment[];
}

/** What the injected sender receives — media resolved to on-disk paths. */
export interface ResolvedDelivery {
  id: string;
  channel: string;
  account: string;
  peer: string;
  text: string;
  mediaPaths: string[];
}

export type DeliverFn = (d: ResolvedDelivery) => Promise<void>;
export type ErrorClassifier = (err: unknown) => DeliveryClass;

export interface DeliveryAlert {
  kind: 'unknown-dropped' | 'unknown-surfaced' | 'presend-exhausted';
  id: string;
  channel: string;
  peer: string;
  attempt: number;
  lastError?: string | undefined;
}

export interface DeliveryQueueOptions {
  /** Max presend retry attempts before giving up (failed-presend). Default 5. */
  maxAttempts?: number;
  /** A claim older than this without progress is reclaimable. Default 60s. */
  claimTtlMs?: number;
  /** `unknown` rows older than this are dropped (with alert) at recovery. Default 24h. */
  unknownTtlMs?: number;
  /** Exponential backoff base. Default 1000ms → 1s, 2s, 4s, 8s, 16s. */
  backoffBaseMs?: number;
  /** Directory for spooled media. Default DATA_DIR/outbox-media. */
  mediaDir?: string;
  /** Error → retry-class classifier. Default {@link defaultClassifier}. */
  classify?: ErrorClassifier;
  /** Injected clock (tests). */
  now?: () => number;
  /** Telemetry alert seam (invariant #10). */
  onAlert?: (a: DeliveryAlert) => void;
}

interface DeliveryRow {
  id: string;
  channel: string;
  account: string;
  peer: string;
  payload_ref: string;
  state: DeliveryState;
  attempt: number;
  last_error: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number;
  next_attempt_at: number;
  updated_at: number;
}

interface PayloadRef {
  text: string;
  media: string[]; // filenames under mediaDir/<id>/
}

/**
 * Default classifier. Conservative by design: only clearly pre-send failures are
 * retried; anything that might have reached the platform is `unknown` and left
 * for a human/reconciler rather than risking a duplicate.
 *
 * Convention (channels set `err.deliveryClass` when they know): a ChannelError
 * with code `channel_not_connected` / `channel_send_failed` before any bytes, or
 * a Node network error (ECONN*, ENOTFOUND, ETIMEDOUT with no response) → presend.
 */
export function defaultClassifier(err: unknown): DeliveryClass {
  const tagged = (err as { deliveryClass?: DeliveryClass } | null)?.deliveryClass;
  if (tagged === 'presend' || tagged === 'postsend' || tagged === 'unknown') return tagged;

  const code = (err as { code?: unknown } | null)?.code;
  const codeStr = typeof code === 'string' ? code : '';
  const presendCodes = new Set([
    'channel_not_connected',
    'channel_invalid_peer',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
  ]);
  if (presendCodes.has(codeStr)) return 'presend';

  // A definitive platform rejection (the request reached the API and was
  // refused, e.g. Telegram 400) → terminal; a retry reproduces the rejection.
  const status = (err as { status?: unknown; error_code?: unknown } | null);
  const httpStatus = typeof status?.status === 'number' ? status.status
    : typeof status?.error_code === 'number' ? status.error_code : undefined;
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) return 'postsend';

  // Everything else (5xx, ambiguous timeouts after send) → unknown.
  return 'unknown';
}

const DDL = `
  CREATE TABLE IF NOT EXISTS deliveries (
    id              TEXT PRIMARY KEY,
    channel         TEXT NOT NULL,
    account         TEXT NOT NULL,
    peer            TEXT NOT NULL,
    payload_ref     TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'pending',
    attempt         INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    claimed_by      TEXT,
    claimed_at      INTEGER,
    created_at      INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_state ON deliveries(state, next_attempt_at);
`;

/**
 * Durable outbound delivery queue. Single-daemon, single-claimant — a per-process
 * `claimant` id guards against a second worker in the same process. The store is
 * synchronous (better-sqlite3), so claim/mark transitions are atomic.
 */
export class DeliveryQueue {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;
  private readonly maxAttempts: number;
  private readonly claimTtlMs: number;
  private readonly unknownTtlMs: number;
  private readonly backoffBaseMs: number;
  private readonly mediaDir: string;
  private readonly classify: ErrorClassifier;
  private readonly now: () => number;
  private readonly onAlert: ((a: DeliveryAlert) => void) | undefined;
  private readonly claimant = `dq-${process.pid}-${genId()}`;

  constructor(dbOrPath: Database.Database | string, opts: DeliveryQueueOptions = {}) {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.db.exec(DDL);
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.claimTtlMs = opts.claimTtlMs ?? 60_000;
    this.unknownTtlMs = opts.unknownTtlMs ?? 24 * 60 * 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.mediaDir = opts.mediaDir ?? path.join(DATA_DIR, 'outbox-media');
    this.classify = opts.classify ?? defaultClassifier;
    this.now = opts.now ?? Date.now;
    this.onAlert = opts.onAlert;
  }

  /** Enqueue a delivery. Media is spooled to disk before the row is committed. */
  enqueue(input: DeliveryInput): string {
    const id = genId();
    const mediaFilenames = this.spoolMedia(id, input.media ?? []);
    const ref: PayloadRef = { text: input.text, media: mediaFilenames };
    const t = this.now();
    this.db
      .prepare(`INSERT INTO deliveries
        (id, channel, account, peer, payload_ref, state, attempt, created_at, next_attempt_at, updated_at)
        VALUES (@id, @channel, @account, @peer, @payloadRef, 'pending', 0, @t, @t, @t)`)
      .run({ id, channel: input.channel, account: input.account, peer: input.peer, payloadRef: JSON.stringify(ref), t });
    return id;
  }

  /**
   * Atomically claim the next eligible delivery: a `pending` row whose
   * next_attempt_at has arrived, or a `claimed` row whose claim is stale.
   * Returns the claimed row, or null when nothing is eligible.
   */
  claimNext(): DeliveryRow | null {
    const t = this.now();
    const staleCutoff = t - this.claimTtlMs;
    const claim = this.db.transaction((): DeliveryRow | null => {
      const row = this.db
        .prepare(`SELECT * FROM deliveries
          WHERE (state = 'pending' AND next_attempt_at <= @t)
             OR (state = 'claimed' AND (claimed_at IS NULL OR claimed_at <= @staleCutoff))
          ORDER BY created_at ASC LIMIT 1`)
        .get({ t, staleCutoff }) as DeliveryRow | undefined;
      if (!row) return null;
      this.db
        .prepare(`UPDATE deliveries SET state='claimed', claimed_by=@by, claimed_at=@t, updated_at=@t WHERE id=@id`)
        .run({ by: this.claimant, t, id: row.id });
      return { ...row, state: 'claimed', claimed_by: this.claimant, claimed_at: t };
    });
    return claim();
  }

  /**
   * Claim + dispatch one delivery through `deliver`. Marks `dispatched` BEFORE
   * the platform call, then acks or classifies the failure. Returns the terminal
   * (or next) state, or null when nothing was eligible to send.
   */
  async dispatchOne(deliver: DeliverFn): Promise<DeliveryState | null> {
    const row = this.claimNext();
    if (!row) return null;
    return this.dispatchRow(row, deliver);
  }

  /** Dispatch a specific already-claimed row (exposed for crash-test control). */
  async dispatchRow(row: DeliveryRow, deliver: DeliverFn): Promise<DeliveryState> {
    const ref = JSON.parse(row.payload_ref) as PayloadRef;
    const attempt = row.attempt + 1;
    const t0 = this.now();
    // Commit `dispatched` BEFORE the platform call — the crash-safety pivot.
    this.db
      .prepare(`UPDATE deliveries SET state='dispatched', attempt=@attempt, updated_at=@t WHERE id=@id`)
      .run({ attempt, t: t0, id: row.id });

    try {
      await deliver({
        id: row.id,
        channel: row.channel,
        account: row.account,
        peer: row.peer,
        text: ref.text,
        mediaPaths: ref.media.map((f) => path.join(this.mediaDir, row.id, f)),
      });
      this.setState(row.id, 'acked', attempt, null);
      this.cleanupMedia(row.id);
      return 'acked';
    } catch (err) {
      const cls = this.classify(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (cls === 'presend') {
        if (attempt >= this.maxAttempts) {
          this.setState(row.id, 'failed-presend', attempt, msg);
          this.cleanupMedia(row.id);
          this.alert({ kind: 'presend-exhausted', id: row.id, channel: row.channel, peer: row.peer, attempt, lastError: msg });
          return 'failed-presend';
        }
        // Back to pending with exponential backoff.
        const delay = this.backoffBaseMs * Math.pow(2, attempt - 1);
        const next = this.now() + delay;
        this.db
          .prepare(`UPDATE deliveries SET state='pending', attempt=@attempt, last_error=@msg, claimed_by=NULL, claimed_at=NULL, next_attempt_at=@next, updated_at=@now WHERE id=@id`)
          .run({ attempt, msg, next, now: this.now(), id: row.id });
        return 'pending';
      }
      if (cls === 'postsend') {
        this.setState(row.id, 'failed-postsend', attempt, msg);
        this.cleanupMedia(row.id);
        return 'failed-postsend';
      }
      // unknown — may have been delivered; surface, never auto-retry.
      this.setState(row.id, 'unknown', attempt, msg);
      this.alert({ kind: 'unknown-surfaced', id: row.id, channel: row.channel, peer: row.peer, attempt, lastError: msg });
      return 'unknown';
    }
  }

  /**
   * Boot recovery. Runs BEFORE the queue starts dispatching.
   *  - `dispatched` at boot = crashed mid-send → move to `unknown` (never resend).
   *  - stale `claimed` → back to `pending` (reclaimable).
   *  - `unknown` older than unknownTtlMs → drop (with alert), never silent.
   */
  recover(): { orphanedDispatched: number; reclaimedClaimed: number; droppedUnknown: number } {
    const t = this.now();
    const staleCutoff = t - this.claimTtlMs;
    const unknownCutoff = t - this.unknownTtlMs;

    const dispatched = this.db.prepare(`SELECT * FROM deliveries WHERE state='dispatched'`).all() as DeliveryRow[];
    for (const row of dispatched) {
      this.setState(row.id, 'unknown', row.attempt, 'process restarted mid-dispatch');
      this.alert({ kind: 'unknown-surfaced', id: row.id, channel: row.channel, peer: row.peer, attempt: row.attempt, lastError: 'restart mid-dispatch' });
    }

    const reclaimed = this.db
      .prepare(`UPDATE deliveries SET state='pending', claimed_by=NULL, claimed_at=NULL, updated_at=@t
        WHERE state='claimed' AND (claimed_at IS NULL OR claimed_at <= @staleCutoff)`)
      .run({ t, staleCutoff }).changes;

    const staleUnknown = this.db.prepare(`SELECT * FROM deliveries WHERE state='unknown' AND updated_at <= @cutoff`).all({ cutoff: unknownCutoff }) as DeliveryRow[];
    for (const row of staleUnknown) {
      this.alert({ kind: 'unknown-dropped', id: row.id, channel: row.channel, peer: row.peer, attempt: row.attempt, lastError: row.last_error ?? undefined });
      this.db.prepare(`DELETE FROM deliveries WHERE id=@id`).run({ id: row.id });
      this.cleanupMedia(row.id);
    }

    if (dispatched.length || reclaimed || staleUnknown.length) {
      log.warn({ orphanedDispatched: dispatched.length, reclaimedClaimed: reclaimed, droppedUnknown: staleUnknown.length }, 'delivery-queue boot recovery');
    }
    return { orphanedDispatched: dispatched.length, reclaimedClaimed: reclaimed, droppedUnknown: staleUnknown.length };
  }

  /** Fetch a row by id (tests / reconciler). */
  get(id: string): DeliveryRow | undefined {
    return this.db.prepare(`SELECT * FROM deliveries WHERE id=@id`).get({ id }) as DeliveryRow | undefined;
  }

  /** Count rows in a given state (tests / telemetry). */
  countByState(state: DeliveryState): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE state=@state`).get({ state }) as { n: number }).n;
  }

  /** Close the DB when the queue owns it. */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  // -------------------------------------------------------------------------

  private setState(id: string, state: DeliveryState, attempt: number, lastError: string | null): void {
    this.db
      .prepare(`UPDATE deliveries SET state=@state, attempt=@attempt, last_error=@lastError, updated_at=@t WHERE id=@id`)
      .run({ state, attempt, lastError, t: this.now(), id });
  }

  private spoolMedia(id: string, media: SpooledAttachment[]): string[] {
    if (media.length === 0) return [];
    const dir = path.join(this.mediaDir, id);
    mkdirSync(dir, { recursive: true });
    const names: string[] = [];
    for (const m of media) {
      const safe = path.basename(m.filename) || `att-${names.length}`;
      writeFileSync(path.join(dir, safe), m.data);
      names.push(safe);
    }
    return names;
  }

  private cleanupMedia(id: string): void {
    const dir = path.join(this.mediaDir, id);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn({ id, err: String(err) }, 'delivery-queue: media spool cleanup failed');
    }
  }

  /** Test helper: does a spool dir exist for this id? */
  hasSpool(id: string): boolean {
    const dir = path.join(this.mediaDir, id);
    return existsSync(dir) && readdirSync(dir).length > 0;
  }

  private alert(a: DeliveryAlert): void {
    try {
      this.onAlert?.(a);
    } catch (err) {
      log.warn({ err: String(err) }, 'delivery-queue: onAlert threw');
    }
  }
}
