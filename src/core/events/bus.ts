/**
 * @file bus.ts
 * @description The unified in-process event bus. Every platform event is
 * published ONCE here; the bus then:
 *
 *   1. persists it to the event log + fans it into the webhook delivery queue
 *      (persistent catalog types only — ephemeral stream frames skip storage),
 *   2. hands it to every in-process subscriber (the WS bridge, telemetry, …).
 *
 * publish() NEVER throws and NEVER blocks the caller on I/O beyond two local
 * SQLite writes (sub-ms): webhook HTTP delivery happens in the worker, WS
 * pushes happen on the next tick. Hot paths (agent loop, retrieval) stay free
 * of network waits — invariant 3.
 */

import { createLogger } from '../shared/logger.js';
import { EVENT_CATALOG } from './catalog.js';
import { getEventStore, type EventStore } from './store.js';
import { newEventId, type PlatformEvent } from './types.js';

const log = createLogger('events:bus');

export type BusSubscriber = (evt: PlatformEvent) => void;

export interface PublishOptions {
  /** Routing channels (`session:<id>`, `user:<id>`, `agent:<id>`, `org:<id>`). */
  channels?: string[];
  /** Deterministic dedupe key; defaults to the fresh event id. */
  idempotencyKey?: string;
}

export class EventBus {
  private readonly subscribers = new Set<BusSubscriber>();
  private storeRef: EventStore | null = null;

  /** Inject a store (tests); null → lazy default store. */
  setStore(store: EventStore | null): void { this.storeRef = store; }

  private store(): EventStore { return this.storeRef ?? getEventStore(); }

  /** Subscribe to every published event. Returns an unsubscribe function. */
  subscribe(fn: BusSubscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  /**
   * Publish an event. Unknown types are accepted (versioned 1, treated as
   * persistent) so new subsystems can emit before the catalog catches up —
   * but logged once so the catalog gap is visible.
   */
  publish(type: string, data: Record<string, unknown>, opts: PublishOptions = {}): PlatformEvent {
    const spec = EVENT_CATALOG[type];
    if (!spec && !warnedUnknown.has(type)) {
      warnedUnknown.add(type);
      log.warn({ type }, 'event type not in catalog — treated as persistent v1 (add it to catalog.ts)');
    }
    const evt: PlatformEvent = {
      id: newEventId(),
      type,
      version: spec?.version ?? 1,
      createdAt: new Date().toISOString(),
      idempotencyKey: opts.idempotencyKey ?? '',
      channels: opts.channels ?? [],
      data,
    };
    if (!evt.idempotencyKey) evt.idempotencyKey = evt.id;

    if (spec?.persistent !== false) {
      try {
        this.store().insertEvent(evt);
        const n = this.store().enqueueForEvent(evt);
        if (n > 0) log.debug({ id: evt.id, type, enqueued: n }, 'event fanned out to webhook queue');
      } catch (err) {
        log.error({ type, err: String(err) }, 'event persist/enqueue failed — realtime fan-out continues');
      }
    }

    // Realtime fan-out on the next tick: publisher never pays subscriber cost.
    setImmediate(() => {
      for (const fn of this.subscribers) {
        try { fn(evt); } catch (err) { log.warn({ type, err: String(err) }, 'bus subscriber threw — ignored'); }
      }
    });
    return evt;
  }

  subscriberCount(): number { return this.subscribers.size; }
}

const warnedUnknown = new Set<string>();

/** Application-wide singleton bus. */
export const eventBus = new EventBus();
