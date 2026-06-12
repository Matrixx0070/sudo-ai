/**
 * AutoFixTrigger persistence — regression coverage for the auto_fix_log
 * branch_name DDL bug: the attempt INSERT referenced a branch_name column the
 * CREATE TABLE never defined, every insert threw into a warn-only catch, and
 * the hourly rate limit (which counted those rows) was silently dead.
 *
 * Uses a real in-memory better-sqlite3 database; no network, no gh CLI
 * (rate-limit gate fires before any GitHub access).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AutoFixTrigger, type AutoFixTriggerDeps, type AutoFixAttempt } from '../../src/core/self-build/auto-fix-trigger.js';

type LogAttempt = { _logAttempt(attempt: AutoFixAttempt): void };

function makeDeps(db: Database.Database): AutoFixTriggerDeps {
  return {
    errorMemory: {} as AutoFixTriggerDeps['errorMemory'], // not reached in these tests
    metricsCollector: { increment: () => {}, gauge: () => {} },
    mindDb: db as unknown as AutoFixTriggerDeps['mindDb'],
  };
}

function attempt(issueNumber: number): AutoFixAttempt {
  return {
    issueNumber,
    errorSignature: 'TypeError: boom at src/core/x.ts',
    severity: 'HIGH',
    status: 'open',
    createdAt: new Date().toISOString(),
    branchName: `autofix/issue-${issueNumber}`,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AutoFixTrigger persistence', () => {
  it('creates auto_fix_log with the branch_name column', () => {
    const db = new Database(':memory:');
    new AutoFixTrigger(makeDeps(db));

    const cols = db.prepare(`SELECT name FROM pragma_table_info('auto_fix_log')`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('branch_name');
  });

  it('migrates a pre-existing table that lacks branch_name', () => {
    const db = new Database(':memory:');
    // Old-shape table from a database created before the DDL fix.
    db.exec(`
      CREATE TABLE auto_fix_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_number INTEGER NOT NULL,
        error_signature TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        fixed_at TEXT,
        commit_sha TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        deployment_sha TEXT,
        deployed_at TEXT
      );
    `);

    const trigger = new AutoFixTrigger(makeDeps(db));
    (trigger as unknown as LogAttempt)._logAttempt(attempt(42));

    const row = db.prepare(`SELECT branch_name FROM auto_fix_log WHERE issue_number = 42`).get() as
      | { branch_name: string | null }
      | undefined;
    expect(row?.branch_name).toBe('autofix/issue-42');
  });

  it('logs the attempt and the rate-log row (regression: insert used to throw)', () => {
    const db = new Database(':memory:');
    const trigger = new AutoFixTrigger(makeDeps(db));

    (trigger as unknown as LogAttempt)._logAttempt(attempt(7));

    const logCount = db.prepare(`SELECT COUNT(*) AS c FROM auto_fix_log`).get() as { c: number };
    const rateCount = db.prepare(`SELECT COUNT(*) AS c FROM auto_fix_rate_log`).get() as { c: number };
    expect(logCount.c).toBe(1);
    expect(rateCount.c).toBe(1);
  });

  it('still records the rate-log row when the attempt insert fails', () => {
    const db = new Database(':memory:');
    const trigger = new AutoFixTrigger(makeDeps(db));
    db.exec(`DROP TABLE auto_fix_log`); // force the audit insert to fail

    (trigger as unknown as LogAttempt)._logAttempt(attempt(8));

    const rateCount = db.prepare(`SELECT COUNT(*) AS c FROM auto_fix_rate_log`).get() as { c: number };
    expect(rateCount.c).toBe(1);
  });

  it('enforces the hourly rate limit once attempts are recorded', async () => {
    vi.stubEnv('SUDO_AUTOFIX_DISABLE', '');
    vi.stubEnv('SUDO_AUTOFIX_MAX_PER_HOUR', '1');

    const db = new Database(':memory:');
    const trigger = new AutoFixTrigger(makeDeps(db));
    (trigger as unknown as LogAttempt)._logAttempt(attempt(9));

    // Gate 2 fires before any GitHub access, so no gh CLI is invoked.
    await expect(trigger.processIssue(10)).resolves.toEqual({ success: false, reason: 'rate-limited' });
  });
});
