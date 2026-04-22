import { useEffect, useRef } from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import type { WSOfficeMessage } from '@renderer/components/office/types.js';

const WS_URL = 'ws://127.0.0.1:3001/ws';
const RECONNECT_DELAY_MS = 5_000;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Connects to the backend drama engine WebSocket.
 * On message, dispatches updates to the officeStore.
 * Reconnects automatically every 5 seconds if the connection drops.
 * If the initial connection fails, a warning is logged — the drama engine
 * simulation will drive state instead.
 */
export function useOfficeWebSocket(): void {
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const store = useOfficeStore.getState;

  useEffect(() => {
    unmountedRef.current = false;

    function connect(): void {
      if (unmountedRef.current) return;

      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.addEventListener('open', () => {
          console.info('[OfficeWS] Connected to', WS_URL);
        });

        ws.addEventListener('message', (event: MessageEvent) => {
          let msg: WSOfficeMessage;
          try {
            msg = JSON.parse(event.data as string) as WSOfficeMessage;
          } catch {
            console.warn('[OfficeWS] Non-JSON message ignored:', event.data);
            return;
          }
          dispatch(msg);
        });

        ws.addEventListener('error', () => {
          console.warn('[OfficeWS] Connection error — drama engine will handle simulation');
        });

        ws.addEventListener('close', () => {
          if (!unmountedRef.current) {
            console.info(`[OfficeWS] Closed — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
            timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
          }
        });
      } catch (err) {
        console.warn('[OfficeWS] Failed to create WebSocket:', err);
        if (!unmountedRef.current) {
          timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      }
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // dispatch is defined outside useEffect so it can use stable store reference
  function dispatch(msg: WSOfficeMessage): void {
    const {
      setAgentState,
      setAgentPosition,
      setAgentTarget,
      setAgentTask,
      moveAgentToRoom,
      addTask,
      updateTask,
      pushEvent,
      updateMetrics,
    } = store();

    // Always push a raw event for the feed
    if (msg.agentCode || msg.message) {
      pushEvent({
        id: generateId(),
        type: msg.type,
        timestamp: Date.now(),
        agentCode: msg.agentCode ?? null,
        targetAgentCode: msg.targetAgentCode ?? null,
        message: msg.message ?? msg.type,
        room: msg.room ?? 'lobby',
      });
    }

    switch (msg.type) {
      case 'agent-state-change':
        if (msg.agentCode && msg.state) {
          setAgentState(msg.agentCode, msg.state);
        }
        break;

      case 'agent-moved':
        if (msg.agentCode) {
          if (msg.room) {
            moveAgentToRoom(msg.agentCode, msg.room, msg.targetPosition);
          }
          if (msg.position) {
            setAgentPosition(msg.agentCode, msg.position);
          }
          if (msg.targetPosition) {
            setAgentTarget(msg.agentCode, msg.targetPosition);
          }
        }
        break;

      case 'task-assigned':
        if (msg.agentCode && msg.task) {
          setAgentTask(msg.agentCode, msg.task, msg.taskProgress ?? 0);
          setAgentState(msg.agentCode, 'working');
        }
        if (msg.taskId && msg.taskTitle) {
          addTask({
            id: msg.taskId,
            title: msg.taskTitle,
            assignedTo: msg.assignedTo ?? null,
            status: 'in-progress',
            priority: msg.priority ?? 'medium',
          });
        }
        break;

      case 'task-completed':
        if (msg.agentCode) {
          setAgentTask(msg.agentCode, null, 0);
          setAgentState(msg.agentCode, 'idle');
        }
        if (msg.taskId) {
          updateTask(msg.taskId, { status: 'done' });
        }
        break;

      case 'agent-chat':
      case 'agent-break':
        if (msg.agentCode) {
          setAgentState(msg.agentCode, msg.type === 'agent-break' ? 'break' : 'talking');
        }
        break;

      case 'agent-error':
        if (msg.agentCode) {
          setAgentState(msg.agentCode, 'error');
        }
        break;

      case 'system-alert':
        if (
          msg.cpu !== undefined ||
          msg.memory !== undefined ||
          msg.disk !== undefined ||
          msg.uptime !== undefined
        ) {
          updateMetrics({
            cpu: msg.cpu,
            memory: msg.memory,
            disk: msg.disk,
            uptime: msg.uptime,
          });
        }
        break;

      case 'meeting-started':
      case 'meeting-ended':
        // Handled by drama engine; event already pushed above
        break;

      default:
        break;
    }
  }
}
