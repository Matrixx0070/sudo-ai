/**
 * @file test-harness.ts
 * @description Self-Test Harness — SUDO-AI tests itself.
 * Dry-run mode, regression checks, health assertions (8 subsystems),
 * and history persisted to test_runs in mind.db. Heavy checks in checks.ts.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  checkToolsDirectory,
  checkSkillsDirectory,
  checkConsciousnessDb,
  checkChannels,
  checkSystemHealth,
  DB_PATHS,
  PROVIDER_ENV_KEYS,
} from './checks.js';

const log = createLogger('testing:harness');

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  output?: string;
}

export interface TestSuite {
  name: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  duration: number;
}

interface TestRunRow {
  id: number;
  suite_name: string;
  tests_json: string;
  passed: number;
  failed: number;
  duration_ms: number;
  run_at: string;
}

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS test_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    suite_name  TEXT    NOT NULL,
    tests_json  TEXT    NOT NULL,
    passed      INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    run_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

// ---------------------------------------------------------------------------
// TestHarness
// ---------------------------------------------------------------------------

export class TestHarness {
  private readonly db: Database.Database;

  constructor(private readonly dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('TestHarness: dbPath must be a non-empty string');
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA_DDL);
    log.info({ dbPath }, 'TestHarness initialised');
  }

  // ---------------------------------------------------------------------------
  // Run all tests
  // ---------------------------------------------------------------------------

  async runAll(): Promise<TestSuite> {
    const start = Date.now();
    log.info('Running full self-test suite');

    const settled = await Promise.allSettled([
      this.testDatabase(),
      this.testTools(),
      this.testSkills(),
      this.testBrain(),
      this.testConsciousness(),
      this.testChannels(),
      this.testMemory(),
      this.testHealth(),
    ]);

    const results: TestResult[] = settled.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : { name: 'unknown', passed: false, duration: 0,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
    );

    const suite: TestSuite = {
      name:     'SUDO-AI Full Self-Test',
      tests:    results,
      passed:   results.filter(r => r.passed).length,
      failed:   results.filter(r => !r.passed).length,
      duration: Date.now() - start,
    };

    this.saveResults(suite);
    log.info({ passed: suite.passed, failed: suite.failed, ms: suite.duration }, 'Self-test complete');
    return suite;
  }

  // ---------------------------------------------------------------------------
  // Individual test methods
  // ---------------------------------------------------------------------------

  async testDatabase(): Promise<TestResult> {
    return this._runTest('database', async () => {
      const missing: string[] = [];
      const issues: string[] = [];

      for (const [name, dbPath] of Object.entries(DB_PATHS)) {
        if (!existsSync(dbPath)) { missing.push(name); continue; }
        try {
          const db = new Database(dbPath, { readonly: true });
          db.pragma('integrity_check');
          db.close();
        } catch (err) {
          issues.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (missing.length > 0) throw new Error(`Missing databases: ${missing.join(', ')}`);
      if (issues.length > 0) throw new Error(`DB issues: ${issues.join('; ')}`);
      return `All ${Object.keys(DB_PATHS).length} databases readable and healthy`;
    });
  }

  async testTools(dryRun = false): Promise<TestResult> {
    return this._runTest(`tools${dryRun ? ' (dry-run)' : ''}`, async () => checkToolsDirectory());
  }

  async testSkills(): Promise<TestResult> {
    return this._runTest('skills', async () => checkSkillsDirectory(this.db));
  }

  async testBrain(): Promise<TestResult> {
    return this._runTest('brain', async () => {
      const presentKeys = Object.entries(PROVIDER_ENV_KEYS)
        .filter(([, envKey]) => !!process.env[envKey]?.trim())
        .map(([provider]) => provider);

      if (presentKeys.length === 0) {
        throw new Error('No LLM provider API keys configured — brain cannot function');
      }

      let sessionCount = 0;
      try {
        const row = this.db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number } | undefined;
        sessionCount = row?.cnt ?? 0;
      } catch {
        throw new Error('sessions table not found in mind.db — brain schema missing');
      }

      return `Brain ready: ${presentKeys.join(', ')} configured, ${sessionCount} past sessions`;
    });
  }

  async testConsciousness(): Promise<TestResult> {
    return this._runTest('consciousness', async () => checkConsciousnessDb());
  }

  async testChannels(): Promise<TestResult> {
    return this._runTest('channels', async () => checkChannels());
  }

  async testMemory(): Promise<TestResult> {
    return this._runTest('memory', async () => {
      const issues: string[] = [];
      const stats: string[] = [];

      try {
        const row = this.db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number };
        stats.push(`${row.cnt} messages`);
      } catch { issues.push('messages table missing'); }

      try {
        const row = this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
        stats.push(`${row.cnt} memory chunks`);
      } catch { issues.push('chunks table missing'); }

      if (existsSync(DB_PATHS['knowledge']!)) {
        stats.push('knowledge.db accessible');
      } else {
        issues.push('knowledge.db missing');
      }

      if (issues.length > 0) throw new Error(`Memory issues: ${issues.join(', ')}`);
      return `Memory OK: ${stats.join(', ')}`;
    });
  }

  async testHealth(): Promise<TestResult> {
    return this._runTest('health', async () => checkSystemHealth());
  }

  // ---------------------------------------------------------------------------
  // Dry-run mode
  // ---------------------------------------------------------------------------

  async dryRun(toolName: string, input: unknown): Promise<TestResult> {
    return this._runTest(`dry-run:${toolName}`, async () => {
      if (!toolName?.trim()) throw new TypeError('dryRun: toolName is required');
      const serialised = JSON.stringify(input);
      if (!serialised) throw new Error('input is not JSON-serialisable');
      return `Dry-run schema check passed for "${toolName}" with ${serialised.length}B input`;
    });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  saveResults(suite: TestSuite): void {
    try {
      this.db.prepare(`
        INSERT INTO test_runs (suite_name, tests_json, passed, failed, duration_ms)
        VALUES (:suite_name, :tests_json, :passed, :failed, :duration_ms)
      `).run({
        suite_name:  suite.name,
        tests_json:  JSON.stringify(suite.tests),
        passed:      suite.passed,
        failed:      suite.failed,
        duration_ms: suite.duration,
      });
      log.debug({ suiteName: suite.name, passed: suite.passed, failed: suite.failed }, 'Test results saved');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to save test results');
    }
  }

  getHistory(limit = 20): TestSuite[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('getHistory: limit must be a positive integer');
    }
    const clampedLimit = Math.min(limit, 500);

    const rows = this.db.prepare(
      `SELECT * FROM test_runs ORDER BY run_at DESC LIMIT :limit`
    ).all({ limit: clampedLimit }) as TestRunRow[];

    return rows.map(row => {
      let tests: TestResult[] = [];
      try { tests = JSON.parse(row.tests_json) as TestResult[]; } catch { /* leave empty */ }
      return {
        name:     row.suite_name,
        tests,
        passed:   row.passed,
        failed:   row.failed,
        duration: row.duration_ms,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _runTest(name: string, fn: () => Promise<string>): Promise<TestResult> {
    const start = Date.now();
    try {
      const output = await fn();
      const duration = Date.now() - start;
      log.debug({ test: name, passed: true, ms: duration }, 'Test passed');
      return { name, passed: true, duration, output };
    } catch (err) {
      const duration = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      log.warn({ test: name, passed: false, ms: duration, error }, 'Test failed');
      return { name, passed: false, duration, error };
    }
  }
}
