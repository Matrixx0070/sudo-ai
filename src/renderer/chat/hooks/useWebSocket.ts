import { useState, useEffect, useCallback, useRef } from 'react';
import { getChatPeerId } from '../peer';

type ChatWSOptions = {
  token?: string;
  peerId?: string;
};

export type ChatWSMedia = {
  type: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
  filename: string;
  dataBase64: string;
};

type ChatWSMessage =
  | { type: 'thinking'; text?: string }
  | { type: 'progress'; text: string; progress?: number }
  // BO11/S13: live working-state — phase + server elapsed baseline + always-visible
  // model/context chip. The client ticks the seconds locally from `elapsedSec`.
  | { type: 'phase'; phase: 'waiting' | 'running' | 'streaming'; elapsedSec: number; label: string; chip?: string }
  | { type: 'token'; text: string }
  | { type: 'user_echo'; text: string }
  | { type: 'reply'; content: string; text?: string; media?: ChatWSMedia[] }
  | { type: 'canvas'; version: number; title?: string; components: Record<string, unknown>[] }
  | { type: 'error'; error: string };

type UseWebSocketOptions = {
  onMessage: (data: ChatWSMessage) => void;
  onDisconnect?: () => void;
};

const RECONNECT_DELAY_MS = 3000;

export function useWebSocket(options: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set during cleanup so the deferred onclose event doesn't schedule a
  // reconnect (and reopen a socket) on an already-unmounted component.
  const closingRef = useRef(false);

  // Use refs for callbacks so connect() never changes identity — prevents
  // infinite reconnect loops when parent passes new inline functions each render.
  const onMessageRef = useRef(options.onMessage);
  const onDisconnectRef = useRef(options.onDisconnect);
  useEffect(() => {
    onMessageRef.current = options.onMessage;
    onDisconnectRef.current = options.onDisconnect;
  }, [options.onMessage, options.onDisconnect]);

  const connect = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || undefined;
    // Stable peer id (localStorage) so reconnects/reloads resume the same server session.
    const peerId = getChatPeerId();

    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/chat/ws`;
    const qp = new URLSearchParams();
    if (token) qp.set('token', token);
    if (peerId) qp.set('peer', peerId);
    const qs = qp.toString();
    const fullUrl = qs ? `${wsUrl}?${qs}` : wsUrl;

    const ws = new WebSocket(fullUrl);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      if (closingRef.current) return;
      setConnected(false);
      onDisconnectRef.current?.();
      reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as ChatWSMessage;
        onMessageRef.current(data);
      } catch {
        // Non-JSON fallback — treat as reply
        onMessageRef.current({ type: 'reply', content: e.data });
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(text);
    }
  }, []);

  // Upload a file by reading it as base64 and sending an attachment envelope.
  // The server decodes it, saves it under data/uploads/, and dispatches it to
  // the agent with a vision hint (mirrors the Telegram photo/document path).
  const sendAttachment = useCallback((file: File, caption: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // readAsDataURL → "data:<mime>;base64,<payload>"; keep only the payload.
        const result = String(reader.result);
        const comma = result.indexOf(',');
        const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result;
        try {
          ws.send(JSON.stringify({
            type: '__attachment',
            name: file.name,
            mime: file.type || 'application/octet-stream',
            dataBase64,
            caption,
          }));
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  useEffect(() => {
    closingRef.current = false;
    connect();
    return () => {
      closingRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { connected, sendMessage, sendAttachment };
}
