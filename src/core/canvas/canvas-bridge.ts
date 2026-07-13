/**
 * @file canvas-bridge.ts
 * @description Wiring seam for Generative UI / A2UI (Spec 2), mirroring the
 * message-router singleton pattern. Boot registers a bridge that knows how to
 * (a) resolve a sessionId → its web peer, (b) push a frame to that peer's
 * socket, (c) resolve an inbound peer → session and inject a typed event, and
 * (d) persist the latest tree. The `canvas.render` tool and the
 * `/v1/canvas/event` route both reach the live wiring through this seam without
 * threading the session manager / steering channel / outbox through their call
 * sites.
 */

import { createLogger } from '../shared/logger.js';
import type { CanvasPayload } from './schema.js';

const log = createLogger('canvas:bridge');

/** WS frame the SPA switches on (`data.type === 'canvas'`). */
export interface CanvasFrame {
  type: 'canvas';
  version: number;
  title?: string;
  components: CanvasPayload['components'];
}

/** Build the client frame from a validated payload. */
export function buildCanvasFrame(payload: CanvasPayload): CanvasFrame {
  return { type: 'canvas', version: payload.version, ...(payload.title ? { title: payload.title } : {}), components: payload.components };
}

/** A click/submit coming back from the client. */
export interface CanvasEvent {
  /** 'button' | 'form' — what produced it. */
  kind: 'button' | 'form';
  /** The actionId (button.actionId or form.submitActionId) the agent chose. */
  actionId: string;
  /** Form field values, when kind === 'form'. */
  values?: Record<string, string | number | boolean>;
}

export interface CanvasBridgeDeps {
  /** sessionId → { channel, peerId } or null if unknown. */
  resolveSessionPeer: (sessionId: string) => Promise<{ channel: string; peerId: string } | null>;
  /** peerId → sessionId (get-or-create the web session). */
  resolveWebSession: (peerId: string) => Promise<string>;
  /** Push a serialized frame to a channel peer (channel-outbox). */
  push: (channel: string, peerId: string, frameJson: string) => void;
  /** Inject a typed event into the session (steering channel). */
  inject: (sessionId: string, payload: string) => void;
  /** Persist the latest payload for a session (reconnect replay / audit). */
  persist?: (sessionId: string, payload: CanvasPayload) => void;
  /** Recent canvases across sessions, newest first — powers the /admin panel. */
  listStates?: (limit: number) => Array<{ sessionId: string; updatedAt: string; payload: CanvasPayload }>;
}

let _deps: CanvasBridgeDeps | null = null;

export function registerCanvasBridge(deps: CanvasBridgeDeps): void {
  _deps = deps;
  log.info('canvas bridge registered');
}

export function isCanvasBridgeReady(): boolean {
  return _deps !== null;
}

export interface PushResult { ok: boolean; reason?: string }

/**
 * Render a validated payload to the session's web client. Canvas targets web
 * only (the client that can render components); other channels return a clear
 * reason so the agent can fall back to text.
 */
export async function pushCanvasToSession(sessionId: string, payload: CanvasPayload): Promise<PushResult> {
  if (!_deps) return { ok: false, reason: 'canvas bridge not wired' };
  let peer;
  try { peer = await _deps.resolveSessionPeer(sessionId); } catch (err) {
    log.warn({ sessionId, err: String(err) }, 'resolveSessionPeer failed');
    return { ok: false, reason: 'session lookup failed' };
  }
  if (!peer) return { ok: false, reason: 'session not found' };
  if (peer.channel !== 'web') return { ok: false, reason: `canvas renders on web only (session channel is "${peer.channel}")` };
  try {
    _deps.persist?.(sessionId, payload);
    _deps.push('web', peer.peerId, JSON.stringify(buildCanvasFrame(payload)));
    log.info({ sessionId, peerId: peer.peerId, components: payload.components.length }, 'canvas pushed to web client');
    return { ok: true };
  } catch (err) {
    log.warn({ sessionId, err: String(err) }, 'canvas push failed');
    return { ok: false, reason: 'push failed' };
  }
}

/**
 * Deliver a client canvas event into the agent session as a TYPED system event
 * (JSON-encoded, not free text). Returns the resolved sessionId on success.
 */
export async function deliverCanvasEvent(peerId: string, event: CanvasEvent): Promise<{ ok: boolean; sessionId?: string; reason?: string }> {
  if (!_deps) return { ok: false, reason: 'canvas bridge not wired' };
  try {
    const sessionId = await _deps.resolveWebSession(peerId);
    const payload = JSON.stringify({ kind: 'canvas-event', actionId: event.actionId, formKind: event.kind, values: event.values ?? {} });
    _deps.inject(sessionId, `[CANVAS EVENT] The user interacted with a rendered UI component. Structured event: ${payload}`);
    log.info({ peerId, sessionId, actionId: event.actionId }, 'canvas event injected into session');
    return { ok: true, sessionId };
  } catch (err) {
    log.warn({ peerId, err: String(err) }, 'canvas event delivery failed');
    return { ok: false, reason: 'delivery failed' };
  }
}

/**
 * Recent canvases across sessions (read-only monitoring, /admin). Returns []
 * when the bridge is unwired or the host provided no listStates capability.
 */
export function listCanvasStates(limit = 20): Array<{ sessionId: string; updatedAt: string; payload: CanvasPayload }> {
  if (!_deps?.listStates) return [];
  try { return _deps.listStates(limit); } catch (err) {
    log.warn({ err: String(err) }, 'listCanvasStates failed');
    return [];
  }
}

/** Test helper. */
export function __resetCanvasBridgeForTests(): void { _deps = null; }
