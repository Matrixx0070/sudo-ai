/**
 * @file tools/builtin/comms/gcalendar.ts
 * @description comms.gcalendar — Google Calendar tool wrapper.
 *
 * Requires googleapis package (not currently installed).
 * Gracefully returns not-configured message if absent.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { listCalendarEvents, createCalendarEvent } from '../../../channels/gcalendar-connector.js';
import { createLogger } from '../../../shared/logger.js';
import { withCommsIdempotency } from '../../../comms/idempotency.js';

const log = createLogger('tool:comms.gcalendar');

type CalendarOperation = 'list' | 'create';

export const gcalendarTool: ToolDefinition = {
  name: 'comms.gcalendar',
  description:
    'Interact with Google Calendar via OAuth. Operations: list (next 7 days), create (new event). ' +
    'Requires googleapis package + OAuth token in vault (namespace: gcalendar). ' +
    'Supports dry_run flag for create to validate without side effects.',
  category: 'comms',
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['list', 'create'],
      description: 'Calendar operation: "list" to list upcoming events, "create" to create a new event.',
    },
    calendar_id: {
      type: 'string',
      required: false,
      default: 'primary',
      description: 'For list: Google Calendar ID (defaults to "primary").',
    },
    summary: {
      type: 'string',
      required: false,
      description: 'For create: event title/summary.',
    },
    start_time: {
      type: 'string',
      required: false,
      description: 'For create: start time in ISO-8601 format (e.g. 2026-04-15T10:00:00Z).',
    },
    end_time: {
      type: 'string',
      required: false,
      description: 'For create: end time in ISO-8601 format.',
    },
    description: {
      type: 'string',
      required: false,
      description: 'For create: optional event description.',
    },
    dry_run: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'For create: if true, validates event but does not create it.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = typeof params['operation'] === 'string'
      ? params['operation'] as CalendarOperation
      : null;

    if (!operation || !['list', 'create'].includes(operation)) {
      return { success: false, output: 'comms.gcalendar: operation must be "list" or "create".' };
    }

    if (operation === 'list') {
      const calendarId = typeof params['calendar_id'] === 'string'
        ? params['calendar_id'].trim()
        : 'primary';

      log.info({ sessionId: ctx.sessionId, calendarId }, 'Calendar list operation');
      const result = await listCalendarEvents(calendarId, ctx.signal);
      return {
        success: result.success,
        output: result.output,
        data: result.events ? { events: result.events, count: result.count } : undefined,
      };
    }

    // create
    const summary = typeof params['summary'] === 'string' ? params['summary'].trim() : '';
    const startTime = typeof params['start_time'] === 'string' ? params['start_time'] : '';
    const endTime = typeof params['end_time'] === 'string' ? params['end_time'] : '';
    const description = typeof params['description'] === 'string' ? params['description'] : undefined;
    const dryRun = params['dry_run'] === true;

    if (!summary) return { success: false, output: 'comms.gcalendar: "summary" is required for create.' };
    if (!startTime) return { success: false, output: 'comms.gcalendar: "start_time" is required for create.' };
    if (!endTime) return { success: false, output: 'comms.gcalendar: "end_time" is required for create.' };

    log.info({ sessionId: ctx.sessionId, summary, dryRun }, 'Calendar create operation');
    const doCreate = () => createCalendarEvent(
      {
        summary,
        start: { dateTime: startTime },
        end: { dateTime: endTime },
        ...(description !== undefined ? { description } : {}),
      },
      dryRun,
      ctx.signal,
    );

    // A dry run has no side effect, so it is never deduped; a real create is
    // guarded so a re-run turn can't create the same event twice.
    if (dryRun) {
      const result = await doCreate();
      return {
        success: result.success,
        output: result.output,
        data: result.eventId ? { eventId: result.eventId, htmlLink: result.htmlLink, dryRun: result.dryRun } : undefined,
      };
    }

    const guard = await withCommsIdempotency(
      { channel: 'gcalendar', recipient: 'primary', body: `${summary}\n${startTime}\n${endTime}` },
      doCreate,
      (r) => r.eventId ?? undefined,
    );
    if (guard.duplicate) {
      return {
        success: true,
        output: `comms.gcalendar: duplicate suppressed — an identical event "${summary}" (${startTime}) was already created within the idempotency window.${guard.messageId ? ` Prior event id: ${guard.messageId}.` : ''}`,
        data: { duplicate: true, eventId: guard.messageId },
      };
    }
    const result = guard.result!;
    return {
      success: result.success,
      output: result.output,
      data: result.eventId ? { eventId: result.eventId, htmlLink: result.htmlLink, dryRun: result.dryRun } : undefined,
    };
  },
};

export default gcalendarTool;
