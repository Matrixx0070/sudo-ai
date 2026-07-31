/**
 * @file types.ts
 * @description Envelope + id helpers for the unified event bus. Pure types and
 * tiny id generators — safe to import from anywhere (no runtime deps beyond
 * node:crypto).
 */

import { randomUUID } from 'node:crypto';

/** The envelope every published event travels in (bus, WS push, webhook body). */
export interface PlatformEvent {
  /** Globally unique event id (`evt_…`), time-sortable. */
  id: string;
  /** Catalog event type, e.g. `message.completed`. */
  type: string;
  /** Schema version of `data` for this type (from the catalog). */
  version: number;
  /** ISO-8601 creation time. */
  createdAt: string;
  /**
   * Consumer-side dedupe key. Defaults to the event id; publishers may pass a
   * deterministic key so retried publishes collapse to one delivery.
   */
  idempotencyKey: string;
  /**
   * Realtime routing channels, e.g. `session:<id>`, `user:<id>`, `agent:<id>`,
   * `org:<id>`. Empty = broadcast-only (matched by `*` subscribers).
   */
  channels: string[];
  /** Type-specific payload. */
  data: Record<string, unknown>;
}

function tsPart(): string {
  return Date.now().toString(36);
}

function randPart(n: number): string {
  return randomUUID().replace(/-/g, '').slice(0, n);
}

/** New event id: `evt_<ts36><rand>` — unique and roughly time-ordered. */
export function newEventId(): string {
  return `evt_${tsPart()}${randPart(14)}`;
}

/** New webhook-endpoint id. */
export function newEndpointId(): string {
  return `whep_${tsPart()}${randPart(12)}`;
}

/** New delivery id. */
export function newDeliveryId(): string {
  return `whdel_${tsPart()}${randPart(14)}`;
}
