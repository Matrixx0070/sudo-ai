/**
 * @file hook-bridge.ts
 * @description Primary instrumentation seam: mirrors the colon-style
 * HookManager (core/hooks/index.ts) — the spine the AgentLoop actually emits
 * into on EVERY prod turn path (web, Telegram, cron, WS) — onto the unified
 * event bus. Live-proven gap this closes: a real web-chat turn produced zero
 * bus events because the ProgressBroadcaster (the old seam) never fires on
 * the channel turn path; `session:start/end`, `after:tool-call`, `on:message`
 * and `on:error` do (same subscription pattern as the SSE broker).
 *
 * Ownership split: this bridge owns ALL persistent lifecycle events
 * (session.*, message.*, tool.*); progress-bridge.ts owns only ephemeral
 * realtime frames. One owner per event type — no duplicate deliveries.
 *
 * Privacy: message TEXT never rides in bus events — only metadata (channel,
 * length). Webhook payloads leave the machine; the transcript should not.
 */

import type { HookContext, HookManager } from '../hooks/index.js';
import { createLogger } from '../shared/logger.js';
import { eventBus, type EventBus } from './bus.js';

const log = createLogger('events:hook-bridge');

function channels(ctx: HookContext): string[] {
  return ctx.sessionId ? [`session:${ctx.sessionId}`] : [];
}

/** Attach the bridge. Returns an unregister function. */
export function initHookBridge(hooks: HookManager, bus: EventBus = eventBus): () => void {
  const ids: string[] = [];
  const on = (event: Parameters<HookManager['register']>[0], handler: (ctx: HookContext) => void): void => {
    ids.push(hooks.register(event, async (ctx) => { handler(ctx); }, `events-bridge:${event}`));
  };

  on('session:start', (ctx) => {
    bus.publish('session.started', {
      session_id: ctx.sessionId,
      ...(ctx.channel ? { channel: ctx.channel } : {}),
    }, { channels: channels(ctx) });
  });

  on('session:end', (ctx) => {
    const meta = ctx as HookContext & { messageCount?: number };
    // A turn finishing means the assistant produced its reply and the session
    // went idle — both facts are events consumers care about.
    bus.publish('message.completed', {
      session_id: ctx.sessionId,
      ...(typeof meta.messageCount === 'number' ? { message_count: meta.messageCount } : {}),
    }, { channels: channels(ctx) });
    bus.publish('session.idled', { session_id: ctx.sessionId }, { channels: channels(ctx) });
  });

  on('on:message', (ctx) => {
    bus.publish('message.created', {
      session_id: ctx.sessionId,
      ...(ctx.channel ? { channel: ctx.channel } : {}),
      // Metadata only — message text never leaves via the event lane.
      ...(typeof ctx.message === 'string' ? { length: ctx.message.length } : {}),
    }, { channels: channels(ctx) });
  });

  on('before:tool-call', (ctx) => {
    bus.publish('tool.started', {
      session_id: ctx.sessionId,
      tool: ctx.toolName,
    }, { channels: channels(ctx) });
  });

  on('after:tool-call', (ctx) => {
    const ok = (ctx as HookContext & { success?: boolean }).success !== false;
    bus.publish(ok ? 'tool.completed' : 'tool.failed', {
      session_id: ctx.sessionId,
      tool: ctx.toolName,
    }, { channels: channels(ctx) });
  });

  on('on:error', (ctx) => {
    bus.publish('message.failed', {
      session_id: ctx.sessionId,
      error: ctx.error instanceof Error ? ctx.error.message.slice(0, 300) : String(ctx.error ?? 'unknown').slice(0, 300),
    }, { channels: channels(ctx) });
  });

  on('on:file-write', (ctx) => {
    bus.publish('file.uploaded', {
      session_id: ctx.sessionId,
      path: ctx.filePath,
    }, { channels: channels(ctx) });
  });

  log.info({ hooks: ids.length }, 'event hook-bridge attached to HookManager');
  return () => {
    for (const id of ids) {
      try { hooks.unregister(id); } catch { /* already gone */ }
    }
  };
}
