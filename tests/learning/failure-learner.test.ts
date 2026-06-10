/**
 * @file tests/learning/failure-learner.test.ts
 * @description FailureLearner storage backends: legacy in-memory default,
 * opt-in SUDO_FAILURE_LEARNER_DB=1 durable SQLite mode (persistence across
 * simulated restarts via vi.resetModules), per-tool cap, and the fail-open
 * fallback to memory when the database cannot be opened.
 *
 * The module resolves MIND_DB from paths.ts at load time, so every test
 * imports it freshly AFTER setting SUDO_AI_HOME (vitest isolates module
 * state per file; resetModules isolates it per import here).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FLAG = 'SUDO_FAILURE_LEARNER_DB';
const HOME = 'SUDO_AI_HOME';

type FailureLearnerModule = typeof import('../../src/core/learning/failure-learner.js');

async function freshImport(): Promise<FailureLearnerModule> {
  // resetModules must also invalidate paths.ts: MIND_DB is computed at module
  // load from SUDO_AI_HOME, so each import cycle re-reads the env var.
  vi.resetModules();
  return await import('../../src/core/learning/failure-learner.js');
}

let dir: string;
let savedFlag: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'failure-learner-'));
  savedFlag = process.env[FLAG];
  savedHome = process.env[HOME];
  delete process.env[FLAG];
  process.env[HOME] = dir;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  if (savedHome === undefined) delete process.env[HOME];
  else process.env[HOME] = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Default (flag OFF): legacy in-memory behavior
// ---------------------------------------------------------------------------

describe('FailureLearner in-memory default (flag OFF)', () => {
  it('MEM-1: records failures, solutions, and prevention rules', async () => {
    const fl = await freshImport();

    const rec = fl.recordFailure('web.fetch', 'ETIMEDOUT connecting to host', '{"url":"x"}');
    expect(rec.id).toMatch(/^fail-/);
    expect(fl.hasSeenBefore('web.fetch', 'ETIMEDOUT connecting to host')).toBe(true);
    expect(fl.hasSeenBefore('web.fetch', 'completely different error')).toBe(false);
    expect(fl.getSolution('web.fetch', 'ETIMEDOUT connecting to host')).toBeUndefined();

    fl.recordSolution(rec.id, 'increase timeout to 30s', 'always set timeout >= 30s');
    expect(fl.getSolution('web.fetch', 'ETIMEDOUT connecting to host')).toBe('increase timeout to 30s');
    expect(fl.getPreventionRule('web.fetch', 'ETIMEDOUT connecting to host')).toBe('always set timeout >= 30s');
    expect(fl.getFailureStats()).toEqual({ 'web.fetch': 1 });
  });

  it('MEM-2: validation rejects empty arguments', async () => {
    const fl = await freshImport();
    expect(() => fl.recordFailure('', 'err', 'ctx')).toThrow(TypeError);
    expect(() => fl.recordFailure('tool', '', 'ctx')).toThrow(TypeError);
    expect(() => fl.recordFailure('tool', 'err', '')).toThrow(TypeError);
    expect(() => fl.recordSolution('', 'fix')).toThrow(TypeError);
    expect(() => fl.recordSolution('fail-x', '')).toThrow(TypeError);
  });

  it('MEM-3: per-tool log is capped at 200 entries', async () => {
    const fl = await freshImport();
    for (let i = 0; i < 205; i++) fl.recordFailure('shell.exec', `error variant ${i}`, 'ctx');
    expect(fl.getFailureStats()).toEqual({ 'shell.exec': 200 });
  });

  it('MEM-5: rule-less re-resolve does not retract an indexed prevention rule', async () => {
    const fl = await freshImport();
    const rec = fl.recordFailure('web.fetch', 'ETIMEDOUT connecting to host', 'ctx');
    fl.recordSolution(rec.id, 'first fix', 'use a retry budget');
    fl.recordSolution(rec.id, 'second fix');
    expect(fl.getPreventionRule('web.fetch', 'ETIMEDOUT connecting to host')).toBe('use a retry budget');
    expect(fl.getSolution('web.fetch', 'ETIMEDOUT connecting to host')).toBe('second fix');
  });

  it('MEM-4: data does NOT survive a module reload (process restart)', async () => {
    const fl1 = await freshImport();
    fl1.recordFailure('web.fetch', 'ETIMEDOUT', 'ctx');
    expect(fl1.hasSeenBefore('web.fetch', 'ETIMEDOUT')).toBe(true);

    const fl2 = await freshImport();
    expect(fl2.hasSeenBefore('web.fetch', 'ETIMEDOUT')).toBe(false);
    expect(fl2.getFailureStats()).toEqual({});
    expect(existsSync(join(dir, 'data', 'mind.db'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SUDO_FAILURE_LEARNER_DB=1: durable SQLite mode
// ---------------------------------------------------------------------------

describe('FailureLearner SQLite mode (flag ON)', () => {
  beforeEach(() => { process.env[FLAG] = '1'; });

  it('DB-1: records persist across a simulated restart', async () => {
    const fl1 = await freshImport();
    const rec = fl1.recordFailure('web.fetch', 'ETIMEDOUT connecting to host', '{"url":"x"}');
    fl1.recordSolution(rec.id, 'increase timeout to 30s', 'always set timeout >= 30s');
    expect(existsSync(join(dir, 'data', 'mind.db'))).toBe(true);

    const fl2 = await freshImport();
    expect(fl2.hasSeenBefore('web.fetch', 'ETIMEDOUT connecting to host')).toBe(true);
    expect(fl2.getSolution('web.fetch', 'ETIMEDOUT connecting to host')).toBe('increase timeout to 30s');
    expect(fl2.getPreventionRule('web.fetch', 'ETIMEDOUT connecting to host')).toBe('always set timeout >= 30s');
    expect(fl2.getFailureStats()).toEqual({ 'web.fetch': 1 });
  });

  it('DB-2: per-tool cap evicts oldest rows', async () => {
    const fl = await freshImport();
    // Zero-padded so each prefix matches exactly one row ('error variant 4'
    // would be a substring of 'error variant 40' under instr/includes).
    for (let i = 0; i < 205; i++) {
      fl.recordFailure('shell.exec', `error variant ${String(i).padStart(3, '0')}`, 'ctx');
    }
    expect(fl.getFailureStats()).toEqual({ 'shell.exec': 200 });
    // 205 inserted, cap 200: rows 000-004 evicted, 005-204 retained.
    expect(fl.hasSeenBefore('shell.exec', 'error variant 000')).toBe(false);
    expect(fl.hasSeenBefore('shell.exec', 'error variant 004')).toBe(false);
    expect(fl.hasSeenBefore('shell.exec', 'error variant 005')).toBe(true);
    expect(fl.hasSeenBefore('shell.exec', 'error variant 204')).toBe(true);
  });

  it('DB-3: recordSolution on an unknown id warns without throwing', async () => {
    const fl = await freshImport();
    expect(() => fl.recordSolution('fail-unknown', 'fix')).not.toThrow();
  });

  it('DB-4: prevention rule is keyed by tool + 50-char error prefix', async () => {
    const fl = await freshImport();
    const longError = 'X'.repeat(60) + ' trailing detail';
    const rec = fl.recordFailure('shell.exec', longError, 'ctx');
    fl.recordSolution(rec.id, 'fix', 'rule for long error');

    // Same 50-char prefix, different tail -> same rule.
    expect(fl.getPreventionRule('shell.exec', 'X'.repeat(60) + ' other tail')).toBe('rule for long error');
    // Different tool -> no rule.
    expect(fl.getPreventionRule('web.fetch', longError)).toBeUndefined();
  });

  it('DB-6: rule-less re-resolve does not retract an indexed prevention rule (parity with memory)', async () => {
    const fl = await freshImport();
    const rec = fl.recordFailure('web.fetch', 'ETIMEDOUT connecting to host', 'ctx');
    fl.recordSolution(rec.id, 'first fix', 'use a retry budget');
    fl.recordSolution(rec.id, 'second fix');
    expect(fl.getPreventionRule('web.fetch', 'ETIMEDOUT connecting to host')).toBe('use a retry budget');
    expect(fl.getSolution('web.fetch', 'ETIMEDOUT connecting to host')).toBe('second fix');
  });

  it('DB-5: fail-open — unopenable DB path falls back to in-memory', async () => {
    // dirname(MIND_DB) cannot be created under a file path.
    process.env[HOME] = '/dev/null';
    const fl = await freshImport();

    const rec = fl.recordFailure('web.fetch', 'ETIMEDOUT', 'ctx');
    expect(rec.id).toMatch(/^fail-/);
    expect(fl.hasSeenBefore('web.fetch', 'ETIMEDOUT')).toBe(true);
    expect(fl.getFailureStats()).toEqual({ 'web.fetch': 1 });
  });
});
