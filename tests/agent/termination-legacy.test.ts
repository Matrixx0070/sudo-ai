/**
 * Tests for runTerminationLegacy — Wave 6D Builder A.
 *
 * Covers A-1 through A-8 from the Wave 6D spec section 5 (Builder A).
 * All FS writes are spied on (no real disk I/O).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// FS spy setup — intercept before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import {
  runTerminationLegacy,
  type LegacySnapshot,
  type TerminationLegacyDeps,
} from '../../src/core/agent/termination-legacy.js';

// ---------------------------------------------------------------------------
// Mock GoalEngineV2 helpers
// ---------------------------------------------------------------------------

function makeGoal(overrides: Partial<{
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  progress: number;
  lastWorkedAt: string;
  createdAt: string;
  milestones: Array<{ id: string; description: string; completed: boolean }>;
}> = {}): ReturnType<typeof Object.assign> {
  return {
    id: overrides.id ?? 'goal-1',
    title: overrides.title ?? 'Test Goal',
    description: overrides.description ?? 'A test goal',
    priority: overrides.priority ?? 'normal',
    status: overrides.status ?? 'sleeping',
    progress: overrides.progress ?? 50,
    lastWorkedAt: overrides.lastWorkedAt ?? '2026-04-10T12:00:00.000Z',
    createdAt: overrides.createdAt ?? '2026-04-01T00:00:00.000Z',
    milestones: overrides.milestones ?? [],
  };
}

function makeMockEngine(overrides: {
  sleepGoals?: ReturnType<typeof makeGoal>[];
  activeGoals?: ReturnType<typeof makeGoal>[];
  listGoalsError?: Error;
} = {}): TerminationLegacyDeps['goalEngine'] {
  return {
    listGoals: vi.fn((filter?: { status?: string | string[] }) => {
      if (overrides.listGoalsError) throw overrides.listGoalsError;
      const statuses = Array.isArray(filter?.status)
        ? filter.status
        : filter?.status
          ? [filter.status]
          : [];
      const isActive = statuses.includes('active') && statuses.length === 1;
      if (isActive) {
        return overrides.activeGoals ?? [];
      }
      return overrides.sleepGoals ?? [];
    }),
  } as unknown as TerminationLegacyDeps['goalEngine'];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('runTerminationLegacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // A-1: Returns LegacySnapshot with correct sessionsScanned count
  // -------------------------------------------------------------------------

  it('A-1: returns LegacySnapshot with correct sessionsScanned count', async () => {
    const sleepGoals = [makeGoal({ id: 'g1' }), makeGoal({ id: 'g2' }), makeGoal({ id: 'g3' })];
    const engine = makeMockEngine({ sleepGoals });

    const result: LegacySnapshot = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.sessionsScanned).toBe(3);
    expect(result).toHaveProperty('capturedAt');
    expect(result).toHaveProperty('legacyFilePath');
    expect(result).toHaveProperty('pendingFilePath');
  });

  // -------------------------------------------------------------------------
  // A-2: insights has one entry per session
  // -------------------------------------------------------------------------

  it('A-2: insights has one entry per session', async () => {
    const sleepGoals = [
      makeGoal({ id: 'g1', title: 'Alpha', progress: 80 }),
      makeGoal({ id: 'g2', title: 'Beta', progress: 40 }),
    ];
    const engine = makeMockEngine({ sleepGoals });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.insights).toHaveLength(2);
    expect(result.insights[0]).toContain('Alpha');
    expect(result.insights[0]).toContain('80%');
    expect(result.insights[1]).toContain('Beta');
    expect(result.insights[1]).toContain('40%');
  });

  // -------------------------------------------------------------------------
  // A-3: Atomic write — writeFileSync then renameSync called in order
  // -------------------------------------------------------------------------

  it('A-3: atomic write calls writeFileSync then renameSync in order', async () => {
    const engine = makeMockEngine({
      sleepGoals: [makeGoal({ id: 'g1' })],
      activeGoals: [makeGoal({ id: 'g2', status: 'active' })],
    });

    const callOrder: string[] = [];
    vi.mocked(fs.writeFileSync).mockImplementation(() => { callOrder.push('write'); });
    vi.mocked(fs.renameSync).mockImplementation(() => { callOrder.push('rename'); });

    await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    // Expect: write, rename, write, rename (legacy.md then pending-for-human.md)
    expect(callOrder).toEqual(['write', 'rename', 'write', 'rename']);
  });

  // -------------------------------------------------------------------------
  // A-4: deferredGoals contains all active goals
  // -------------------------------------------------------------------------

  it('A-4: deferredGoals contains all active goals', async () => {
    const activeGoals = [
      makeGoal({ id: 'a1', title: 'Active One', status: 'active', priority: 'high', progress: 20 }),
      makeGoal({ id: 'a2', title: 'Active Two', status: 'active', priority: 'low', progress: 5 }),
    ];
    const engine = makeMockEngine({ activeGoals });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.deferredGoals).toHaveLength(2);
    expect(result.deferredGoals[0]?.id).toBe('a1');
    expect(result.deferredGoals[1]?.id).toBe('a2');
    expect(result.deferredGoals[0]?.priority).toBe('high');
  });

  // -------------------------------------------------------------------------
  // A-5: Empty session list — no throw, sessionsScanned: 0
  // -------------------------------------------------------------------------

  it('A-5: empty session list → no throw, sessionsScanned: 0', async () => {
    const engine = makeMockEngine({ sleepGoals: [], activeGoals: [] });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.sessionsScanned).toBe(0);
    expect(result.insights).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // A-6: Empty active goals — no throw, deferredGoals: []
  // -------------------------------------------------------------------------

  it('A-6: empty active goals → no throw, deferredGoals: []', async () => {
    const sleepGoals = [makeGoal({ id: 'g1' })];
    const engine = makeMockEngine({ sleepGoals, activeGoals: [] });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.deferredGoals).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // A-7: dataDir option overrides default data/ path
  // -------------------------------------------------------------------------

  it('A-7: dataDir option overrides default path (within safe root)', async () => {
    const engine = makeMockEngine({ sleepGoals: [], activeGoals: [] });
    const safeSubDir = path.resolve(process.cwd(), 'data', 'custom-subdir');

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: safeSubDir,
    });

    expect(result.legacyFilePath).toContain(safeSubDir);
    expect(result.pendingFilePath).toContain(safeSubDir);
  });

  // -------------------------------------------------------------------------
  // A-8: FS error caught; function still returns snapshot
  // -------------------------------------------------------------------------

  it('A-8: FS error is caught and function returns snapshot', async () => {
    const engine = makeMockEngine({
      sleepGoals: [makeGoal({ id: 'g1' })],
      activeGoals: [],
    });

    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    let result: LegacySnapshot | undefined;
    await expect(async () => {
      result = await runTerminationLegacy({
        goalEngine: engine,
        dataDir: path.resolve(process.cwd(), 'data'),
      });
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(result?.sessionsScanned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Additional: insights suffix tests and milestone detection
// ---------------------------------------------------------------------------

describe('runTerminationLegacy — insight suffixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends "all milestones met" when all milestones completed', async () => {
    const sleepGoals = [
      makeGoal({
        id: 'g1',
        title: 'Done Goal',
        progress: 100,
        status: 'completed',
        milestones: [
          { id: 'm1', description: 'Task A', completed: true },
          { id: 'm2', description: 'Task B', completed: true },
        ],
      }),
    ];
    const engine = makeMockEngine({ sleepGoals });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.insights[0]).toContain('all milestones met');
  });

  it('appends "low-progress goal — review priority" when progress < 10 and not completed', async () => {
    const sleepGoals = [
      makeGoal({ id: 'g1', title: 'Lazy Goal', progress: 5, status: 'sleeping' }),
    ];
    const engine = makeMockEngine({ sleepGoals });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.insights[0]).toContain('low-progress goal — review priority');
  });

  it('goal engine throw is non-fatal — returns snapshot with 0 sessions', async () => {
    const engine = makeMockEngine({ listGoalsError: new Error('DB offline') });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: path.resolve(process.cwd(), 'data'),
    });

    expect(result.sessionsScanned).toBe(0);
    expect(result.deferredGoals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Security: path traversal guard
// ---------------------------------------------------------------------------

describe('runTerminationLegacy — path traversal guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SEC-1: dataDir outside safe root returns empty snapshot with no files written', async () => {
    const engine = makeMockEngine({
      sleepGoals: [makeGoal({ id: 'g1' })],
      activeGoals: [makeGoal({ id: 'a1', status: 'active' })],
    });

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: '/etc/evil',
    });

    expect(result.sessionsScanned).toBe(0);
    expect(result.insights).toEqual([]);
    expect(result.deferredGoals).toEqual([]);
    expect(result.legacyFilePath).toBe('');
    expect(result.pendingFilePath).toBe('');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('SEC-2: safe dataDir (within data/ root) proceeds normally', async () => {
    const engine = makeMockEngine({
      sleepGoals: [makeGoal({ id: 'g1' }), makeGoal({ id: 'g2' })],
      activeGoals: [makeGoal({ id: 'a1', status: 'active' })],
    });
    const safeDir = path.resolve(process.cwd(), 'data');

    const result = await runTerminationLegacy({
      goalEngine: engine,
      dataDir: safeDir,
    });

    expect(result.sessionsScanned).toBe(2);
    expect(result.legacyFilePath).toContain(safeDir);
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.mkdirSync).toHaveBeenCalled();
  });
});
