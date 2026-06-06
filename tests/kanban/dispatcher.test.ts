/**
 * @file dispatcher.test.ts
 * @description Unit tests for KanbanDispatcher — lifecycle, tick cycle,
 *              reclaim, promote, assign, kill-switch, stats, and config defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KanbanDispatcher } from '../../src/core/kanban/dispatcher.js';
import type { KanbanTask } from '../../src/core/kanban/kanban-types.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeTask(o: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    title: 'Test', body: 'Body', status: 'todo', priority: 3 as const,
    skills: [], workspace: 'scratch',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...o,
  };
}

function mockBoard() {
  return {
    listTasks: vi.fn().mockReturnValue([]),
    moveTask: vi.fn().mockReturnValue(true),
    getTask: vi.fn().mockReturnValue(null),
    updateTask: vi.fn().mockReturnValue(true),
  };
}

function mockSwarm() {
  return {
    listAgents: vi.fn().mockReturnValue([]),
    assignTask: vi.fn().mockReturnValue('a1'),
    getBestAgent: vi.fn().mockReturnValue(null),
    getAgent: vi.fn().mockReturnValue(null),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KanbanDispatcher', () => {
  let board: ReturnType<typeof mockBoard>;
  let swarm: ReturnType<typeof mockSwarm>;
  let envBak: string | undefined;

  beforeEach(() => {
    board = mockBoard();
    swarm = mockSwarm();
    envBak = process.env['SUDO_DISPATCHER_DISABLE'];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (envBak !== undefined) process.env['SUDO_DISPATCHER_DISABLE'] = envBak;
    else delete process.env['SUDO_DISPATCHER_DISABLE'];
  });

  // 1. Start and stop — lifecycle management
  describe('lifecycle', () => {
    it('starts and sets isRunning true', () => {
      const d = new KanbanDispatcher(board, swarm);
      d.start();
      expect(d.getState().isRunning).toBe(true);
      d.stop();
    });

    it('stops and sets isRunning false', () => {
      const d = new KanbanDispatcher(board, swarm);
      d.start();
      d.stop();
      expect(d.getState().isRunning).toBe(false);
    });

    it('ignores double start', () => {
      const d = new KanbanDispatcher(board, swarm);
      d.start();
      d.start();
      expect(d.getState().isRunning).toBe(true);
      d.stop();
    });
  });

  // 2. Tick cycle — runs reclaim + promote + assign
  describe('tick cycle', () => {
    it('runs reclaim + promote + assign in sequence', async () => {
      const d = new KanbanDispatcher(board, swarm);
      await d.tick();
      expect(board.listTasks).toHaveBeenCalledWith({ status: 'in_progress' });
      expect(board.listTasks).toHaveBeenCalledWith({ status: 'todo' });
      expect(swarm.listAgents).toHaveBeenCalledWith({ status: 'idle' });
    });
  });

  // 3. Reclaim stale — moves stale running tasks back to todo
  describe('reclaimStale', () => {
    it('moves stale in_progress tasks back to todo', () => {
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'in_progress'
          ? [makeTask({ id: 't1', status: 'in_progress', updatedAt: new Date(Date.now() - 400_000).toISOString() })]
          : [],
      );
      const d = new KanbanDispatcher(board, swarm, { staleThresholdMs: 300_000 });
      expect(d.reclaimStale()).toBe(1);
      expect(board.moveTask).toHaveBeenCalledWith('t1', 'todo');
    });

    it('skips fresh in_progress tasks', () => {
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'in_progress'
          ? [makeTask({ id: 't2', status: 'in_progress', updatedAt: new Date().toISOString() })]
          : [],
      );
      const d = new KanbanDispatcher(board, swarm, { staleThresholdMs: 300_000 });
      expect(d.reclaimStale()).toBe(0);
      expect(board.moveTask).not.toHaveBeenCalled();
    });
  });

  // 4. Promote ready — moves tasks with met dependencies to ready
  describe('promoteReady', () => {
    it('promotes tasks with met dependencies', () => {
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'todo' ? [makeTask({ id: 'c1', status: 'todo', parentId: 'p1' })] : [],
      );
      board.getTask.mockImplementation((id: string) =>
        id === 'p1' ? makeTask({ id: 'p1', status: 'done' }) : null,
      );
      expect(new KanbanDispatcher(board, swarm).promoteReady()).toBe(1);
    });

    it('skips tasks with unmet dependencies', () => {
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'todo' ? [makeTask({ id: 'c2', status: 'todo', parentId: 'p2' })] : [],
      );
      board.getTask.mockImplementation((id: string) =>
        id === 'p2' ? makeTask({ id: 'p2', status: 'todo' }) : null,
      );
      expect(new KanbanDispatcher(board, swarm).promoteReady()).toBe(0);
    });

    it('promotes tasks with null parentId (no deps)', () => {
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'todo' ? [makeTask({ id: 'c3', status: 'todo', parentId: null })] : [],
      );
      expect(new KanbanDispatcher(board, swarm).promoteReady()).toBe(1);
    });
  });

  // 5. Assign workers — matches idle workers to ready tasks
  describe('assignWorkers', () => {
    it('assigns idle workers to ready tasks', () => {
      const task = makeTask({ id: 't1', status: 'todo', parentId: null, skills: ['coding'] });
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'todo' ? [task] : [],
      );
      board.getTask.mockImplementation((id: string) => id === 't1' ? task : null);
      const agent = { id: 'a1', role: 'coder' };
      swarm.listAgents.mockReturnValue([agent]);
      swarm.getBestAgent.mockReturnValue(agent);
      swarm.getAgent.mockReturnValue(agent);
      const d = new KanbanDispatcher(board, swarm);
      d.promoteReady();
      expect(d.assignWorkers()).toBe(1);
      expect(board.moveTask).toHaveBeenCalledWith('t1', 'in_progress');
      expect(swarm.assignTask).toHaveBeenCalled();
    });

    it('returns 0 when no idle workers', () => {
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'todo' ? [makeTask({ id: 't2', status: 'todo', parentId: null })] : [],
      );
      swarm.listAgents.mockReturnValue([]);
      const d = new KanbanDispatcher(board, swarm);
      d.promoteReady();
      expect(d.assignWorkers()).toBe(0);
    });
  });

  // 6. Kill switch — SUDO_DISPATCHER_DISABLE prevents operation
  describe('kill switch', () => {
    it('prevents start when SUDO_DISPATCHER_DISABLE=1', () => {
      process.env['SUDO_DISPATCHER_DISABLE'] = '1';
      const d = new KanbanDispatcher(board, swarm);
      d.start();
      expect(d.getState().isRunning).toBe(false);
    });

    it('prevents tick phases when disabled', async () => {
      process.env['SUDO_DISPATCHER_DISABLE'] = '1';
      await new KanbanDispatcher(board, swarm).tick();
      expect(board.listTasks).not.toHaveBeenCalled();
    });

    it('prevents reclaimStale when disabled', () => {
      process.env['SUDO_DISPATCHER_DISABLE'] = '1';
      expect(new KanbanDispatcher(board, swarm).reclaimStale()).toBe(0);
    });
  });

  // 7. Stats tracking — correct counts
  describe('stats', () => {
    it('tracks cumulative totals across ticks', async () => {
      board.listTasks.mockImplementation((f: any) =>
        f?.status === 'todo' ? [makeTask({ id: 's1', status: 'todo', parentId: null })] : [],
      );
      board.getTask.mockImplementation((id: string) =>
        id === 's1' ? makeTask({ id: 's1', status: 'todo' }) : null,
      );
      const d = new KanbanDispatcher(board, swarm);
      await d.tick();
      await d.tick();
      const s = d.getStats();
      expect(s.totalTicks).toBe(2);
      expect(s.totalPromoted).toBeGreaterThanOrEqual(1);
    });

    it('starts with zero counts', () => {
      const s = new KanbanDispatcher(board, swarm).getStats();
      expect(s).toMatchObject({
        totalTicks: 0, totalReclaimed: 0, totalPromoted: 0,
        totalAssigned: 0, totalErrors: 0, avgTickTimeMs: 0,
      });
    });
  });

  // 8. Config defaults — default tick interval is 60s
  describe('config defaults', () => {
    it('default tick interval is 60s', () => {
      const d = new KanbanDispatcher(board, swarm);
      board.listTasks.mockReturnValue([]);
      d.start();
      vi.advanceTimersByTime(60_000);
      expect(d.getStats().totalTicks).toBeGreaterThanOrEqual(1);
      d.stop();
    });

    it('accepts custom tick interval', () => {
      const d = new KanbanDispatcher(board, swarm, { tickIntervalMs: 10_000 });
      board.listTasks.mockReturnValue([]);
      d.start();
      vi.advanceTimersByTime(25_000);
      expect(d.getStats().totalTicks).toBeGreaterThanOrEqual(2);
      d.stop();
    });
  });
});