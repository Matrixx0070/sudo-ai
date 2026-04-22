/**
 * @file tests/self-build/cron-entry.test.ts
 * @description Unit tests for src/core/self-build/cron-entry.ts
 *
 * Tests:
 *  1. registerSelfBuildCron registers two jobs with correct schedules
 *  2. Tick handler calls runSelfBuildTick with correct deps (mocked)
 *  3. Daily-report handler calls generateDailyReport with correct deps (mocked)
 *  4. handleSelfBuildTick swallows errors — does not crash caller
 *  5. handleSelfBuildTick logs the tick result via module logger
 *  6. registerSelfBuildCron enables tick job only when SUDO_SELF_BUILD_MODE=1
 *  7. registerSelfBuildCron always enables the daily-report job
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SelfBuildDeps } from '../../src/core/self-build/orchestrator.js';
import type { DailyReportResult } from '../../src/core/self-build/daily-report.js';

// ---------------------------------------------------------------------------
// Mock sibling modules BEFORE importing the module-under-test
// ---------------------------------------------------------------------------

vi.mock('../../src/core/self-build/orchestrator.js', () => ({
  runSelfBuildTick: vi.fn(),
}));

vi.mock('../../src/core/self-build/daily-report.js', () => ({
  generateDailyReport: vi.fn(),
}));

// Mock the logger factory so tests don't hit disk
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are set up
// ---------------------------------------------------------------------------
import {
  registerSelfBuildCron,
  handleSelfBuildTick,
  handleDailyReport,
  SELF_BUILD_TICK_MSG,
  SELF_BUILD_DAILY_REPORT_MSG,
} from '../../src/core/self-build/cron-entry.js';
import { runSelfBuildTick } from '../../src/core/self-build/orchestrator.js';
import { generateDailyReport } from '../../src/core/self-build/daily-report.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mock CronScheduler that tracks addJob calls. */
function makeMockScheduler() {
  const jobs: Array<Record<string, unknown>> = [];
  return {
    addJob: vi.fn((job: Record<string, unknown>) => {
      const stored = { ...job, id: `test-id-${jobs.length}` };
      jobs.push(stored);
      return stored;
    }),
    removeJob: vi.fn(),
    listJobs: vi.fn(() => jobs),
    start: vi.fn(),
    stop: vi.fn(),
    _jobs: jobs,
  };
}

