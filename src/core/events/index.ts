/**
 * @file index.ts
 * @description Boot wiring for the unified event system (bus → webhook worker
 * + WS fan-out + REST/dashboard). One call from cli.ts after the gateway and
 * WS server are up. Gated by SUDO_EVENTS (default ON — the subsystem is inert
 * and $0 until an endpoint is registered or a WS client subscribes;
 * SUDO_EVENTS=0 disables everything including the API routes).
 */

import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';
import { createLogger } from '../shared/logger.js';
import { registerEventsApi } from './api.js';
import { eventBus } from './bus.js';
import { initProgressBridge } from './progress-bridge.js';
import { getEventStore } from './store.js';
import { DeliveryWorker } from './worker.js';
import { initWsBridge } from './ws-bridge.js';

const log = createLogger('events');

export { eventBus } from './bus.js';
export type { PlatformEvent } from './types.js';

export function eventsEnabled(): boolean {
  return process.env['SUDO_EVENTS'] !== '0';
}

export interface EventSystemHandle {
  stop: () => void;
}

/** Wire the whole event system onto a running gateway. Call once at boot. */
export function initEventSystem(opts: { httpServer: HttpServer; wss?: WebSocketServer }): EventSystemHandle | null {
  if (!eventsEnabled()) {
    log.info('event system disabled (SUDO_EVENTS=0)');
    return null;
  }
  const store = getEventStore();
  const worker = new DeliveryWorker({ store });
  worker.start();

  registerEventsApi(opts.httpServer, { store, worker });
  const stopProgress = initProgressBridge(eventBus);
  const stopWs = opts.wss ? initWsBridge(opts.wss, eventBus) : null;

  log.info('event system attached (bus + webhook worker + WS fan-out + REST/dashboard)');
  return {
    stop: () => {
      worker.stop();
      stopProgress();
      stopWs?.();
    },
  };
}
