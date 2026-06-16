/**
 * @file telemetry.test.ts
 * @description Tests for the JSONL telemetry sink.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  recordAttempt,
  type TelemetryRecord,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/telemetry.js';

let root: string;
let logPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arsenal-v2-telemetry-'));
  logPath = path.join(root, 'data', 'arsenal-v2-telemetry.jsonl');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const baseRecord = (overrides: Partial<TelemetryRecord> = {}): TelemetryRecord => ({
  ts: 1718500000000,
  mode: 'fix',
  attemptIndex: 1,
  maxAttempts: 3,
  model: 'test/stub',
  applied: 3,
  skipped: 0,
  failed: 0,
  tscClean: true,
  tscErrorCount: 0,
  testsPassed: true,
  criticVerdict: 'approve',
  success: true,
  durationMs: 1234,
  ...overrides,
});

describe('recordAttempt', () => {
  it('appends one JSON line per call', async () => {
    recordAttempt(baseRecord({ attemptIndex: 1 }), { path: logPath, env: {} });
    recordAttempt(baseRecord({ attemptIndex: 2, criticVerdict: 'needs_revision', success: false }), {
      path: logPath,
      env: {},
    });
    const text = await readFile(logPath, 'utf-8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    const r1 = JSON.parse(lines[0]!);
    const r2 = JSON.parse(lines[1]!);
    expect(r1.attemptIndex).toBe(1);
    expect(r2.attemptIndex).toBe(2);
    expect(r2.criticVerdict).toBe('needs_revision');
  });

  it('creates the parent directory if missing', async () => {
    const deep = path.join(root, 'a', 'b', 'c', 'tele.jsonl');
    recordAttempt(baseRecord(), { path: deep, env: {} });
    const text = await readFile(deep, 'utf-8');
    expect(text).toMatch(/"mode":"fix"/);
  });

  it('skips when SUDO_ARSENAL_V2_TELEMETRY=0', async () => {
    recordAttempt(baseRecord(), { path: logPath, env: { SUDO_ARSENAL_V2_TELEMETRY: '0' } });
    await expect(readFile(logPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not skip for other env values (e.g. SUDO_ARSENAL_V2_TELEMETRY=1)', async () => {
    recordAttempt(baseRecord(), { path: logPath, env: { SUDO_ARSENAL_V2_TELEMETRY: '1' } });
    const text = await readFile(logPath, 'utf-8');
    expect(text).toMatch(/"mode":"fix"/);
  });

  it('does not throw when the write fails (path collision with a directory)', async () => {
    // Make logPath a directory so the appendFile attempt errors out.
    await mkdir(logPath, { recursive: true });
    expect(() => recordAttempt(baseRecord(), { path: logPath, env: {} })).not.toThrow();
  });

  it('does not throw when the parent path is read-only', async () => {
    const parent = path.join(root, 'ro');
    await mkdir(parent, { recursive: true });
    await chmod(parent, 0o555);
    const ro = path.join(parent, 'tele.jsonl');
    expect(() => recordAttempt(baseRecord(), { path: ro, env: {} })).not.toThrow();
    // Restore so afterEach can clean up.
    await chmod(parent, 0o755);
  });

  it('round-trips all TelemetryRecord fields verbatim', async () => {
    const rec = baseRecord({
      sessionId: 'sess-abc',
      attemptIndex: 2,
      testsPassed: null,
      criticVerdict: 'needs_revision',
      success: false,
      durationMs: 9876,
      applied: 2,
      skipped: 1,
      failed: 0,
      tscClean: false,
      tscErrorCount: 4,
    });
    recordAttempt(rec, { path: logPath, env: {} });
    const text = await readFile(logPath, 'utf-8');
    const parsed = JSON.parse(text.trim());
    expect(parsed).toEqual(rec);
  });
});