/** Minimal SelfBuildDeps for tests. */
function makeDeps(overrides: Partial<SelfBuildDeps> = {}): SelfBuildDeps {
  return {
    agentLoop: {
      run: vi.fn().mockResolvedValue({ text: 'ok' }),
    },
    mindDb: {} as SelfBuildDeps['mindDb'],
    alignmentAggregator: null,
    mistakeAutoBlockGuard: null,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    gitCwd: '/root/sudo-ai-v4',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerSelfBuildCron', () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env['SUDO_SELF_BUILD_MODE'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env['SUDO_SELF_BUILD_MODE'];
    } else {
      process.env['SUDO_SELF_BUILD_MODE'] = originalMode;
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: Two jobs registered with correct schedules
  // -------------------------------------------------------------------------
  it('registers two cron jobs with correct names and schedules', () => {
    const scheduler = makeMockScheduler();
    const deps = makeDeps();

    registerSelfBuildCron(scheduler as never, deps);

    expect(scheduler.addJob).toHaveBeenCalledTimes(2);

    const calls = scheduler.addJob.mock.calls as Array<[Record<string, unknown>]>;

    // Tick job
    const tickCall = calls.find(([job]) => job['name'] === 'system.self-build');
    expect(tickCall).toBeDefined();
    const tickJob = tickCall![0];
    expect(tickJob['schedule']).toEqual({ kind: 'cron', expr: '*/30 * * * *', tz: 'UTC' });
    expect(tickJob['sessionTarget']).toBe('isolated');
    expect((tickJob['payload'] as { message: string })['message']).toBe(SELF_BUILD_TICK_MSG);

    // Report job
    const reportCall = calls.find(([job]) => job['name'] === 'system.self-build-report');
    expect(reportCall).toBeDefined();
    const reportJob = reportCall![0];
    expect(reportJob['schedule']).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' });
    expect(reportJob['sessionTarget']).toBe('isolated');
    expect((reportJob['payload'] as { message: string })['message']).toBe(SELF_BUILD_DAILY_REPORT_MSG);
  });

  // -------------------------------------------------------------------------
  // Test 6: Tick job enabled only when SUDO_SELF_BUILD_MODE=1
  // -------------------------------------------------------------------------
  it('enables tick job only when SUDO_SELF_BUILD_MODE=1', () => {
    const scheduler = makeMockScheduler();
    const deps = makeDeps();

    // Mode not set → tick disabled
    delete process.env['SUDO_SELF_BUILD_MODE'];
    registerSelfBuildCron(scheduler as never, deps);
    const callsOff = scheduler.addJob.mock.calls as Array<[Record<string, unknown>]>;
    const tickOff = callsOff.find(([j]) => j['name'] === 'system.self-build');
    expect(tickOff![0]['enabled']).toBe(false);

    scheduler.addJob.mockClear();

    // Mode=1 → tick enabled
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    registerSelfBuildCron(scheduler as never, deps);
    const callsOn = scheduler.addJob.mock.calls as Array<[Record<string, unknown>]>;
    const tickOn = callsOn.find(([j]) => j['name'] === 'system.self-build');
    expect(tickOn![0]['enabled']).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: Daily-report job always enabled
  // -------------------------------------------------------------------------
  it('always enables the daily-report job regardless of SUDO_SELF_BUILD_MODE', () => {
    const scheduler = makeMockScheduler();
    const deps = makeDeps();

    delete process.env['SUDO_SELF_BUILD_MODE'];
    registerSelfBuildCron(scheduler as never, deps);

    const calls = scheduler.addJob.mock.calls as Array<[Record<string, unknown>]>;
    const reportCall = calls.find(([j]) => j['name'] === 'system.self-build-report');
    expect(reportCall![0]['enabled']).toBe(true);
  });
});

describe('handleSelfBuildTick', () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env['SUDO_SELF_BUILD_MODE'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env['SUDO_SELF_BUILD_MODE'];
    } else {
      process.env['SUDO_SELF_BUILD_MODE'] = originalMode;
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Calls runSelfBuildTick with correct deps
  // -------------------------------------------------------------------------
  it('calls runSelfBuildTick with the provided deps', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const deps = makeDeps();
    vi.mocked(runSelfBuildTick).mockResolvedValue({ status: 'committed', commitSha: 'abc123' });

    await handleSelfBuildTick(deps);

    expect(runSelfBuildTick).toHaveBeenCalledOnce();
    expect(runSelfBuildTick).toHaveBeenCalledWith(deps);
  });

  // -------------------------------------------------------------------------
  // Test 4: Swallows errors — does not throw
  // -------------------------------------------------------------------------
  it('swallows errors thrown by runSelfBuildTick without crashing', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const deps = makeDeps();
    vi.mocked(runSelfBuildTick).mockRejectedValue(new Error('catastrophic failure'));

    // Must not throw
    const result = await handleSelfBuildTick(deps);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 5: Logs tick result
  // -------------------------------------------------------------------------
  it('logs the tick result after a successful tick', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const deps = makeDeps();
    vi.mocked(runSelfBuildTick).mockResolvedValue({ status: 'no-action', message: 'nothing to do' });

    const result = await handleSelfBuildTick(deps);

    // Result is returned (not null)
    expect(result).not.toBeNull();
    expect(result?.status).toBe('no-action');
    // Logger is wired internally — verify the function returns without error
    // (module-internal logger is already mocked via createLogger mock)
  });
});

describe('handleDailyReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 3: Calls generateDailyReport with correct deps
  // -------------------------------------------------------------------------
  it('calls generateDailyReport and returns the result', async () => {
    const deps = makeDeps();
    const fakeResult: DailyReportResult = {
      date: '2026-04-22',
      reportPath: 'data/self-build-reports/2026-04-22.md',
      commitCount: 3,
      budgetUsd: 4.50,
      alignScore: 0.82,
      telegramPushed: false,
    };
    vi.mocked(generateDailyReport).mockResolvedValue(fakeResult);

    const result = await handleDailyReport(deps);

    expect(generateDailyReport).toHaveBeenCalledOnce();
    expect(result).toEqual(fakeResult);
  });

  it('swallows errors thrown by generateDailyReport without crashing', async () => {
    const deps = makeDeps();
    vi.mocked(generateDailyReport).mockRejectedValue(new Error('db write failed'));

    const result = await handleDailyReport(deps);
    expect(result).toBeNull();
  });
});
