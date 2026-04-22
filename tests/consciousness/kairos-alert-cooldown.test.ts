/**
 * @file tests/consciousness/kairos-alert-cooldown.test.ts
 * @description Wave 2.2e: alert cooldown for Kairos CRITICAL notifications.
 *
 * Tests:
 *   COOLDOWN-1  Two CRITICAL disk_pressure observations fired within 1 minute — notify called once
 *   COOLDOWN-2  After advancing time 7 hours, a third observation fires notify again (total: 2)
 *   COOLDOWN-3  Different severity key (WARN vs CRITICAL) does NOT share the cooldown window
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockNotifyFn,
  mockExecSync,
  mockExistsSync,
  mockAppendFileSync,
  mockInfoFn,
  mockWarnFn,
  mockDebugFn,
  mockErrorFn,
} = vi.hoisted(() => ({
  mockNotifyFn: vi.fn().mockResolvedValue(undefined),
  mockExecSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockAppendFileSync: vi.fn(),
  mockInfoFn: vi.fn(),
  mockWarnFn: vi.fn(),
  mockDebugFn: vi.fn(),
  mockErrorFn: vi.fn(),
}));

// Mock child_process so checkServiceHealth returns a CRITICAL disk_pressure
// when execSync is called with the du command.
vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  execFile: vi.fn(),
}));

// Suppress fs side-effects (log writing, alert file, existsSync checks for data dir)
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: mockExistsSync,
    appendFileSync: mockAppendFileSync,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 0 }),
  };
});

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: mockInfoFn,
    warn: mockWarnFn,
    debug: mockDebugFn,
    error: mockErrorFn,
  }),
}));

// Suppress DB access (checkStaleTasks uses better-sqlite3)
vi.mock('better-sqlite3', () => {
  const MockDb = vi.fn().mockImplementation(() => ({
    prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue({ cnt: 0 }) }),
    close: vi.fn(),
  }));
  return { default: MockDb };
});

// ---------------------------------------------------------------------------
// Subject under test — imported AFTER mocks are registered
// ---------------------------------------------------------------------------

import { Kairos, __resetCooldownForTest } from '../../src/core/consciousness/kairos.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns execSync return values appropriate for each internal call:
 * - TSC check: throws (no tsc bin in test) → caught, returns 0 errors
 * - systemctl MemoryCurrent: returns empty → no RAM alert
 * - du -sb data/: returns 1.2GB → CRITICAL disk_pressure
 * - unused-exports (dead code): returns empty
 * - everything else: returns ''
 */
function configureDiskCritical(): void {
  mockExecSync.mockImplementation((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('du -sb')) {
      // 1,200,000,000 bytes ≈ 1144MB → triggers CRITICAL (>1000MB threshold)
      return '1200000000\t/root/sudo-ai-v4/data';
    }
    // All other execSync calls (tsc, systemctl, etc.) return empty safely
    return '';
  });
  // data dir exists so checkServiceHealth proceeds to the du call
  mockExistsSync.mockImplementation((p: unknown) => {
    return typeof p === 'string' && p.includes('/data');
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Kairos alert cooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    mockNotifyFn.mockClear();
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockAppendFileSync.mockReset();
    __resetCooldownForTest();
    configureDiskCritical();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('COOLDOWN-1: two CRITICAL disk_pressure within 1 minute calls notify exactly once', async () => {
    const kairos = new Kairos({
      enabled: false,
      autonomousActions: false,
      telegramBotToken: 'fake-token',
      telegramChatId: 'fake-chat',
      notifyFn: mockNotifyFn,
    });

    // First observation cycle
    await (kairos as unknown as { observe(): Promise<void> }).observe();
    expect(mockNotifyFn).toHaveBeenCalledTimes(1);

    // Advance 1 minute (well within the 6h cooldown window)
    vi.advanceTimersByTime(60 * 1000);

    // Second cycle — same key, should be suppressed
    await (kairos as unknown as { observe(): Promise<void> }).observe();
    expect(mockNotifyFn).toHaveBeenCalledTimes(1);
  });

  it('COOLDOWN-2: after 7 hours the same observation fires notify again (total: 2)', async () => {
    const kairos = new Kairos({
      enabled: false,
      autonomousActions: false,
      telegramBotToken: 'fake-token',
      telegramChatId: 'fake-chat',
      notifyFn: mockNotifyFn,
    });

    // First cycle fires
    await (kairos as unknown as { observe(): Promise<void> }).observe();
    expect(mockNotifyFn).toHaveBeenCalledTimes(1);

    // Advance 7 hours — past the 6h cooldown
    vi.advanceTimersByTime(7 * 60 * 60 * 1000);

    // Third observation — cooldown expired, should fire again
    await (kairos as unknown as { observe(): Promise<void> }).observe();
    expect(mockNotifyFn).toHaveBeenCalledTimes(2);
  });

  it('COOLDOWN-3: WARN severity key is independent from CRITICAL cooldown', async () => {
    // Reconfigure execSync to return ~600MB (WARN, not CRITICAL)
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('du -sb')) {
        // 600MB → WARN threshold (>500MB but <=1000MB)
        return '629145600\t/root/sudo-ai-v4/data';
      }
      return '';
    });

    const kairos = new Kairos({
      enabled: false,
      autonomousActions: false,
      telegramBotToken: 'fake-token',
      telegramChatId: 'fake-chat',
      notifyFn: mockNotifyFn,
    });

    // WARN severity does NOT trigger the CRITICAL notify block — so 0 calls
    await (kairos as unknown as { observe(): Promise<void> }).observe();
    expect(mockNotifyFn).toHaveBeenCalledTimes(0);

    // Now switch back to CRITICAL — should fire independently (no shared cooldown state)
    configureDiskCritical();
    await (kairos as unknown as { observe(): Promise<void> }).observe();
    expect(mockNotifyFn).toHaveBeenCalledTimes(1);
  });
});
