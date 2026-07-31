/**
 * @file store.ts
 * @description Persistence for the unified event system — one SQLite file
 * (data/events/events.db, WAL) holding:
 *
 *   events              append-only log of persistent platform events
 *   webhook_endpoints   operator-registered outbound endpoints (+ signing secrets)
 *   webhook_deliveries  the delivery queue (pending → delivering → succeeded |
 *                       pending(retry, backoff) → dead = the dead-letter queue)
 *   webhook_attempts    per-attempt delivery log (status code, error, latency)
 *
 * Single-writer by design (one daemon process); WAL keeps readers cheap.
 * The dead-letter "queue" is simply status='dead' — replayable via replay().
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import { matchesSubscription } from './catalog.js';
import { newWebhookSecret } from './signing.js';
import { newDeliveryId, newEndpointId, type PlatformEvent } from './types.js';

const log = createLogger('events:store');

/** Retry backoff schedule (ms) by retry index; past the end reuses the last. */
export const BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

/** Rotation grace: how long the previous secret keeps co-signing. */
export const ROTATION_GRACE_MS = 24 * 3_600_000;

/** Event/delivery retention for prune(). */
const RETENTION_MS = 30 * 24 * 3_600_000;

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'dead';

export interface WebhookEndpointRow {
  id: string;
  name: string;
  description: string;
  url: string;
  secret: string;
  secretPrev: string | null;
  secretPrevExpiresAt: number | null;
  enabled: number;
  eventTypes: string[];
  retryMax: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRow {
  id: string;
  endpointId: string;
  eventId: string;
  status: DeliveryStatus;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRow {
  deliveryId: string;
  attempt: number;
  at: string;
  ok: number;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

interface EndpointDbRow {
  id: string; name: string; description: string; url: string; secret: string;
  secret_prev: string | null; secret_prev_expires_at: number | null;
  enabled: number; event_types: string; retry_max: number;
  created_at: string; updated_at: string;
}

function rowToEndpoint(r: EndpointDbRow): WebhookEndpointRow {
  let eventTypes: string[] = [];
  try { const p = JSON.parse(r.event_types) as unknown; if (Array.isArray(p)) eventTypes = p.filter((x): x is string => typeof x === 'string'); } catch { /* corrupt → empty */ }
  return {
    id: r.id, name: r.name, description: r.description, url: r.url, secret: r.secret,
    secretPrev: r.secret_prev, secretPrevExpiresAt: r.secret_prev_expires_at,
    enabled: r.enabled, eventTypes, retryMax: r.retry_max,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface DeliveryDbRow {
  id: string; endpoint_id: string; event_id: string; status: DeliveryStatus;
  attempt: number; max_attempts: number; next_attempt_at: number;
  last_status_code: number | null; last_error: string | null;
  created_at: string; updated_at: string;
}

function rowToDelivery(r: DeliveryDbRow): DeliveryRow {
  return {
    id: r.id, endpointId: r.endpoint_id, eventId: r.event_id, status: r.status,
    attempt: r.attempt, maxAttempts: r.max_attempts, nextAttemptAt: r.next_attempt_at,
    lastStatusCode: r.last_status_code, lastError: r.last_error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class EventStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        version         INTEGER NOT NULL,
        created_at      TEXT NOT NULL,
        created_at_ms   INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        channels        TEXT NOT NULL,
        data            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id                     TEXT PRIMARY KEY,
        name                   TEXT NOT NULL,
        description            TEXT NOT NULL DEFAULT '',
        url                    TEXT NOT NULL,
        secret                 TEXT NOT NULL,
        secret_prev            TEXT,
        secret_prev_expires_at INTEGER,
        enabled                INTEGER NOT NULL DEFAULT 1,
        event_types            TEXT NOT NULL,
        retry_max              INTEGER NOT NULL DEFAULT 5,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id               TEXT PRIMARY KEY,
        endpoint_id      TEXT NOT NULL,
        event_id         TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        attempt          INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL,
        next_attempt_at  INTEGER NOT NULL,
        last_status_code INTEGER,
        last_error       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_dedupe
        ON webhook_deliveries(endpoint_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_deliveries_due
        ON webhook_deliveries(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_deliveries_endpoint
        ON webhook_deliveries(endpoint_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS webhook_attempts (
        delivery_id TEXT NOT NULL,
        attempt     INTEGER NOT NULL,
        at          TEXT NOT NULL,
        ok          INTEGER NOT NULL,
        status_code INTEGER,
        error       TEXT,
        duration_ms INTEGER NOT NULL,
        PRIMARY KEY (delivery_id, attempt)
      );
    `);
  }

  // --- events ---------------------------------------------------------------

  insertEvent(evt: PlatformEvent): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO events (id, type, version, created_at, created_at_ms, idempotency_key, channels, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evt.id, evt.type, evt.version, evt.createdAt, Date.parse(evt.createdAt), evt.idempotencyKey,
      JSON.stringify(evt.channels), JSON.stringify(evt.data));
  }

  getEvent(id: string): PlatformEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as
      { id: string; type: string; version: number; created_at: string; idempotency_key: string; channels: string; data: string } | undefined;
    if (!r) return null;
    return {
      id: r.id, type: r.type, version: r.version, createdAt: r.created_at,
      idempotencyKey: r.idempotency_key,
      channels: JSON.parse(r.channels) as string[],
      data: JSON.parse(r.data) as Record<string, unknown>,
    };
  }

  listEvents(opts: { type?: string; limit?: number; sinceMs?: number } = {}): PlatformEvent[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
    const conds: string[] = []; const args: unknown[] = [];
    if (opts.type) { conds.push('type = ?'); args.push(opts.type); }
    if (opts.sinceMs) { conds.push('created_at_ms >= ?'); args.push(opts.sinceMs); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT id FROM events ${where} ORDER BY created_at_ms DESC LIMIT ?`).all(...args, limit) as { id: string }[];
    return rows.map((r) => this.getEvent(r.id)).filter((e): e is PlatformEvent => e !== null);
  }

  // --- endpoints ------------------------------------------------------------

  createEndpoint(input: { name: string; url: string; description?: string; eventTypes: string[]; retryMax?: number; enabled?: boolean }): WebhookEndpointRow {
    const id = newEndpointId();
    const now = new Date().toISOString();
    const secret = newWebhookSecret();
    this.db.prepare(`
      INSERT INTO webhook_endpoints (id, name, description, url, secret, enabled, event_types, retry_max, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.description ?? '', input.url, secret,
      input.enabled === false ? 0 : 1, JSON.stringify(input.eventTypes),
      clampRetry(input.retryMax), now, now);
    return this.getEndpoint(id)!;
  }

  getEndpoint(id: string): WebhookEndpointRow | null {
    const r = this.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id) as EndpointDbRow | undefined;
    return r ? rowToEndpoint(r) : null;
  }

  listEndpoints(): WebhookEndpointRow[] {
    const rows = this.db.prepare('SELECT * FROM webhook_endpoints ORDER BY created_at').all() as EndpointDbRow[];
    return rows.map(rowToEndpoint);
  }

  updateEndpoint(id: string, patch: { name?: string; url?: string; description?: string; eventTypes?: string[]; retryMax?: number; enabled?: boolean }): WebhookEndpointRow | null {
    const cur = this.getEndpoint(id);
    if (!cur) return null;
    this.db.prepare(`
      UPDATE webhook_endpoints SET name = ?, description = ?, url = ?, enabled = ?, event_types = ?, retry_max = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.name ?? cur.name, patch.description ?? cur.description, patch.url ?? cur.url,
      patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
      JSON.stringify(patch.eventTypes ?? cur.eventTypes),
      patch.retryMax === undefined ? cur.retryMax : clampRetry(patch.retryMax),
      new Date().toISOString(), id,
    );
    return this.getEndpoint(id);
  }

  deleteEndpoint(id: string): boolean {
    const del = this.db.transaction((eid: string) => {
      this.db.prepare('DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE endpoint_id = ?)').run(eid);
      this.db.prepare('DELETE FROM webhook_deliveries WHERE endpoint_id = ?').run(eid);
      return this.db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(eid).changes > 0;
    });
    return del(id);
  }

  /** Rotate the signing secret; the old one co-signs until the grace expires. */
  rotateSecret(id: string, nowMs = Date.now()): WebhookEndpointRow | null {
    const cur = this.getEndpoint(id);
    if (!cur) return null;
    const secret = newWebhookSecret();
    this.db.prepare(`
      UPDATE webhook_endpoints SET secret = ?, secret_prev = ?, secret_prev_expires_at = ?, updated_at = ? WHERE id = ?
    `).run(secret, cur.secret, nowMs + ROTATION_GRACE_MS, new Date(nowMs).toISOString(), id);
    return this.getEndpoint(id);
  }

  /** Secrets to sign with right now: current + previous while in grace. */
  signingSecrets(ep: WebhookEndpointRow, nowMs = Date.now()): string[] {
    const out = [ep.secret];
    if (ep.secretPrev && ep.secretPrevExpiresAt && ep.secretPrevExpiresAt > nowMs) out.push(ep.secretPrev);
    return out;
  }

  // --- delivery queue -------------------------------------------------------

  /**
   * Fan a persistent event out to every enabled endpoint whose subscription
   * matches. The (endpoint, idempotencyKey) unique index makes re-publishing
   * with the same idempotency key a no-op per endpoint.
   * @returns number of deliveries enqueued.
   */
  enqueueForEvent(evt: PlatformEvent, nowMs = Date.now()): number {
    let n = 0;
    for (const ep of this.listEndpoints()) {
      if (!ep.enabled) continue;
      if (!matchesSubscription(evt.type, ep.eventTypes)) continue;
      n += this.enqueueDirect(ep, evt, nowMs) ? 1 : 0;
    }
    return n;
  }

  /** Enqueue one delivery for one endpoint (used by fan-out, tests, and /test). */
  enqueueDirect(ep: WebhookEndpointRow, evt: PlatformEvent, nowMs = Date.now()): DeliveryRow | null {
    const now = new Date(nowMs).toISOString();
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_deliveries
        (id, endpoint_id, event_id, idempotency_key, status, attempt, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
    `).run(newDeliveryId(), ep.id, evt.id, evt.idempotencyKey, ep.retryMax + 1, nowMs, now, now);
    if (res.changes === 0) return null; // deduped by (endpoint, idempotency_key)
    const r = this.db.prepare('SELECT * FROM webhook_deliveries WHERE endpoint_id = ? AND idempotency_key = ?')
      .get(ep.id, evt.idempotencyKey) as DeliveryDbRow;
    return rowToDelivery(r);
  }

  /** Claim up to `limit` due deliveries (marks them 'delivering'). */
  claimDue(nowMs = Date.now(), limit = 10): DeliveryRow[] {
    const claim = this.db.transaction((): DeliveryRow[] => {
      const rows = this.db.prepare(`
        SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at LIMIT ?
      `).all(nowMs, limit) as DeliveryDbRow[];
      const mark = this.db.prepare("UPDATE webhook_deliveries SET status = 'delivering', updated_at = ? WHERE id = ?");
      const now = new Date(nowMs).toISOString();
      for (const r of rows) mark.run(now, r.id);
      return rows.map((r) => rowToDelivery({ ...r, status: 'delivering' }));
    });
    return claim();
  }

  /**
   * Record the outcome of one attempt. Success → 'succeeded'. Failure →
   * back to 'pending' with exponential backoff, or 'dead' (DLQ) once the
   * attempt budget is spent.
   */
  recordAttempt(
    delivery: DeliveryRow,
    outcome: { ok: boolean; statusCode?: number; error?: string; durationMs: number },
    nowMs = Date.now(),
  ): DeliveryRow {
    const attempt = delivery.attempt + 1;
    const now = new Date(nowMs).toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO webhook_attempts (delivery_id, attempt, at, ok, status_code, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(delivery.id, attempt, now, outcome.ok ? 1 : 0, outcome.statusCode ?? null,
      outcome.error ? outcome.error.slice(0, 500) : null, Math.round(outcome.durationMs));

    let status: DeliveryStatus; let nextAt = delivery.nextAttemptAt;
    if (outcome.ok) {
      status = 'succeeded';
    } else if (attempt >= delivery.maxAttempts) {
      status = 'dead';
      log.warn({ deliveryId: delivery.id, endpointId: delivery.endpointId, attempt }, 'delivery exhausted retries — moved to DLQ');
    } else {
      status = 'pending';
      nextAt = nowMs + (BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
    }
    this.db.prepare(`
      UPDATE webhook_deliveries SET status = ?, attempt = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, attempt, nextAt, outcome.statusCode ?? null,
      outcome.error ? outcome.error.slice(0, 500) : null, now, delivery.id);
    return this.getDelivery(delivery.id)!;
  }

  /** Push a claimed delivery back to pending at a later time (no attempt consumed). */
  defer(deliveryId: string, untilMs: number): void {
    this.db.prepare("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .run(untilMs, new Date().toISOString(), deliveryId);
  }

  /** Re-arm a delivery (typically dead/failed) for immediate re-delivery. */
  replay(deliveryId: string, nowMs = Date.now()): DeliveryRow | null {
    const d = this.getDelivery(deliveryId);
    if (!d) return null;
    // A replayed delivery gets one fresh attempt budget on top of what it used.
    this.db.prepare(`
      UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, max_attempts = attempt + ?, updated_at = ?
      WHERE id = ?
    `).run(nowMs, this.getEndpoint(d.endpointId) ? this.getEndpoint(d.endpointId)!.retryMax + 1 : 1,
      new Date(nowMs).toISOString(), deliveryId);
    return this.getDelivery(deliveryId);
  }

  getDelivery(id: string): DeliveryRow | null {
    const r = this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as DeliveryDbRow | undefined;
    return r ? rowToDelivery(r) : null;
  }

  listDeliveries(opts: { endpointId?: string; status?: DeliveryStatus; limit?: number } = {}): DeliveryRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
    const conds: string[] = []; const args: unknown[] = [];
    if (opts.endpointId) { conds.push('endpoint_id = ?'); args.push(opts.endpointId); }
    if (opts.status) { conds.push('status = ?'); args.push(opts.status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM webhook_deliveries ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as DeliveryDbRow[];
    return rows.map(rowToDelivery);
  }

  listAttempts(deliveryId: string): AttemptRow[] {
    const rows = this.db.prepare('SELECT * FROM webhook_attempts WHERE delivery_id = ? ORDER BY attempt').all(deliveryId) as
      { delivery_id: string; attempt: number; at: string; ok: number; status_code: number | null; error: string | null; duration_ms: number }[];
    return rows.map((r) => ({ deliveryId: r.delivery_id, attempt: r.attempt, at: r.at, ok: r.ok, statusCode: r.status_code, error: r.error, durationMs: r.duration_ms }));
  }

  /** Drop events + settled deliveries older than the retention window. */
  prune(nowMs = Date.now()): void {
    const cutoffMs = nowMs - RETENTION_MS;
    const cutoffIso = new Date(cutoffMs).toISOString();
    this.db.prepare('DELETE FROM events WHERE created_at_ms < ?').run(cutoffMs);
    this.db.prepare(`
      DELETE FROM webhook_attempts WHERE delivery_id IN
        (SELECT id FROM webhook_deliveries WHERE status IN ('succeeded','dead') AND updated_at < ?)
    `).run(cutoffIso);
    this.db.prepare("DELETE FROM webhook_deliveries WHERE status IN ('succeeded','dead') AND updated_at < ?").run(cutoffIso);
  }

  /** Aggregate counters for the dashboard. */
  stats(): { events: number; endpoints: number; deliveries: Record<string, number> } {
    const events = (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    const endpoints = (this.db.prepare('SELECT COUNT(*) AS n FROM webhook_endpoints').get() as { n: number }).n;
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status').all() as { status: string; n: number }[];
    const deliveries: Record<string, number> = {};
    for (const r of rows) deliveries[r.status] = r.n;
    return { events, endpoints, deliveries };
  }

  close(): void { this.db.close(); }
}

function clampRetry(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 5;
  return Math.min(10, Math.max(0, Math.floor(v)));
}

let _store: EventStore | null = null;

/** Process-wide store at data/events/events.db (honours the DATA_DIR seam). */
export function getEventStore(): EventStore {
  if (!_store) _store = new EventStore(dataPath('events', 'events.db'));
  return _store;
}

export function __setEventStoreForTests(s: EventStore | null): void { _store = s; }
