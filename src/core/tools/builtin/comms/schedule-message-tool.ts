/**
 * @file schedule-message-tool.ts
 * @description `comms.schedule-message` — lets the agent proactively schedule a
 * message to a chat channel (telegram/discord/slack/…) for a future time, or on
 * a recurring cadence. Persisted in the `scheduled_messages` table and delivered
 * by ScheduledMessageDispatcher (channels/scheduled-messages.ts).
 *
 * Registered behind SUDO_SCHEDULED_MESSAGES=1 (cli.ts). When the feature is off
 * the singleton is null and the tool returns a clear disabled message.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { genId } from '../../../shared/utils.js';
import {
  getScheduledMessageInstance,
  MIN_RECURRENCE_SEC,
} from '../../../channels/scheduled-messages.js';
import type { ChannelType } from '../../../channels/types.js';

const logger = createLogger('tools:comms:schedule-message');

/** Runtime allowlist mirroring the ChannelType union (channels/types.ts). */
const VALID_CHANNELS: readonly string[] = [
  'telegram', 'whatsapp', 'discord', 'slack', 'signal', 'matrix', 'irc', 'web', 'electron', 'voice',
];

/** Resolve a schedule time from `at` (ISO) or `in_seconds` (relative). */
function resolveScheduleTime(at: unknown, inSeconds: unknown): { iso: string } | { error: string } {
  if (typeof inSeconds === 'number' && Number.isFinite(inSeconds)) {
    if (inSeconds < 0) return { error: 'in_seconds must be >= 0.' };
    return { iso: new Date(Date.now() + inSeconds * 1000).toISOString() };
  }
  if (typeof at === 'string' && at.trim()) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return { error: `Could not parse "at" as a date: ${at}` };
    return { iso: new Date(t).toISOString() };
  }
  return { error: 'Provide either "at" (ISO 8601 datetime) or "in_seconds" (relative delay).' };
}

export const scheduleMessageTool: ToolDefinition = {
  name: 'comms.schedule-message',
  description:
    'Proactively schedule a message to a chat channel for a future time, or on a repeating cadence — reminders, digests, follow-ups the daemon sends WITHOUT the user asking again. Actions: schedule, list, cancel.',
  category: 'comms',
  timeout: 10_000,
  parameters: {
    action: { type: 'string', required: true, description: 'Operation.', enum: ['schedule', 'list', 'cancel'] },
    channel: { type: 'string', description: 'Target chat channel (required for schedule).', enum: VALID_CHANNELS as string[] },
    to: { type: 'string', description: 'Destination peer/chat id on that channel (required for schedule). For telegram this is the chat id.' },
    content: { type: 'string', description: 'Fixed message text to send. Provide content OR prompt (not both).' },
    prompt: { type: 'string', description: 'Alternative to content: a prompt the brain expands into the message body AT send time (dynamic digest/check-in). Pair with repeat_seconds for a recurring AI digest.' },
    at: { type: 'string', description: 'ISO 8601 datetime to send at. Use this OR in_seconds.' },
    in_seconds: { type: 'number', description: 'Send after this many seconds from now. Use this OR at.' },
    repeat_seconds: { type: 'number', description: `Optional: repeat every N seconds (minimum ${MIN_RECURRENCE_SEC}). Omit for a one-shot message.` },
    id: { type: 'string', description: 'Scheduled-message id (required for cancel).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'comms.schedule-message invoked');

    const dispatcher = getScheduledMessageInstance();
    if (!dispatcher) {
      return { success: false, output: 'Scheduled messaging is disabled. Set SUDO_SCHEDULED_MESSAGES=1 to enable it.' };
    }
    const store = dispatcher.store;

    try {
      switch (action) {
        case 'schedule': {
          const channel = (params['channel'] as string | undefined)?.trim();
          const to = (params['to'] as string | undefined)?.trim();
          const content = (params['content'] as string | undefined);
          const prompt = (params['prompt'] as string | undefined);
          if (!channel || !VALID_CHANNELS.includes(channel)) {
            return { success: false, output: `channel is required and must be one of: ${VALID_CHANNELS.join(', ')}.` };
          }
          if (!to) return { success: false, output: 'to (destination peer/chat id) is required.' };
          const hasContent = !!content?.trim();
          const hasPrompt = !!prompt?.trim();
          if (hasContent === hasPrompt) {
            return { success: false, output: 'provide exactly one of "content" (fixed text) or "prompt" (brain-generated at send time).' };
          }

          const resolved = resolveScheduleTime(params['at'], params['in_seconds']);
          if ('error' in resolved) return { success: false, output: resolved.error };

          let recurrenceSec: number | undefined;
          const repeat = params['repeat_seconds'];
          if (repeat !== undefined && repeat !== null) {
            if (typeof repeat !== 'number' || !Number.isFinite(repeat) || repeat < MIN_RECURRENCE_SEC) {
              return { success: false, output: `repeat_seconds must be a number >= ${MIN_RECURRENCE_SEC}.` };
            }
            recurrenceSec = Math.floor(repeat);
          }

          const entry = store.insert({
            id: genId(),
            channel: channel as ChannelType,
            peerId: to,
            content: hasContent ? content!.trim() : '',
            prompt: hasPrompt ? prompt!.trim() : undefined,
            scheduleTime: resolved.iso,
            recurrenceSec,
          });
          const repeatNote = recurrenceSec ? `, repeating every ${recurrenceSec}s` : '';
          const kindNote = hasPrompt ? ' (brain-generated at send time)' : '';
          return {
            success: true,
            output: `Message scheduled for ${entry.scheduleTime} on ${channel}${repeatNote}${kindNote} (id: ${entry.id}).`,
            data: entry,
          };
        }

        case 'list': {
          const active = store.list().filter((m) => m.status === 'pending');
          return {
            success: true,
            output: active.length > 0 ? `${active.length} pending scheduled message(s).` : 'No pending scheduled messages.',
            data: active,
          };
        }

        case 'cancel': {
          const id = (params['id'] as string | undefined)?.trim();
          if (!id) return { success: false, output: 'id is required for cancel.' };
          const existing = store.get(id);
          if (!existing) return { success: false, output: `No scheduled message found with id: ${id}` };
          store.cancel(id);
          return { success: true, output: `Scheduled message ${id} cancelled.`, data: { ...existing, status: 'cancelled' } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'comms.schedule-message error');
      return { success: false, output: `schedule-message error: ${msg}` };
    }
  },
};
