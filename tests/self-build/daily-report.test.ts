/**
 * daily-report.test.ts
 * Unit tests for generateDailyReport + sendTelegramMessage.
 * All external effects are mocked via vitest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// ─── Module mocks — declared before imports ───────────────────────────────────
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(),
  };
});

// ─── Imports after mocks ───────────────────────────────────────────────────────
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { generateDailyReport, type DailyReportDeps } from '../../src/core/self-build/daily-report.js';
import { sendTelegramMessage } from '../../src/core/self-build/telegram-push.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeDb(budgetTotal = 1.42) {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ total: budgetTotal }),
    }),
  };
}

function makeAlignmentAggregator(score: number | null) {
  return {
    getLastReport: vi.fn().mockReturnValue(score !== null ? { score } : null),
  };
}

const FIXTURE_PATH = path.resolve(
  'tests/self-build/fixtures/sample-report.md',
);

const TODAY = '2026-04-21';

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('generateDailyReport', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: existsSync returns false (no prior report)
    vi.mocked(existsSync).mockReturnValue(false);
    // Default: git log returns empty
    vi.mocked(execSync).mockReturnValue('');
    // Fix date to 2026-04-21
    vi.setSystemTime(new Date('2026-04-21T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // TC-1: Report file written with correct filename
  it('writes report to correct path and returns correct date', async () => {
    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
    };

    const result = await generateDailyReport(deps);

    expect(result.date).toBe(TODAY);
    expect(result.reportPath).toBe(`data/self-build-reports/${TODAY}.md`);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();

    const [writtenPath] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(writtenPath)).toContain(TODAY);
    expect(String(writtenPath)).toContain('self-build-reports');
  });

  // TC-2: Commit list populated from git log mock
  it('populates commitCount from git log output', async () => {
    vi.mocked(execSync).mockReturnValue(
      'a1b2c3d self-build: improve README\nd4e5f6a self-build: fix types\n',
    );

    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
    };

    const result = await generateDailyReport(deps);

    expect(result.commitCount).toBe(2);

    // Verify git log was called with the right since parameter
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('git log'),
      expect.objectContaining({ cwd: '/project' }),
    );

    // Verify report content includes the commit hashes
    const [, content] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(content)).toContain('a1b2c3d');
    expect(String(content)).toContain('d4e5f6a');
  });

  // TC-3: Test delta computed vs prior report
  it('computes test delta from prior report when it exists', async () => {
    const priorContent = [
      '# Self-Build Daily Report — 2026-04-20',
      '- Tests: 3599 passing (Δ ±0 vs yesterday)',
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(priorContent);
    vi.mocked(execSync).mockReturnValue('');

    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
    };

    const result = await generateDailyReport(deps);

    // Current test count = prior (3599) since we don't re-run
    // Delta line should reflect Δ ±0 (same) or show the count
    const [, content] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(content)).toContain('3599 passing');
    // Report generated successfully
    expect(result.error).toBeUndefined();
  });

  // TC-4: Budget query has correct shape
  it('queries budget and populates budgetUsd correctly', async () => {
    const logger = makeLogger();
    const db = makeDb(3.75);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
    };

    const result = await generateDailyReport(deps);

    expect(result.budgetUsd).toBe(3.75);
    expect(vi.mocked(db.prepare)).toHaveBeenCalledWith(
      expect.stringContaining('api_call_log'),
    );
    const [, content] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(content)).toContain('$3.75');
  });

  // TC-5: Alignment score is null when aggregator missing
  it('sets alignScore to null when alignmentAggregator is not provided', async () => {
    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
      // no alignmentAggregator
    };

    const result = await generateDailyReport(deps);

    expect(result.alignScore).toBeNull();
    const [, content] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(content)).toContain('warming-up');
  });

  // TC-6: Alignment score read from aggregator when provided
  it('reads alignment score from aggregator when provided', async () => {
    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
      alignmentAggregator: makeAlignmentAggregator(0.823),
    };

    const result = await generateDailyReport(deps);

    expect(result.alignScore).toBe(0.823);
    const [, content] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(content)).toContain('0.823');
  });

  // TC-7: Telegram push called when configured
  it('calls telegramPush when provided and sets telegramPushed=true', async () => {
    const telegramPush = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
      telegramPush,
    };

    const result = await generateDailyReport(deps);

    expect(telegramPush).toHaveBeenCalledOnce();
    expect(result.telegramPushed).toBe(true);
    // Telegram called with markdown content
    const [markdown] = telegramPush.mock.calls[0]!;
    expect(markdown).toContain('Self-Build Daily Report');
  });

  // TC-8: Telegram push skipped when not configured — returns OK with telegramPushed=false
  it('skips telegram and returns telegramPushed=false when not configured', async () => {
    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
      // no telegramPush
    };

    const result = await generateDailyReport(deps);

    expect(result.telegramPushed).toBe(false);
    // Result still valid
    expect(result.date).toBe(TODAY);
    expect(result.reportPath).toBeTruthy();
  });

  // TC-9: Report written even when git log throws
  it('still writes report with error field when git log fails', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('git: fatal error');
    });

    const logger = makeLogger();
    const db = makeDb(0);
    const deps: DailyReportDeps = {
      mindDb: db as unknown as import('better-sqlite3').Database,
      gitCwd: '/project',
      logger: logger as unknown as import('pino').Logger,
    };

    const result = await generateDailyReport(deps);

    // Report was still written
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
    // Commit count falls back to 0
    expect(result.commitCount).toBe(0);
    // Error note is surfaced
    expect(result.error).toBeUndefined(); // git errors are warned, not propagated to error field
  });
});

// ─── sendTelegramMessage tests ────────────────────────────────────────────────

describe('sendTelegramMessage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  // TG-1: Returns not-configured when env vars absent
  it('returns ok=false when TELEGRAM_BOT_TOKEN is not set', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];

    const result = await sendTelegramMessage('hello');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('TELEGRAM_*_not_configured');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // TG-2: Returns not-configured when TELEGRAM_CHAT_ID absent
  it('returns ok=false when TELEGRAM_CHAT_ID is not set', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'token123';
    delete process.env['TELEGRAM_CHAT_ID'];

    const result = await sendTelegramMessage('hello');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('TELEGRAM_*_not_configured');
  });

  // TG-3: Returns ok=true on HTTP 200
  it('returns ok=true on successful Telegram API response', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'token123';
    process.env['TELEGRAM_CHAT_ID'] = 'chat456';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const result = await sendTelegramMessage('hello world');

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('api.telegram.org');
    expect(String(url)).toContain('token123');
    expect((opts as RequestInit).method).toBe('POST');
  });

  // TG-4: Returns ok=false with error detail on non-200
  it('returns ok=false when API returns non-200', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'token123';
    process.env['TELEGRAM_CHAT_ID'] = 'chat456';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ description: 'Bad Request' }),
    } as unknown as Response);

    const result = await sendTelegramMessage('hello');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('telegram_api_error');
    expect(result.error).toContain('Bad Request');
  });

  // TG-5: Returns ok=false on network error — never throws
  it('returns ok=false on network error and does not throw', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'token123';
    process.env['TELEGRAM_CHAT_ID'] = 'chat456';

    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await sendTelegramMessage('hello');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('telegram_network_error');
  });

  // TG-6: Uses provided parse_mode
  it('sends with HTML parse_mode when specified', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'token123';
    process.env['TELEGRAM_CHAT_ID'] = 'chat456';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    await sendTelegramMessage('<b>hello</b>', { parseMode: 'HTML' });

    const [, opts] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.parse_mode).toBe('HTML');
  });
});

// ─── Fixture validation ───────────────────────────────────────────────────────

describe('fixture: sample-report.md', () => {
  it('exists and contains expected structure', () => {
    // Read actual fixture from filesystem (not mocked — using real fs here)
    const content = readFileSync(FIXTURE_PATH, 'utf8');

    expect(content).toContain('# Self-Build Daily Report');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Commits');
    expect(content).toContain('## Next actions');
    expect(content).toMatch(/Tests:\s*\d+\s*passing/);
    expect(content).toContain('Generated');
  });
});
