/**
 * Tests for self-build orchestrator — Wave SelfBuild Builder I.
 *
 * Covers all 10 return paths plus supplemental edge cases.
 * Uses mocks for execSync, fs, and agentLoop — no real git operations.
 *
 * Test IDs:
 *   SB-01 disabled (mode unset)
 *   SB-02 killed (DISABLE=1)
 *   SB-03 halted (state.halted=true)
 *   SB-04 align-low (null score)
 *   SB-05 align-low (score below threshold)
 *   SB-06 budget-exceeded
 *   SB-07 mistake-blocked
 *   SB-08 wrong-branch
 *   SB-09 dirty-state (cleanup fails)
 *   SB-10 no-action (agent makes no changes)
 *   SB-11 test-fail-reverted (tsc fails)
 *   SB-12 test-fail-reverted (vitest fails)
 *   SB-13 test-fail-reverted (test count regression)
 *   SB-14 protected-path-reverted
 *   SB-15 committed (happy path)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockedFunction,
} from 'vitest';
import Database from 'better-sqlite3';

// ---- Mock child_process before importing orchestrator ----
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// ---- Mock fs operations to avoid real disk I/O ----
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    realpathSync: vi.fn((p: string) => p),
  };
});

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';

import {
  runSelfBuildTick,
  type SelfBuildDeps,
} from '../../src/core/self-build/orchestrator.js';
import { PROTECTED_PATHS } from '../../src/core/self-build/protected-paths.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockedExecSync = execSync as MockedFunction<typeof execSync>;
const mockedReadFileSync = readFileSync as MockedFunction<typeof readFileSync>;
const mockedExistsSync = existsSync as MockedFunction<typeof existsSync>;
const mockedWriteFileSync = writeFileSync as MockedFunction<typeof writeFileSync>;
const mockedRealpathSync = realpathSync as MockedFunction<typeof realpathSync>;

/**
 * Build an in-memory SQLite database with the cost tables. api_costs is created
 * empty to mirror prod (the legacy table exists but is never written or read);
 * real spend goes into api_call_log, which queryDailySpend reads.
 */
