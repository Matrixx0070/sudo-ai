/**
 * Unit tests for the comms.schedule-message tool: validation + action routing
 * against a live in-memory ScheduledMessageDispatcher singleton.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../../src/core/memory/schema.js';
import { scheduleMessageTool } from '../../../../src/core/tools/builtin/comms/schedule-message-tool.js';
import {
  ScheduledMessageDispatcher,
  setScheduledMessageInstance,
  getScheduledMessageInstance,
  type ChannelSender,
} from '../../../../src/core/channels/scheduled-messages.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

const ctx = { sessionId: 'test', workingDir: '/tmp', config: {}, logger: console } as unknown as ToolContext;
const noopSender = (async () => {}) as ChannelSender;

function enable(): ScheduledMessageDispatcher {
  const db = new Database(':memory:');
  initializeSchema(db);
  const d = new ScheduledMessageDispatcher(db, noopSender);
  setScheduledMessageInstance(d);
  return d;
}

describe('comms.schedule-message — disabled', () => {
  it('returns a clear disabled message when the dispatcher is not initialised', async () => {
    // The other suites set the singleton; this asserts the disabled-branch text
    // exists. If a prior suite enabled it, the schedule still works — so we only
    // assert the disabled message shape when truly uninitialised.
    if (getScheduledMessageInstance() === null) {
      const res = await scheduleMessageTool.execute({ action: 'schedule' }, ctx);
      expect(res.success).toBe(false);
      expect(res.output).toMatch(/SUDO_SCHEDULED_MESSAGES/);
    }
  });
});

describe('comms.schedule-message — schedule', () => {
  beforeEach(() => enable());

  it('schedules a one-shot message with in_seconds', async () => {
    const res = await scheduleMessageTool.execute(
      { action: 'schedule', channel: 'telegram', to: '12345', content: 'ping', in_seconds: 120 },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/scheduled for/i);
    const store = getScheduledMessageInstance()!.store;
    expect(store.list()).toHaveLength(1);
    const m = store.list()[0]!;
    expect(m.channel).toBe('telegram');
    expect(m.peerId).toBe('12345');
    expect(Date.parse(m.scheduleTime)).toBeGreaterThan(Date.now());
  });

  it('accepts an ISO "at" time', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const res = await scheduleMessageTool.execute(
      { action: 'schedule', channel: 'telegram', to: '1', content: 'later', at },
      ctx,
    );
    expect(res.success).toBe(true);
  });

  it('stores a recurrence when repeat_seconds is valid', async () => {
    const res = await scheduleMessageTool.execute(
      { action: 'schedule', channel: 'telegram', to: '1', content: 'digest', in_seconds: 60, repeat_seconds: 3600 },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(getScheduledMessageInstance()!.store.list()[0]!.recurrenceSec).toBe(3600);
  });

  it('schedules a dynamic-digest with a prompt instead of content', async () => {
    const res = await scheduleMessageTool.execute(
      { action: 'schedule', channel: 'telegram', to: '1', prompt: 'daily summary of my tasks', in_seconds: 60, repeat_seconds: 86400 },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/brain-generated/i);
    const m = getScheduledMessageInstance()!.store.list()[0]!;
    expect(m.prompt).toBe('daily summary of my tasks');
    expect(m.content).toBe('');
    expect(m.recurrenceSec).toBe(86400);
  });

  it.each([
    [{ action: 'schedule', to: '1', content: 'x', in_seconds: 60 }, /channel is required/i],
    [{ action: 'schedule', channel: 'nope', to: '1', content: 'x', in_seconds: 60 }, /must be one of/i],
    [{ action: 'schedule', channel: 'telegram', content: 'x', in_seconds: 60 }, /to .*is required/i],
    [{ action: 'schedule', channel: 'telegram', to: '1', in_seconds: 60 }, /provide exactly one/i],
    [{ action: 'schedule', channel: 'telegram', to: '1', content: 'x', prompt: 'y', in_seconds: 60 }, /provide exactly one/i],
    [{ action: 'schedule', channel: 'telegram', to: '1', content: 'x' }, /at.*or.*in_seconds/i],
    [{ action: 'schedule', channel: 'telegram', to: '1', content: 'x', in_seconds: 60, repeat_seconds: 5 }, /repeat_seconds must be/i],
  ])('rejects invalid input %#', async (params, pattern) => {
    const res = await scheduleMessageTool.execute(params as Record<string, unknown>, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(pattern as RegExp);
  });
});

describe('comms.schedule-message — list & cancel', () => {
  beforeEach(() => enable());

  it('lists pending and cancels by id', async () => {
    const scheduled = await scheduleMessageTool.execute(
      { action: 'schedule', channel: 'telegram', to: '1', content: 'x', in_seconds: 60 },
      ctx,
    );
    const id = (scheduled.data as { id: string }).id;

    const listed = await scheduleMessageTool.execute({ action: 'list' }, ctx);
    expect(listed.success).toBe(true);
    expect((listed.data as unknown[]).length).toBe(1);

    const cancelled = await scheduleMessageTool.execute({ action: 'cancel', id }, ctx);
    expect(cancelled.success).toBe(true);
    expect(getScheduledMessageInstance()!.store.get(id)?.status).toBe('cancelled');
  });

  it('cancel without id fails; cancel unknown id fails', async () => {
    expect((await scheduleMessageTool.execute({ action: 'cancel' }, ctx)).success).toBe(false);
    expect((await scheduleMessageTool.execute({ action: 'cancel', id: 'nope' }, ctx)).success).toBe(false);
  });
});
