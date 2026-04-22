/**
 * Type-safe IPC client that wraps window.sudo.
 * Falls back to WebSocket when running in Electron without IPC preload.
 */

export type SendChannel = 'agent:send-message';

export type InvokeChannel =
  | 'agent:send-message'
  | 'settings:get'
  | 'settings:set'
  | 'cron:list'
  | 'cron:create'
  | 'cron:delete'
  | 'skills:list'
  | 'system:metrics'
  | 'pipeline:status';

export type ListenChannel =
  | 'agent:stream-chunk'
  | 'agent:state-changed'
  | 'pipeline:status'
  | 'system:metrics';

declare global {
  interface Window {
    sudo?: {
      send: (channel: string, data: unknown) => void;
      invoke: (channel: string, data?: unknown) => Promise<unknown>;
      on: (channel: string, callback: (...args: unknown[]) => void) => void;
      removeAllListeners: (channel: string) => void;
    };
  }
}

function isAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.sudo !== 'undefined';
}

/** Fire-and-forget message to main process. */
export function ipcSend(channel: SendChannel, data: unknown): void {
  if (!isAvailable()) return;
  window.sudo!.send(channel, data);
}

// ---------------------------------------------------------------------------
// Persistent WebSocket — shared connection with fixed ?peer= from URL
// ---------------------------------------------------------------------------

let _persistentWs: WebSocket | null = null;
let _pendingResolve: ((v: string) => void) | null = null;
let _pendingReject: ((e: Error) => void) | null = null;
let _pendingTimeout: ReturnType<typeof setTimeout> | null = null;

function getWsUrl(): string {
  const wsHost =
    window.location.protocol === 'file:' ? '127.0.0.1:3001' : window.location.host;
  const params = new URLSearchParams(window.location.search);
  const tok = params.get('token');
  const peer = params.get('peer');
  const qs = new URLSearchParams();
  if (tok) qs.set('token', tok);
  if (peer) qs.set('peer', peer);
  const q = qs.toString();
  return `ws://${wsHost}/ws${q ? `?${q}` : ''}`;
}

function getPersistentWs(): WebSocket {
  if (_persistentWs && _persistentWs.readyState === WebSocket.OPEN) {
    return _persistentWs;
  }
  const ws = new WebSocket(getWsUrl());
  _persistentWs = ws;

  ws.onmessage = (e) => {
    const data = e.data as string;
    try {
      const parsed = JSON.parse(data) as { type: string; text?: string };
      // user_echo: message injected from API — dispatch as incoming user bubble
      if (parsed.type === 'user_echo') {
        window.dispatchEvent(new CustomEvent('sudo:user-echo', { detail: parsed }));
        return;
      }
      if (parsed.type === 'thinking' || parsed.type === 'progress') {
        window.dispatchEvent(new CustomEvent('sudo:status', { detail: parsed }));
        return;
      }
    } catch { /* not JSON */ }
    // Final reply — either resolves a pending send, or dispatched as a server push
    if (_pendingTimeout) clearTimeout(_pendingTimeout);
    const resolve = _pendingResolve;
    _pendingResolve = null;
    _pendingReject = null;
    _pendingTimeout = null;
    if (resolve) {
      resolve(data);
    } else {
      // Server-pushed message (e.g. from POST /api/message) — dispatch to UI
      window.dispatchEvent(new CustomEvent('sudo:push', { detail: data }));
    }
  };

  ws.onerror = () => {
    if (_pendingTimeout) clearTimeout(_pendingTimeout);
    const reject = _pendingReject;
    _pendingResolve = null;
    _pendingReject = null;
    _pendingTimeout = null;
    reject?.(new Error('WebSocket error'));
    _persistentWs = null;
  };

  ws.onclose = () => {
    _persistentWs = null;
  };

  return ws;
}

// Eagerly connect on module load so server-pushed messages arrive even before
// the user types anything. Only connects when running in a browser context.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('peer')) {
  // Small delay to let React render first
  setTimeout(() => { try { getPersistentWs(); } catch { /* ignore */ } }, 500);
}

function sendViaWebSocket(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = getPersistentWs();
    _pendingResolve = resolve;
    _pendingReject = reject;

    _pendingTimeout = setTimeout(() => {
      _pendingResolve = null;
      _pendingReject = null;
      _pendingTimeout = null;
      reject(new Error('WebSocket timeout — no reply in 1800s'));
    }, 1_800_000);

    const send = () => ws.send(message);
    if (ws.readyState === WebSocket.OPEN) {
      send();
    } else {
      ws.addEventListener('open', send, { once: true });
    }
  });
}

/** Request/response to main process. Falls back to WebSocket when IPC unavailable. */
export async function ipcInvoke<T = unknown>(
  channel: InvokeChannel,
  data?: unknown
): Promise<T | null> {
  // Try Electron IPC first
  if (isAvailable()) {
    return window.sudo!.invoke(channel, data) as Promise<T>;
  }

  // Fallback: WebSocket for agent messages
  if (channel === 'agent:send-message' && data && typeof data === 'object') {
    const msg = (data as Record<string, unknown>)['message'] as string;
    if (msg) {
      try {
        const reply = await sendViaWebSocket(msg);
        return { success: true, response: reply } as unknown as T;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: errMsg } as unknown as T;
      }
    }
  }

  return null;
}

/** Subscribe to push events from main process. Returns an unsubscribe function. */
export function ipcOn(
  channel: ListenChannel,
  callback: (...args: unknown[]) => void
): () => void {
  if (!isAvailable()) return () => {};
  window.sudo!.on(channel, callback);
  return () => {
    window.sudo?.removeAllListeners(channel);
  };
}
