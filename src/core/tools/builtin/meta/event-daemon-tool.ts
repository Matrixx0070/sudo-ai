/**
 * @file event-daemon-tool.ts
 * @description meta.event-daemon — SUDO-AI tool for the Persistent Event Daemon.
 *
 * Actions:
 *   status         — is the daemon running? uptime and config
 *   recent-events  — last N events (default 20)
 *   unhandled      — all events not yet actioned, sorted by priority
 *   stats          — total counts by type and handled/unhandled split
 *   emit-event     — manually fire a custom event into the daemon
 *
 * The daemon singleton is started lazily on first tool call and persists
 * for the process lifetime. Events are stored in mind.db.
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { EventDaemon } from '../../../daemon/event-daemon.js';
import type { EventPriority } from '../../../daemon/event-daemon.js';

const logger = createLogger('meta.event-daemon');
const DB_PATH = path.resolve('data/mind.db');

// ---------------------------------------------------------------------------
// Singleton daemon — one instance per process
// ---------------------------------------------------------------------------

let _daemon: EventDaemon | null = null;
let _startedAt: string | null = null;
const DEFAULT_POLL_MS = 60_000;

function getDaemon(): EventDaemon {
  if (!_daemon) {
    _daemon = new EventDaemon(DB_PATH);
    logger.info('Event daemon singleton created (not yet started)');
  }
  return _daemon;
}

function ensureStarted(): EventDaemon {
  const d = getDaemon();
  if (!d.isRunning()) {
    d.start(DEFAULT_POLL_MS);
    _startedAt = new Date().toISOString();
    logger.info({ startedAt: _startedAt }, 'Event daemon auto-started by tool call');
  }
  return d;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const PRIORITY_ICON: Record<string, string> = {
  critical: '[CRITICAL]',
  high:     '[HIGH]',
  medium:   '[MEDIUM]',
  low:      '[LOW]',
};

function formatEvent(e: ReturnType<EventDaemon['getRecentEvents']>[number]): string {
  const icon = PRIORITY_ICON[e.priority] ?? '[?]';
  const handled = e.handled ? `handled: ${e.handler ?? 'yes'}` : 'unhandled';
  return `${icon} [${e.type}] ${e.detectedAt.slice(0, 19)} | source: ${e.source} | ${handled}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const eventDaemonTool: ToolDefinition = {
  name: 'meta.event-daemon',
  description:
    'Persistent Event Daemon. Monitors YouTube comments, view spikes, API quota warnings, ' +
    'subscriber milestones, and system health in real-time. Events are persisted to mind.db. ' +
    'The daemon starts automatically on first use and runs for the process lifetime. ' +
    'Use emit-event to manually fire custom events for testing or automation.',
  category: 'meta',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description:
        'Operation: ' +
        '"status" — daemon running state and uptime. ' +
        '"recent-events" — last N events sorted by time. ' +
        '"unhandled" — events waiting for a handler (sorted by priority). ' +
        '"stats" — total/handled/unhandled counts grouped by event type. ' +
        '"emit-event" — manually emit a custom event.',
      enum: ['status', 'recent-events', 'unhandled', 'stats', 'emit-event'],
    },
    limit: {
      type: 'number',
      description: 'Number of events to return for recent-events (default: 20, max: 500).',
      default: 20,
    },
    eventType: {
      type: 'string',
      description: 'Custom event type string for emit-event (required).',
    },
    eventData: {
      type: 'object',
      description: 'Arbitrary data payload for emit-event.',
      properties: {},
    },
    priority: {
      type: 'string',
      description: 'Event priority for emit-event: low | medium | high | critical (default: medium).',
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    startDaemon: {
      type: 'boolean',
      description: 'For status action: if true, starts the daemon if it is not running (default: true).',
      default: true,
    },
    pollIntervalMs: {
      type: 'number',
      description: 'Poll interval in milliseconds when starting the daemon via status action (default: 60000, min: 5000).',
      default: 60_000,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(params['action'] ?? '');
    logger.info({ session: ctx.sessionId, action }, 'meta.event-daemon invoked');

    try {
      switch (action) {
        case 'status': {
          const d = getDaemon();
          const shouldStart = (params['startDaemon'] as boolean | undefined) !== false;

          if (!d.isRunning() && shouldStart) {
            const rawPoll = Number(params['pollIntervalMs'] ?? DEFAULT_POLL_MS);
            const pollMs = Number.isFinite(rawPoll) ? Math.max(5_000, rawPoll) : DEFAULT_POLL_MS;
            d.start(pollMs);
            _startedAt = new Date().toISOString();
          }

          const stats = d.getStats();
          const running = d.isRunning();
          const uptime = _startedAt
            ? `${Math.round((Date.now() - new Date(_startedAt).getTime()) / 1_000)}s`
            : 'n/a';

          const lines = [
            `Status: ${running ? 'RUNNING' : 'STOPPED'}`,
            `Started at: ${_startedAt ?? 'not started'}`,
            `Uptime: ${uptime}`,
            `Poll interval: ${DEFAULT_POLL_MS / 1_000}s`,
            `Total events: ${stats.totalEvents}`,
            `Handled: ${stats.handled} | Unhandled: ${stats.unhandled}`,
          ];
          logger.info({ running, stats }, 'Event daemon status requested');
          return { success: true, output: lines.join('\n'), data: { running, startedAt: _startedAt, stats } };
        }

        case 'recent-events': {
          const d = ensureStarted();
          const limit = Math.min(500, Math.max(1, Number(params['limit'] ?? 20)));
          const events = d.getRecentEvents(limit);
          if (events.length === 0) {
            return { success: true, output: 'No events recorded yet.', data: [] };
          }
          const lines = events.map(formatEvent);
          return {
            success: true,
            output: `${events.length} recent event(s):\n${lines.join('\n')}`,
            data: events,
          };
        }

        case 'unhandled': {
          const d = ensureStarted();
          const events = d.getUnhandledEvents();
          if (events.length === 0) {
            return { success: true, output: 'No unhandled events — all clear.', data: [] };
          }
          const lines = events.map(formatEvent);
          return {
            success: true,
            output: `${events.length} unhandled event(s) (by priority):\n${lines.join('\n')}`,
            data: events,
          };
        }

        case 'stats': {
          const d = ensureStarted();
          const stats = d.getStats();
          const byTypeLines = Object.entries(stats.byType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => `  ${type}: ${count}`);
          const output = [
            `Total events: ${stats.totalEvents}`,
            `Handled:      ${stats.handled}`,
            `Unhandled:    ${stats.unhandled}`,
            `By type:`,
            ...byTypeLines,
          ].join('\n');
          return { success: true, output, data: stats };
        }

        case 'emit-event': {
          const eventType = params['eventType'] as string | undefined;
          if (!eventType?.trim()) return { success: false, output: 'eventType is required for emit-event.' };

          const validPriorities: EventPriority[] = ['low', 'medium', 'high', 'critical'];
          const rawPriority = String(params['priority'] ?? 'medium') as EventPriority;
          const priority: EventPriority = validPriorities.includes(rawPriority) ? rawPriority : 'medium';
          const eventData = (params['eventData'] as Record<string, unknown> | undefined) ?? {};

          const d = ensureStarted();
          d.emit(eventType.trim(), eventData, priority);

          logger.info({ eventType, priority }, 'Custom event emitted via tool');
          return {
            success: true,
            output: `Event emitted: type="${eventType}" priority=${priority}`,
            data: { type: eventType, priority, data: eventData },
          };
        }

        default:
          return { success: false, output: `Unknown action: "${action}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.event-daemon error');
      return { success: false, output: `Event daemon error: ${msg}` };
    }
  },
};
