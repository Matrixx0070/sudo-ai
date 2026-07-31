/**
 * @file worker.ts
 * @description Webhook delivery worker — drains the SQLite delivery queue.
 *
 * Every tick (SUDO_EVENTS_TICK_MS, default 3000): claim due deliveries, POST
 * each signed payload (concurrently, capped), record the attempt, and let the
 * store schedule the exponential-backoff retry or move the row to the DLQ.
 *
 * Egress is SSRF-guarded via toolFetch — an endpoint URL resolving to a
 * private address is refused like any other tool fetch. Per-request timeout
 * 10s. $0 cost: no model calls, so no token budget applies (CLAUDE.md
 * invariant 10); the only budget is the concurrency cap + timeout.
 */

import { createLogger } from '../shared/logger.js';
import { toolFetch } from '../security/guarded-fetch.js';
import { signEvent } from './signing.js';
import { getEventStore, type DeliveryRow, type EventStore } from './store.js';
import type { PlatformEvent } from './types.js';

const log = createLogger('events:worker');

const REQUEST_TIMEOUT_MS = 10_000;
const CLAIM_BATCH = 10;
const PRUNE_EVERY_TICKS = 1200; // ~1h at the default tick

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DeliveryWorkerOptions {
  store?: EventStore;
  fetchImpl?: FetchLike;
  tickMs?: number;
}

/** The JSON body POSTed to endpoints (the public webhook payload shape). */
export function webhookBody(evt: PlatformEvent): string {
  return JSON.stringify({
    id: evt.id,
    type: evt.type,
    version: evt.version,
    created_at: evt.createdAt,
    data: evt.data,
  });
}

export class DeliveryWorker {
  private readonly store: EventStore;
  private readonly fetchImpl: FetchLike;
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickCount = 0;

  constructor(opts: DeliveryWorkerOptions = {}) {
    this.store = opts.store ?? getEventStore();
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => toolFetch(url, init));
    this.tickMs = opts.tickMs ?? Number(process.env['SUDO_EVENTS_TICK_MS'] ?? '3000');
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref();
    log.info({ tickMs: this.tickMs }, 'webhook delivery worker started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One drain pass. Public so tests (and the /test API) can drive it directly. */
  async tick(nowMs = Date.now()): Promise<number> {
    if (this.ticking) return 0; // a slow batch must not overlap the next tick
    this.ticking = true;
    try {
      this.tickCount += 1;
      if (this.tickCount % PRUNE_EVERY_TICKS === 0) {
        try { this.store.prune(nowMs); } catch (err) { log.warn({ err: String(err) }, 'prune failed'); }
      }
      const due = this.store.claimDue(nowMs, CLAIM_BATCH);
      if (due.length === 0) return 0;
      await Promise.all(due.map((d) => this.deliver(d, nowMs)));
      return due.length;
    } finally {
      this.ticking = false;
    }
  }

  private async deliver(delivery: DeliveryRow, nowMs: number): Promise<void> {
    const endpoint = this.store.getEndpoint(delivery.endpointId);
    const event = this.store.getEvent(delivery.eventId);
    if (!endpoint || !event) {
      // Orphaned row (endpoint deleted mid-flight / pruned event) — dead-end it.
      this.store.recordAttempt({ ...delivery, maxAttempts: delivery.attempt + 1 },
        { ok: false, error: !endpoint ? 'endpoint deleted' : 'event missing', durationMs: 0 }, nowMs);
      return;
    }
    if (!endpoint.enabled) {
      // Disabled endpoints don't consume attempts; re-check in a minute.
      this.store.defer(delivery.id, nowMs + 60_000);
      return;
    }

    const body = webhookBody(event);
    const tsS = Math.floor(nowMs / 1000);
    const signature = signEvent(this.store.signingSecrets(endpoint, nowMs), tsS, body);

    const started = Date.now();
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'sudo-ai-webhooks/1',
          'X-Sudo-Event': event.type,
          'X-Sudo-Event-Id': event.id,
          'X-Sudo-Delivery': delivery.id,
          'X-Sudo-Idempotency-Key': event.idempotencyKey,
          'X-Sudo-Timestamp': String(tsS),
          'X-Sudo-Signature': signature,
        },
        body,
        signal: ctl.signal,
        redirect: 'error', // a redirect could re-target the signed POST — refuse
      });
      // Drain/discard the response body so sockets are reusable.
      try { await res.arrayBuffer(); } catch { /* body errors don't change the verdict */ }
      const ok = res.status >= 200 && res.status < 300;
      const updated = this.store.recordAttempt(delivery,
        { ok, statusCode: res.status, ...(ok ? {} : { error: `HTTP ${res.status}` }), durationMs: Date.now() - started }, nowMs);
      log.info({ deliveryId: delivery.id, endpointId: endpoint.id, type: event.type, status: res.status, state: updated.status }, 'webhook delivery attempt');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const updated = this.store.recordAttempt(delivery,
        { ok: false, error: msg, durationMs: Date.now() - started }, nowMs);
      log.warn({ deliveryId: delivery.id, endpointId: endpoint.id, err: msg, state: updated.status }, 'webhook delivery failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}
