import { useState, useEffect, useCallback, useRef } from 'react';

type ChatWSOptions = {
  token?: string;
  peerId?: string;
};

type ChatWSMessage =
  | { type: 'thinking'; text?: string }
  | { type: 'progress'; text: string; progress?: number }
  | { type: 'user_echo'; text: string }
  | { type: 'reply'; content: string; text?: string }
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
    const peerId = params.get('peer') || undefined;

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

  return { connected, sendMessage };
}