function buildTestDb(dailySpendUsd = 0): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_costs (
      id INTEGER PRIMARY KEY,
      cost_usd REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_call_log (
      id INTEGER PRIMARY KEY,
      estimated_cost_usd REAL NOT NULL,
      called_at TEXT NOT NULL
    );
  `);
  if (dailySpendUsd > 0) {
    // Real spend lives in api_call_log (ISO called_at) — the table
    // queryDailySpend reads; the legacy api_costs table is left empty.
    db.prepare(
      `INSERT INTO api_call_log (estimated_cost_usd, called_at) VALUES (?, ?)`,
    ).run(dailySpendUsd, new Date().toISOString());
  }
  return db;
}

/** Build a minimal SelfBuildDeps object. All optional fields set to null. */
function buildDeps(overrides: Partial<SelfBuildDeps> = {}): SelfBuildDeps {
  return {
    agentLoop: {
      run: vi.fn().mockResolvedValue({ text: 'improved test coverage' }),
    },
    mindDb: buildTestDb(),
    alignmentAggregator: {
      getLastReport: vi.fn().mockReturnValue({ score: 0.85 }),
    },
    mistakeAutoBlockGuard: {
      decide: vi.fn().mockReturnValue({ verdict: 'PASS' }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    gitCwd: '/fake/project',
    ...overrides,
  };
}

/**
 * Set execSync to return specific outputs per command.
 * Commands not in the map return empty string.
 */
function setupExecSyncResponses(
  responses: Record<string, { stdout?: string; exitCode?: number }>,
): void {
  mockedExecSync.mockImplementation((cmd: string) => {
    const key = Object.keys(responses).find((k) => String(cmd).includes(k));
    if (!key) return '' as unknown as Buffer;
    const resp = responses[key];
    if (resp.exitCode && resp.exitCode !== 0) {
      const err = new Error(`Command failed: ${cmd}`) as NodeJS.ErrnoException & { status?: number; stdout?: string };
      err.status = resp.exitCode;
      err.stdout = resp.stdout ?? '';
      throw err;
    }
    return (resp.stdout ?? '') as unknown as Buffer;
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default env: mode disabled
  delete process.env['SUDO_SELF_BUILD_MODE'];
  delete process.env['SUDO_SELF_BUILD_DISABLE'];
  delete process.env['SUDO_SELF_BUILD_MIN_ALIGN_SCORE'];
  delete process.env['SUDO_DAILY_LLM_BUDGET_USD'];
  delete process.env['SUDO_SELF_BUILD_MAX_ITERATIONS'];

  // Default: state file doesn't exist
  mockedExistsSync.mockReturnValue(false);

  // Default: realpathSync returns path unchanged (no symlinks)
  mockedRealpathSync.mockImplementation((p: unknown) => p as string);
});

afterEach(() => {
  delete process.env['SUDO_SELF_BUILD_MODE'];
  delete process.env['SUDO_SELF_BUILD_DISABLE'];
});

// ---------------------------------------------------------------------------
// SB-01: disabled — SUDO_SELF_BUILD_MODE not set
// ---------------------------------------------------------------------------
describe('SB-01 disabled', () => {
  it('returns status=disabled when mode env is unset', async () => {
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('disabled');
    expect(deps.agentLoop.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SB-02: killed — SUDO_SELF_BUILD_DISABLE=1
// ---------------------------------------------------------------------------
describe('SB-02 killed', () => {
  it('returns status=killed when kill-switch is set', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_SELF_BUILD_DISABLE'] = '1';
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('killed');
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SB-03: halted — state.halted=true
// ---------------------------------------------------------------------------
describe('SB-03 halted', () => {
  it('returns status=halted when state file shows halted=true', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const haltedState = JSON.stringify({
      halted: true,
      haltReason: 'S3: 3 consecutive no-commit ticks',
      consecutiveNoCommitTicks: 3,
      consecutiveGateAbortTicks: 0,
      lastCommitHash: null,
      lastTickAt: null,
      priorTestCount: 0,
      haltedAt: '2026-04-21T00:00:00.000Z',
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(haltedState as unknown as Buffer);
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('halted');
    expect(result.message).toContain('S3');
  });
});

// ---------------------------------------------------------------------------
// SB-04: align-low — null score
// ---------------------------------------------------------------------------
describe('SB-04 align-low (null score)', () => {
  it('returns status=align-low when aggregator returns null', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const deps = buildDeps({
      alignmentAggregator: { getLastReport: vi.fn().mockReturnValue(null) },
    });
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('align-low');
    expect(result.alignScore).toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SB-05: align-low — score below threshold
// ---------------------------------------------------------------------------
describe('SB-05 align-low (score below threshold)', () => {
  it('returns status=align-low when score is below min', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_SELF_BUILD_MIN_ALIGN_SCORE'] = '0.7';
    const deps = buildDeps({
      alignmentAggregator: { getLastReport: vi.fn().mockReturnValue({ score: 0.55 }) },
    });
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('align-low');
    expect(result.alignScore).toBe(0.55);
  });
});

// ---------------------------------------------------------------------------
// SB-06: budget-exceeded
// ---------------------------------------------------------------------------
describe('SB-06 budget-exceeded', () => {
  it('returns status=budget-exceeded when daily spend >= cap', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = '10';
    const deps = buildDeps({
      mindDb: buildTestDb(15), // $15 spent, cap $10
    });
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('budget-exceeded');
    expect(result.budgetUsdToday).toBeGreaterThanOrEqual(10);
  });

  it('does NOT abort on spend when SUDO_DAILY_LLM_BUDGET_USD=off (gate disabled)', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = 'off';
    const deps = buildDeps({
      mindDb: buildTestDb(999), // far above the $20 default — would trip any finite cap
      // BLOCK at the very next gate proves execution got PAST the (disabled) budget gate.
      mistakeAutoBlockGuard: { decide: vi.fn().mockReturnValue({ verdict: 'BLOCK' }) },
    });
    const result = await runSelfBuildTick(deps);
    expect(result.status).not.toBe('budget-exceeded');
    expect(result.status).toBe('mistake-blocked');
    expect(result.budgetUsdToday).toBe(999); // spend computed, just not gated
  });
});

// ---------------------------------------------------------------------------
// SB-07: mistake-blocked
// ---------------------------------------------------------------------------
describe('SB-07 mistake-blocked', () => {
  it('returns status=mistake-blocked when guard returns BLOCK', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const deps = buildDeps({
      mistakeAutoBlockGuard: {
        decide: vi.fn().mockReturnValue({ verdict: 'BLOCK' }),
      },
    });
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('mistake-blocked');
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SB-08: wrong-branch
// ---------------------------------------------------------------------------
describe('SB-08 wrong-branch', () => {
  it('returns status=wrong-branch when not on self-build branch', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    setupExecSyncResponses({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n', exitCode: 0 },
    });
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('wrong-branch');
    expect(result.message).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// SB-09: dirty-state — cleanup fails
// ---------------------------------------------------------------------------
describe('SB-09 dirty-state', () => {
  it('returns status=dirty-state when tree remains dirty after cleanup', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) return 'M some-file.ts\n' as unknown as Buffer;
      if (cmdStr.includes('git checkout -- .')) return '' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('dirty-state');
  });
});

// ---------------------------------------------------------------------------
// SB-10: no-action — agent makes no changes
// ---------------------------------------------------------------------------
describe('SB-10 no-action', () => {
  it('returns status=no-action when git status is clean after agent turn', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    let gitStatusCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) {
        gitStatusCallCount++;
        // First call: clean (pre-agent), second call: clean (post-agent)
        return '' as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    const deps = buildDeps({
      agentLoop: { run: vi.fn().mockResolvedValue({ text: 'no changes made' }) },
    });
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('no-action');
  });
});

// ---------------------------------------------------------------------------
// SB-11: test-fail-reverted — tsc fails
// ---------------------------------------------------------------------------
describe('SB-11 test-fail-reverted (tsc fails)', () => {
  it('reverts and returns test-fail-reverted when tsc exits non-zero', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    let statusCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) {
        statusCallCount++;
        // call 1: gate-8 pre-agent check → clean (no dirty cleanup needed)
        // call 2+: post-agent check → dirty (agent made changes)
        return statusCallCount === 1 ? '' as unknown as Buffer : 'M src/some-file.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('tsc --noEmit')) {
        const err = new Error('tsc error') as NodeJS.ErrnoException & { status?: number; stdout?: string };
        err.status = 1;
        err.stdout = 'error TS2345: Argument of type ...';
        throw err;
      }
      if (cmdStr.includes('git diff --name-only') && !cmdStr.includes('--cached')) {
        return 'src/some-file.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('ls-files')) return '' as unknown as Buffer;
      if (cmdStr.includes('git checkout -- .')) return '' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('test-fail-reverted');
    expect(result.message).toContain('tsc');
  });
});

// ---------------------------------------------------------------------------
// SB-12: test-fail-reverted — vitest fails
// ---------------------------------------------------------------------------
describe('SB-12 test-fail-reverted (vitest fails)', () => {
  it('reverts and returns test-fail-reverted when vitest exits non-zero', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    let statusCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) {
        statusCallCount++;
        // call 1: pre-agent clean; call 2+: post-agent dirty
        return statusCallCount === 1 ? '' as unknown as Buffer : 'M src/some-file.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('tsc --noEmit')) return '' as unknown as Buffer;
      if (cmdStr.includes('vitest run')) {
        const err = new Error('vitest failed') as NodeJS.ErrnoException & { status?: number; stdout?: string };
        err.status = 1;
        err.stdout = '1 test failed';
        throw err;
      }
      if (cmdStr.includes('git diff --name-only') && !cmdStr.includes('--cached')) {
        return 'src/some-file.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('ls-files')) return '' as unknown as Buffer;
      if (cmdStr.includes('git checkout -- .')) return '' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('test-fail-reverted');
    expect(result.message).toContain('vitest');
  });
});

// ---------------------------------------------------------------------------
// SB-13: test-fail-reverted — test count regression
// ---------------------------------------------------------------------------
describe('SB-13 test-fail-reverted (test count regression)', () => {
  it('reverts when new test count is less than prior count', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    // State with priorTestCount=100
    const stateWithCount = JSON.stringify({
      halted: false,
      haltReason: '',
      consecutiveNoCommitTicks: 0,
      consecutiveGateAbortTicks: 0,
      lastCommitHash: null,
      lastTickAt: null,
      priorTestCount: 100,
      haltedAt: null,
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(stateWithCount as unknown as Buffer);

    let statusCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) {
        statusCallCount++;
        // call 1: pre-agent clean; call 2+: post-agent dirty
        return statusCallCount === 1 ? '' as unknown as Buffer : 'M src/some-file.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('tsc --noEmit')) return '' as unknown as Buffer;
      if (cmdStr.includes('vitest run')) {
        // Returns stdout showing only 90 tests pass (regression from 100)
        return '90 passed' as unknown as Buffer;
      }
      if (cmdStr.includes('git diff --name-only') && !cmdStr.includes('--cached')) {
        return 'src/some-file.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('ls-files')) return '' as unknown as Buffer;
      if (cmdStr.includes('git checkout -- .')) return '' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('test-fail-reverted');
    expect(result.message).toMatch(/regression/i);
  });
});

// ---------------------------------------------------------------------------
// SB-14: protected-path-reverted
// ---------------------------------------------------------------------------
describe('SB-14 protected-path-reverted', () => {
  it('reverts and halts when agent modifies a protected path', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    let statusCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) {
        statusCallCount++;
        // post-agent: dirty (agent made changes)
        return statusCallCount <= 1 ? '' as unknown as Buffer : 'M src/core/self-build/orchestrator.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('git diff --name-only') && !cmdStr.includes('--cached')) {
        return 'src/core/self-build/orchestrator.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('ls-files')) return '' as unknown as Buffer;
      if (cmdStr.includes('git checkout -- .')) return '' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('protected-path-reverted');
    expect(result.message).toContain('src/core/self-build/');
  });
});

// ---------------------------------------------------------------------------
// SB-15: committed — happy path
// ---------------------------------------------------------------------------
describe('SB-15 committed (happy path)', () => {
  it('commits successfully and returns commitSha on clean run', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    let statusCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) {
        statusCallCount++;
        // pre-agent: clean; post-agent: dirty (agent made change); recheck still clean after git add
        if (statusCallCount === 1) return '' as unknown as Buffer;
        return 'M src/core/some-module.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('tsc --noEmit')) return '' as unknown as Buffer;
      if (cmdStr.includes('vitest run')) return '3616 passed (3616)' as unknown as Buffer;
      if (cmdStr.includes('git diff --name-only') && !cmdStr.includes('--cached')) {
        return 'src/core/some-module.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('ls-files')) return '' as unknown as Buffer;
      if (cmdStr.includes('git add -A')) return '' as unknown as Buffer;
      if (cmdStr.includes('git diff --cached --name-only')) {
        return 'src/core/some-module.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('git commit -m')) return 'master 1234567 self-build: improved test coverage' as unknown as Buffer;
      if (cmdStr.includes('git show --name-only HEAD')) {
        return 'commit abc1234\nAuthor: SUDO-AI\n\nself-build: improved test coverage\n\nsrc/core/some-module.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('git rev-parse HEAD')) return 'abc1234def5678\n' as unknown as Buffer;
      if (cmdStr.includes('git checkout -- .')) return '' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    const deps = buildDeps({
      agentLoop: {
        run: vi.fn().mockResolvedValue({ text: 'improved test coverage\nsome details' }),
      },
    });
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('committed');
    expect(result.commitSha).toBe('abc1234def5678');
    expect(result.alignScore).toBe(0.85);
    expect(result.budgetUsdToday).toBe(0);
    // Verify journal write was attempted
    expect(mockedWriteFileSync).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SB-16: halt-latch persists — S4 fires on 3rd consecutive gate-abort tick
// ---------------------------------------------------------------------------
describe('SB-16 halt-latch persists on S4 stop condition', () => {
  it('persists halted=true to state.json when consecutiveGateAbortTicks reaches threshold', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    // State shows 2 prior gate-abort ticks (one more triggers S4)
    const stateWith2Aborts = JSON.stringify({
      halted: false,
      haltReason: '',
      consecutiveNoCommitTicks: 0,
      consecutiveGateAbortTicks: 2,
      lastCommitHash: null,
      lastTickAt: null,
      priorTestCount: 3601,
      haltedAt: null,
    });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(stateWith2Aborts as unknown as Buffer);

    // Trigger an alignment abort (score below threshold) → 3rd consecutive gate-abort → S4 halt
    // Note: null score is treated as warming-up and does NOT increment consecutiveGateAbortTicks
    const deps = buildDeps({
      alignmentAggregator: { getLastReport: vi.fn().mockReturnValue({ score: 0.55 }) },
    });

    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('align-low');

    // Verify that writeFileSync was called with halted=true in the JSON
    const writeCalls = mockedWriteFileSync.mock.calls;
    const stateWriteCall = writeCalls.find(([, content]) =>
      typeof content === 'string' && content.includes('"halted": true'),
    );
    expect(stateWriteCall).toBeDefined();
    if (stateWriteCall) {
      const written = JSON.parse(stateWriteCall[1] as string) as {
        halted: boolean;
        consecutiveGateAbortTicks: number;
      };
      expect(written.halted).toBe(true);
      expect(written.consecutiveGateAbortTicks).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// SB-07b: mistake-blocked — guard THROWS → fail-closed
// ---------------------------------------------------------------------------
describe('SB-07b mistake-blocked (guard throws → fail-closed)', () => {
  it('returns status=mistake-blocked when guard throws instead of returning verdict', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const deps = buildDeps({
      mistakeAutoBlockGuard: {
        decide: vi.fn().mockImplementation(() => { throw new Error('guard internal error'); }),
      },
    });
    const result = await runSelfBuildTick(deps);
    // Was fail-open (would continue), now fail-closed → must be mistake-blocked
    expect(result.status).toBe('mistake-blocked');
    expect(deps.logger.warn).toHaveBeenCalled();
    expect(result.message).toMatch(/guard threw/i);
  });
});

// ---------------------------------------------------------------------------
// SB-14b: protected-path-reverted — symlinked path resolves to protected
// ---------------------------------------------------------------------------
describe('SB-14b protected-path-reverted (symlink resolved)', () => {
  it('reverts and halts when a symlinked file resolves to a protected path', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    let statusCallCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('rev-parse --abbrev-ref HEAD')) return 'self-build\n' as unknown as Buffer;
      if (cmdStr.includes('git status --porcelain')) {
        statusCallCount++;
        return statusCallCount <= 1 ? '' as unknown as Buffer : 'M src/symlink-to-protected.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('git diff --name-only') && !cmdStr.includes('--cached')) {
        return 'src/symlink-to-protected.ts\n' as unknown as Buffer;
      }
      if (cmdStr.includes('ls-files')) return '' as unknown as Buffer;
      if (cmdStr.includes('git checkout -- .')) return '' as unknown as Buffer;
      if (cmdStr.includes('git clean -fd')) return '' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    // Simulate symlink: raw path is innocuous, resolved path is protected
    mockedRealpathSync.mockImplementation((p: unknown) => {
      const pStr = p as string;
      if (pStr.endsWith('symlink-to-protected.ts')) {
        return pStr.replace('src/symlink-to-protected.ts', 'src/core/self-build/orchestrator.ts');
      }
      return pStr;
    });
    const deps = buildDeps();
    const result = await runSelfBuildTick(deps);
    expect(result.status).toBe('protected-path-reverted');
  });
});

// ---------------------------------------------------------------------------
// SB-MEDIUM2: queryDailySpend fails-closed when tables are missing
// ---------------------------------------------------------------------------
describe('SB-MEDIUM2 budget gate fails-closed on missing tables', () => {
  it('returns budget-exceeded when DB has missing tables (returns Infinity)', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = '10';
    // Create DB with NO tables — simulates agent dropping tables
    const emptyDb = new Database(':memory:');
    const deps = buildDeps({ mindDb: emptyDb });
    const result = await runSelfBuildTick(deps);
    // Infinity >= 10 → budget gate blocks
    expect(result.status).toBe('budget-exceeded');
    expect(result.budgetUsdToday).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// SB-H4: pre-commit hook regex covers all PROTECTED_PATHS entries
// ---------------------------------------------------------------------------
describe('SB-H4 pre-commit hook regex covers all PROTECTED_PATHS entries', () => {
  it('matches every entry in PROTECTED_PATHS', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const hookContent = actualFs.readFileSync(`${process.cwd()}/.githooks/pre-commit`, 'utf8');

    // Extract the protected_re value from the hook
    const match = hookContent.match(/^protected_re='(.+)'$/m);
    expect(match, 'Could not find protected_re= line in pre-commit hook').toBeTruthy();
    const regexSource = match![1];
    const hookRegex = new RegExp(regexSource);

    for (const protectedPath of PROTECTED_PATHS) {
      // Use the path itself or a file inside it (for directory prefixes ending in /)
      const testPath = protectedPath.endsWith('/')
        ? `${protectedPath}some-file.ts`
        : protectedPath;
      expect(
        hookRegex.test(testPath),
        `Hook regex does not match PROTECTED_PATHS entry: "${protectedPath}" (tested as "${testPath}")`,
      ).toBe(true);
    }
  });
});
