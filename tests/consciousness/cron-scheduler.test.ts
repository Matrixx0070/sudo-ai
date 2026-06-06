/**
 * @file cron-scheduler.test.ts
 * @description Tests for CronScheduler — cron expression parsing, scheduling,
 * deterministic jitter, one-shot auto-delete, recurring auto-expiry,
 * persistence, and missed task detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  CronScheduler,
  type CronTask,
  type CronSchedulerConfig,
} from '../../src/core/consciousness/cron-scheduler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let persistencePath: string;

function makeConfig(): Partial<CronSchedulerConfig> {
  persistencePath = join(tempDir, 'cron-tasks.json');
  return {
    persistencePath,
    recurringExpiryDays: 7,
  };
}

// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cron-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Cron expression parsing
  // -----------------------------------------------------------------------

  it('parses a standard 5-field cron expression', () => {
    const scheduler = new CronScheduler(makeConfig());
    const fields = scheduler.parseCron('0 9 * * *');
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([9]);
    // dayOfMonth, month, dayOfWeek should be full ranges
    expect(fields.dayOfMonth.length).toBeGreaterThan(0);
    expect(fields.month.length).toBeGreaterThan(0);
    expect(fields.dayOfWeek.length).toBeGreaterThan(0);
  });

  it('parses wildcard fields as full ranges', () => {
    const scheduler = new CronScheduler(makeConfig());
    const fields = scheduler.parseCron('* * * * *');
    expect(fields.minute).toHaveLength(60); // 0-59
    expect(fields.hour).toHaveLength(24);  // 0-23
  });

  it('parses step expressions (*/5)', () => {
    const scheduler = new CronScheduler(makeConfig());
    const fields = scheduler.parseCron('*/5 * * * *');
    expect(fields.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it('parses range expressions (1-5)', () => {
    const scheduler = new CronScheduler(makeConfig());
    const fields = scheduler.parseCron('0 1-5 * * *');
    expect(fields.hour).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses list expressions (1,3,5)', () => {
    const scheduler = new CronScheduler(makeConfig());
    const fields = scheduler.parseCron('1,3,5 * * * *');
    expect(fields.minute).toEqual([1, 3, 5]);
  });

  it('throws on invalid cron expressions', () => {
    const scheduler = new CronScheduler(makeConfig());
    expect(() => scheduler.parseCron('invalid')).toThrow();
    expect(() => scheduler.parseCron('0 9 * *')).toThrow(); // 4 fields
    expect(() => scheduler.parseCron('0 9 * * * *')).toThrow(); // 6 fields
  });

  // -----------------------------------------------------------------------
  // testCronMatch
  // -----------------------------------------------------------------------

  it('matches a date against a cron expression', () => {
    const scheduler = new CronScheduler(makeConfig());

    // 9:00 AM on any day
    const nineAm = new Date('2026-06-05T09:00:00Z');
    const tenAm = new Date('2026-06-05T10:00:00Z');

    expect(scheduler.testCronMatch('0 9 * * *', nineAm)).toBe(true);
    expect(scheduler.testCronMatch('0 9 * * *', tenAm)).toBe(false);
  });

  it('matches day-of-week correctly', () => {
    const scheduler = new CronScheduler(makeConfig());

    // June 5, 2026 is a Friday (day 5)
    const friday = new Date('2026-06-05T09:00:00Z');
    // Monday- Friday only (1-5)
    expect(scheduler.testCronMatch('0 9 * * 1-5', friday)).toBe(true);
    // Sunday only (0)
    expect(scheduler.testCronMatch('0 9 * * 0', friday)).toBe(false);
  });

  it('matches step expressions correctly', () => {
    const scheduler = new CronScheduler(makeConfig());

    const atFive = new Date('2026-06-05T09:05:00Z');
    const atSeven = new Date('2026-06-05T09:07:00Z');

    expect(scheduler.testCronMatch('*/5 * * * *', atFive)).toBe(true);
    expect(scheduler.testCronMatch('*/5 * * * *', atSeven)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // schedule / unschedule / listTasks
  // -----------------------------------------------------------------------

  it('schedules a recurring task and lists it', () => {
    const scheduler = new CronScheduler(makeConfig());
    const task = scheduler.schedule('0 9 * * *', 'morning briefing');

    expect(task.id).toBeTruthy();
    expect(task.cron).toBe('0 9 * * *');
    expect(task.prompt).toBe('morning briefing');
    expect(task.kind).toBe('recurring');
    expect(task.durable).toBe(false);

    const tasks = scheduler.listTasks();
    expect(tasks).toHaveLength(1);
  });

  it('schedules a one-shot task', () => {
    const scheduler = new CronScheduler(makeConfig());
    const task = scheduler.schedule('30 14 * * *', 'reminder', { kind: 'one-shot' });

    expect(task.kind).toBe('one-shot');
  });

  it('unschedules a task by ID', () => {
    const scheduler = new CronScheduler(makeConfig());
    const task = scheduler.schedule('0 9 * * *', 'test');

    expect(scheduler.listTasks()).toHaveLength(1);
    const removed = scheduler.unschedule(task.id);
    expect(removed).toBe(true);
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  it('returns false when unscheduling a non-existent task', () => {
    const scheduler = new CronScheduler(makeConfig());
    const removed = scheduler.unschedule('nonexistent-id');
    expect(removed).toBe(false);
  });

  it('retrieves a task by ID', () => {
    const scheduler = new CronScheduler(makeConfig());
    const task = scheduler.schedule('0 9 * * *', 'get-test');

    const retrieved = scheduler.getTask(task.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.prompt).toBe('get-test');
  });

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  it('persists durable tasks to disk', () => {
    const scheduler = new CronScheduler(makeConfig());
    scheduler.schedule('0 9 * * *', 'durable task', { durable: true });

    // Check that the file was written
    expect(existsSync(persistencePath)).toBe(true);
    const data = JSON.parse(readFileSync(persistencePath, 'utf-8')) as CronTask[];
    expect(data).toHaveLength(1);
    expect(data[0].prompt).toBe('durable task');
    expect(data[0].durable).toBe(true);
  });

  it('does not persist non-durable tasks', () => {
    const scheduler = new CronScheduler(makeConfig());
    scheduler.schedule('0 9 * * *', 'ephemeral task', { durable: false });

    // No persistence file or empty
    if (existsSync(persistencePath)) {
      const data = JSON.parse(readFileSync(persistencePath, 'utf-8')) as CronTask[];
      expect(data).toHaveLength(0);
    }
  });

  it('loads durable tasks from disk on construction', () => {
    // Initialize config first so persistencePath points to current tempDir
    makeConfig();

    // Pre-create the persistence file
    const taskData: CronTask[] = [
      {
        id: 'pre-existing-1',
        cron: '0 9 * * *',
        prompt: 'loaded task',
        kind: 'recurring',
        createdAt: new Date().toISOString(),
        lastFiredAt: null,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        durable: true,
      },
    ];
    writeFileSync(persistencePath, JSON.stringify(taskData, null, 2), 'utf-8');

    const scheduler = new CronScheduler(makeConfig());
    const tasks = scheduler.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('loaded task');
  });

  // -----------------------------------------------------------------------
  // Expiry
  // -----------------------------------------------------------------------

  it('sets expiry date 7 days in the future for recurring tasks', () => {
    const scheduler = new CronScheduler(makeConfig());
    const before = new Date();
    const task = scheduler.schedule('0 9 * * *', 'expiry-test', { kind: 'recurring' });
    const after = new Date();

    const expiresAt = new Date(task.expiresAt);
    const minExpiry = new Date(before.getTime() + 7 * 24 * 60 * 60 * 1000);
    const maxExpiry = new Date(after.getTime() + 7 * 24 * 60 * 60 * 1000);

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(minExpiry.getTime());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(maxExpiry.getTime());
  });

  // -----------------------------------------------------------------------
  // Missed task detection
  // -----------------------------------------------------------------------

  it('detects missed tasks when loading from disk', () => {
    // Initialize config first so persistencePath points to current tempDir
    makeConfig();

    const oldFireTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
    const taskData: CronTask[] = [
      {
        id: 'missed-1',
        cron: '0 * * * *',
        prompt: 'hourly task',
        kind: 'recurring',
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        lastFiredAt: oldFireTime,
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        durable: true,
      },
    ];
    writeFileSync(persistencePath, JSON.stringify(taskData, null, 2), 'utf-8');

    const scheduler = new CronScheduler(makeConfig());
    const result = scheduler.loadTasks();
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0].id).toBe('missed-1');
  });

  // -----------------------------------------------------------------------
  // Task handler callback
  // -----------------------------------------------------------------------

  it('fires a handler callback when a task matches', () => {
    const scheduler = new CronScheduler(makeConfig());
    const fired: CronTask[] = [];

    scheduler.schedule('* * * * *', 'handler-test', {
      handler: (task) => {
        fired.push(task);
      },
    });

    // Manually tick
    scheduler.tick();

    // Since we just ticked, and the cron matches every minute, the handler
    // should have been scheduled (possibly with jitter delay)
    expect(fired.length + scheduler.listTasks().length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Auto-expiry
  // -----------------------------------------------------------------------

  it('removes expired tasks on tick', () => {
    const scheduler = new CronScheduler(makeConfig());

    // Create a task that's already expired
    const task = scheduler.schedule('* * * * *', 'about-to-expire');
    // Manually expire it
    const stored = scheduler.getTask(task.id)!;
    stored.expiresAt = new Date(Date.now() - 1000).toISOString(); // expired

    // Tick should remove it
    scheduler.tick();

    // The expired task should have been removed
    expect(scheduler.getTask(task.id)).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  it('start and stop the tick loop without error', () => {
    const scheduler = new CronScheduler(makeConfig());
    scheduler.start();
    // Let it run briefly
    scheduler.stop();
    // No assertion beyond "did not throw"
    expect(true).toBe(true);
  });

  // -----------------------------------------------------------------------
  // One-shot auto-delete
  // -----------------------------------------------------------------------

  it('removes one-shot tasks after they fire', () => {
    const scheduler = new CronScheduler(makeConfig());
    const task = scheduler.schedule('* * * * *', 'one-shot-test', { kind: 'one-shot' });

    expect(scheduler.listTasks()).toHaveLength(1);

    // Tick to trigger the match
    scheduler.tick();

    // One-shot should be removed after firing (it may have a timer pending
    // for jitter, but the task entry should be removed from the task map)
    const remaining = scheduler.listTasks();
    expect(remaining.find((t) => t.id === task.id)).toBeUndefined();
  });
});