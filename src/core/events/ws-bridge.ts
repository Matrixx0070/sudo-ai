/**
 * @file ws-bridge.ts
 * @description Realtime fan-out: bridges the event bus onto the existing
 * WebSocket JSON-RPC server. Clients (already authenticated at upgrade) call:
 *
 *   events.subscribe   { channels?: string[], types?: string[] }  → { ok, channels, types }
 *   events.unsubscribe {}                                          → { ok }
 *   events.presence    {}                                          → { channels: {name: count} }
 *
 * Channels are rooms: `*` (broadcast), `session:<id>`, `user:<id>`,
 * `agent:<id>`, `org:<id>`. `types` filters by event type (exact / `prefix.*`;
 * default all). Matching events are pushed as RpcEvent frames
 * `{type:'event', event:<type>, data:<envelope>, seq}` with a per-connection
 * monotonic seq (rpc-types ordering contract — gaps mean the client must
 * refresh; events are also queryable via GET /v1/events for catch-up).
 */

import type { WebSocket, WebSocketServer } from 'ws';
import { createLogger } from '../shared/logger.js';
import { registerConnectionMethod } from '../gateway/ws-server.js';
import { eventBus, type EventBus } from './bus.js';
import { matchesSubscription } from './catalog.js';
import type { PlatformEvent } from './types.js';

const log = createLogger('events:ws-bridge');

const MAX_CHANNELS_PER_CONN = 64;
const CHANNEL_RE = /^(\*|(session|user|agent|org|thread|deployment):[A-Za-z0-9._:-]{1,128})$/;

interface Subscription {
  channels: Set<string>;
  types: string[];
  seq: number;
}

const subs = new Map<WebSocket, Subscription>();

function parseStringArray(params: unknown, key: string): string[] {
  if (!params || typeof params !== 'object') return [];
  const v = (params as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256);
}

function shouldPush(sub: Subscription, evt: PlatformEvent): boolean {
  if (sub.types.length > 0 && !matchesSubscription(evt.type, sub.types)) return false;
  if (sub.channels.has('*')) return true;
  return evt.channels.some((c) => sub.channels.has(c));
}

/** Wire the bridge: register RPC methods + bus subscription. Idempotent-ish (call once at boot). */
export function initWsBridge(wss: WebSocketServer, bus: EventBus = eventBus): () => void {
  registerConnectionMethod('events.subscribe', async (ws, clientId, params) => {
    const channels = parseStringArray(params, 'channels');
    const types = parseStringArray(params, 'types');
    const bad = channels.find((c) => !CHANNEL_RE.test(c));
    if (bad) return { error: `invalid channel "${bad}" — use *, session:<id>, user:<id>, agent:<id>, org:<id>` };
    const chanSet = new Set(channels.length ? channels : ['*']);
    if (chanSet.size > MAX_CHANNELS_PER_CONN) return { error: `too many channels (max ${MAX_CHANNELS_PER_CONN})` };

    const existing = subs.get(ws);
    const sub: Subscription = { channels: chanSet, types, seq: existing?.seq ?? 0 };
    if (!existing) ws.on('close', () => { subs.delete(ws); });
    subs.set(ws, sub);
    log.info({ clientId, channels: [...chanSet], types }, 'events.subscribe');
    return { ok: true, channels: [...chanSet], types };
  });

  registerConnectionMethod('events.unsubscribe', async (ws, clientId) => {
    const had = subs.delete(ws);
    log.info({ clientId, had }, 'events.unsubscribe');
    return { ok: true };
  });

  registerConnectionMethod('events.presence', async () => {
    const channels: Record<string, number> = {};
    for (const sub of subs.values()) {
      for (const c of sub.channels) channels[c] = (channels[c] ?? 0) + 1;
    }
    return { connections: subs.size, channels };
  });

  const unsub = bus.subscribe((evt) => {
    if (subs.size === 0) return;
    for (const [ws, sub] of subs) {
      if (ws.readyState !== ws.OPEN) continue;
      if (!shouldPush(sub, evt)) continue;
      sub.seq += 1;
      try {
        ws.send(JSON.stringify({ type: 'event', event: evt.type, data: evt, seq: sub.seq }));
      } catch (err) {
        log.warn({ err: String(err) }, 'event push failed — client likely gone');
      }
    }
  });

  log.info('WS event bridge attached (events.subscribe / events.unsubscribe / events.presence)');
  return () => { unsub(); for (const ws of subs.keys()) subs.delete(ws); void wss; };
}

/** Test hook: current subscription count. */
export function __wsBridgeSubscriptions(): number { return subs.size; }
