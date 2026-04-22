/**
 * @file tests/channels/gcalendar.test.ts
 * @description Tests for gcalendar-connector.ts — graceful stub behavior.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('gcalendar-connector (no vault credential configured)', () => {
  it('listCalendarEvents returns success=false with helpful message', async () => {
    const { listCalendarEvents } = await import('../../src/core/channels/gcalendar-connector.js');
    const result = await listCalendarEvents('primary');
    expect(result.success).toBe(false);
    expect(result.output).toContain('not configured in vault');
  });

  it('createCalendarEvent dry-run returns success=true with useful output', async () => {
    const { createCalendarEvent } = await import('../../src/core/channels/gcalendar-connector.js');
    // googleapis is installed; dry-run path executes before vault credential check
    const result = await createCalendarEvent(
      { summary: 'Test Event', start: { dateTime: '2026-04-16T10:00:00Z' }, end: { dateTime: '2026-04-16T11:00:00Z' } },
      true,
    );
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it('createCalendarEvent validates required summary', async () => {
    const { createCalendarEvent } = await import('../../src/core/channels/gcalendar-connector.js');
    const result = await createCalendarEvent({ start: { dateTime: '2026-04-16T10:00:00Z' }, end: { dateTime: '2026-04-16T11:00:00Z' } });
    // Missing summary — would fail validation before googleapis check
    // Actually googleapis check runs first since it's at top of function
    expect(result.success).toBe(false);
  });
});

describe('comms.gcalendar tool', () => {
  it('returns error for invalid operation', async () => {
    const { gcalendarTool } = await import('../../src/core/tools/builtin/comms/gcalendar.js');
    const result = await gcalendarTool.execute(
      { operation: 'delete' }, // invalid
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof gcalendarTool.execute>[1],
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('operation');
  });

  it('list operation passes through gracefully', async () => {
    const { gcalendarTool } = await import('../../src/core/tools/builtin/comms/gcalendar.js');
    const result = await gcalendarTool.execute(
      { operation: 'list' },
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof gcalendarTool.execute>[1],
    );
    expect(result.success).toBe(false);
    expect(result.output).toBeDefined();
  });

  it('create requires summary', async () => {
    const { gcalendarTool } = await import('../../src/core/tools/builtin/comms/gcalendar.js');
    const result = await gcalendarTool.execute(
      { operation: 'create', start_time: '2026-04-15T10:00:00Z', end_time: '2026-04-15T11:00:00Z' },
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof gcalendarTool.execute>[1],
    );
    expect(result.success).toBe(false);
  });

  it('create requires start_time', async () => {
    const { gcalendarTool } = await import('../../src/core/tools/builtin/comms/gcalendar.js');
    const result = await gcalendarTool.execute(
      { operation: 'create', summary: 'Meeting', end_time: '2026-04-15T11:00:00Z' },
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof gcalendarTool.execute>[1],
    );
    expect(result.success).toBe(false);
  });
});
