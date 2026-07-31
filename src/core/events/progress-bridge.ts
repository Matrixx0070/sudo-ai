/**
 * @file progress-bridge.ts
 * @description Instrumentation seam: mirrors the existing session-scoped
 * ProgressBroadcaster (gateway/progress.ts) onto the unified event bus, so
 * session/message/tool lifecycle events flow to webhooks + WS without touching
 * the agent loop (invariant 3 — no hot-path changes; the broadcaster already
 * absorbs listener cost).
 *
 * Mapping (progress type → bus event):
 *   start        → session.started (persistent) + session.status (ephemeral)
 *   thinking     → agent.thinking            (ephemeral)
 *   streaming    → session.output.delta      (ephemeral)
 *   tool_call    → tool.started              (persistent)
 *   tool_result  → tool.completed / tool.failed (persistent)
 *   complete     → message.completed (persistent) + session.output.completed
 *   error        → message.failed (persistent) + session.error (ephemeral)
 */

import { progress, WILDCARD_SESSION, type ProgressEvent } from '../gateway/progress.js';
import { eventBus, type EventBus } from './bus.js';

function channelsFor(e: ProgressEvent): string[] {
  return [`session:${e.sessionId}`];
}

function base(e: ProgressEvent): Record<string, unknown> {
  return {
    session_id: e.sessionId,
    ...(e.provider ? { provider: e.provider } : {}),
    ...(e.tool ? { tool: e.tool } : {}),
    ...(e.elapsedMs !== undefined ? { elapsed_ms: e.elapsedMs } : {}),
    ...(e.tokensGenerated !== undefined ? { tokens: e.tokensGenerated } : {}),
  };
}

/** Attach the bridge. Returns the unsubscribe function. */
export function initProgressBridge(bus: EventBus = eventBus): () => void {
  return progress.subscribe(WILDCARD_SESSION, (e) => {
    const channels = channelsFor(e);
    const data = base(e);
    switch (e.type) {
      case 'start':
        bus.publish('session.status', { ...data, status: 'started' }, { channels });
        break;
      case 'thinking':
        bus.publish('agent.thinking', data, { channels });
        break;
      case 'streaming':
        bus.publish('session.output.delta', data, { channels });
        break;
      case 'complete':
        bus.publish('session.output.completed', data, { channels });
        break;
      case 'error':
        bus.publish('session.error', { ...data, error: e.message }, { channels });
        break;
      default:
        break; // tool_call/tool_result: persistent lifecycle — hook-bridge owns them
    }
  });
}
