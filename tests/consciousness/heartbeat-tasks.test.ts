/**
 * @file tests/consciousness/heartbeat-tasks.test.ts
 * @description Per-task heartbeat scheduling: interval parsing, frontmatter task
 * extraction, due-computation against persisted state, and the end-to-end
 * getHeartbeatDueTasks read path. This is the logic the live heartbeat now runs
 * through (HeartbeatRunner.wrapRunner, wired into cli.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseInterval,
  parseFrontmatterTasks,
  getDueTasks,
  getHeartbeatDueTasks,
  markTasksRun,
  loadTaskState,
} from '../../src/core/cron/heartbeat-tasks.js';

// Mirrors the live workspace/HEARTBEAT.md frontmatter shape.
const FRONTMATTER = [
  'tasks:',
  '  - name: system-health',
  '    interval: 30m',
  '  - name: cost-check',
  '    interval: 1h',
  '  - name: task-sweep',
  '    interval: 2h',
].join('\n');

const HEARTBEAT_MD = `---\n${FRONTMATTER}\n---\n\n# Heartbeat\n\nbody text\n`;

describe('parseInterval', () => {
  it('PI-1: parses m/h/d units', () => {
    expect(parseInterval('30m')).toBe(30 * 60_000);
    expect(parseInterval('1h')).toBe(3_600_000);
    expect(parseInterval('2h')).toBe(7_200_000);
    expect(parseInterval('1d')).toBe(86_400_000);
  });
  it('PI-2: returns null for unrecognized formats (→ always due)', () => {
    for (const bad of ['90s', '1h30m', '1.5h', 'h', '', 'soon']) {
      expect(parseInterval(bad)).toBeNull();
    }
  });
});

describe('parseFrontmatterTasks', () => {
  it('PF-1: extracts name+interval pairs from the tasks block', () => {
    const tasks = parseFrontmatterTasks(FRONTMATTER);
    expect(tasks).toEqual([
      { name: 'system-health', intervalMs: 1_800_000 },
      { name: 'cost-check', intervalMs: 3_600_000 },
      { name: 'task-sweep', intervalMs: 7_200_000 },
    ]);
  });
  it('PF-2: an unrecognized interval becomes intervalMs 0 (always due)', () => {
    const tasks = parseFrontmatterTasks('tasks:\n  - name: x\n    interval: nope\n');
    expect(tasks).toEqual([{ name: 'x', intervalMs: 0 }]);
  });
  it('PF-3: no tasks block → empty', () => {
    expect(parseFrontmatterTasks('timezone: UTC\n')).toEqual([]);
  });
});

describe('getDueTasks', () => {
  const tasks = [
    { name: 'system-health', intervalMs: 1_800_000 }, // 30m
    { name: 'cost-check', intervalMs: 3_600_000 },     // 1h
  ];
  const now = new Date('2026-06-19T12:00:00.000Z');

  it('GD-1: never-run tasks are due', () => {
    expect(getDueTasks(tasks, {}, now).sort()).toEqual(['cost-check', 'system-health']);
  });
  it('GD-2: only tasks whose interval has elapsed are due', () => {
    const state = {
      'system-health': '2026-06-19T11:25:00.000Z', // 35m ago → due (>30m)
      'cost-check': '2026-06-19T11:40:00.000Z',     // 20m ago → not due (<1h)
    };
    expect(getDueTasks(tasks, state, now)).toEqual(['system-health']);
  });
  it('GD-3: intervalMs 0 is always due; invalid timestamp is treated as due', () => {
    const always = [{ name: 'a', intervalMs: 0 }];
    expect(getDueTasks(always, { a: now.toISOString() }, now)).toEqual(['a']);
    expect(getDueTasks(tasks, { 'system-health': 'not-a-date' }, now)).toContain('system-health');
  });
});

describe('getHeartbeatDueTasks + markTasksRun (end-to-end)', () => {
  let dir: string;
  let hbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hbtasks-'));
    hbFile = join(dir, 'HEARTBEAT.md');
    writeFileSync(hbFile, HEARTBEAT_MD, 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('E2E-1: fresh (no state) → all tasks due', () => {
    const { tasks, dueNames } = getHeartbeatDueTasks(hbFile, dir, new Date('2026-06-19T12:00:00Z'));
    expect(tasks).toHaveLength(3);
    expect(dueNames.sort()).toEqual(['cost-check', 'system-health', 'task-sweep']);
  });

  it('E2E-2: after a run, intervals gate the next tick; longer ones fire later', () => {
    const t0 = new Date('2026-06-19T12:00:00Z');
    const first = getHeartbeatDueTasks(hbFile, dir, t0);
    markTasksRun(dir, first.state, first.dueNames, t0);
    expect(existsSync(join(dir, 'memory', 'heartbeat-task-state.json'))).toBe(true);

    // +31m: only system-health (30m) is due again.
    const t1 = new Date('2026-06-19T12:31:00Z');
    expect(getHeartbeatDueTasks(hbFile, dir, t1).dueNames).toEqual(['system-health']);

    // +2h1m from t0: all three due again.
    const t2 = new Date('2026-06-19T14:01:00Z');
    expect(getHeartbeatDueTasks(hbFile, dir, t2).dueNames.sort())
      .toEqual(['cost-check', 'system-health', 'task-sweep']);
  });

  it('E2E-3: state round-trips through markTasksRun/loadTaskState', () => {
    const t0 = new Date('2026-06-19T12:00:00Z');
    markTasksRun(dir, {}, ['system-health'], t0);
    const state = loadTaskState(dir);
    expect(state['system-health']).toBe(t0.toISOString());
    // The written file is valid JSON.
    const raw = readFileSync(join(dir, 'memory', 'heartbeat-task-state.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('E2E-4: a file with no frontmatter yields no tasks (all-due fallback)', () => {
    writeFileSync(hbFile, '# Heartbeat\n\njust a log, no frontmatter\n', 'utf8');
    const { tasks, dueNames } = getHeartbeatDueTasks(hbFile, dir, new Date());
    expect(tasks).toEqual([]);
    expect(dueNames).toEqual([]);
  });
});
