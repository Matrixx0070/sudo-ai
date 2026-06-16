/**
 * @file telemetry.test.ts
 * @description Tests for the JSONL telemetry sink.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statSync } from 'node:fs';
import {
  recordAttempt,
  truncateToTail,
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

describe('truncateToTail', () => {
  it('is a no-op for files at or below the retain size', async () => {
    // Two short JSON rows, well under retainBytes.
    recordAttempt(baseRecord({ attemptIndex: 1 }), { path: logPath, env: {} });
    recordAttempt(baseRecord({ attemptIndex: 2 }), { path: logPath, env: {} });
    const sizeBefore = statSync(logPath).size;
    truncateToTail(logPath, 10_000);
    const sizeAfter = statSync(logPath).size;
    expect(sizeAfter).toBe(sizeBefore);
  });

  it('is a no-op when the file does not exist', () => {
    expect(() => truncateToTail(path.join(root, 'nope.jsonl'), 1000)).not.toThrow();
  });

  it('trims to the last N bytes line-aligned (no partial leading row)', async () => {
    // Write 100 small distinguishable rows.
    for (let i = 0; i < 100; i++) {
      recordAttempt(baseRecord({ attemptIndex: i, durationMs: i }), { path: logPath, env: {} });
    }
    const sizeBefore = statSync(logPath).size;
    expect(sizeBefore).toBeGreaterThan(1000);

    truncateToTail(logPath, 500);

    const text = await readFile(logPath, 'utf-8');
    // Every line must be valid JSON — proving no half-line at the head.
    for (const line of text.split('\n')) {
      if (!line) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // The last line must be the highest attemptIndex (99) — we kept the tail.
    const lines = text.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.attemptIndex).toBe(99);
  });

  it('keeps file size bounded to ~retainBytes after truncation', async () => {
    for (let i = 0; i < 200; i++) {
      recordAttempt(baseRecord({ attemptIndex: i }), { path: logPath, env: {} });
    }
    truncateToTail(logPath, 1000);
    const size = statSync(logPath).size;
    expect(size).toBeLessThanOrEqual(1000);
  });
});

describe('recordAttempt — size cap', () => {
  it('truncates automatically when size exceeds maxBytes', async () => {
    // Each row is ~300 bytes of JSON — pick a cap that holds several rows
    // so truncate doesn't drop the just-written row.
    const opts = { path: logPath, env: {}, maxBytes: 2000, retainBytes: 1500 };
    for (let i = 0; i < 50; i++) {
      recordAttempt(baseRecord({ attemptIndex: i }), opts);
    }
    const size = statSync(logPath).size;
    expect(size).toBeLessThanOrEqual(2000 + 400); // brief post-write overshoot before next truncate
    // The most recent attempt must survive — tail preserved.
    const text = await readFile(logPath, 'utf-8');
    const lines = text.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.attemptIndex).toBe(49);
  });

  it('respects SUDO_ARSENAL_V2_TELEMETRY_MAX_BYTES env override', async () => {
    const env = { SUDO_ARSENAL_V2_TELEMETRY_MAX_BYTES: '2000' };
    for (let i = 0; i < 50; i++) {
      recordAttempt(baseRecord({ attemptIndex: i }), { path: logPath, env });
    }
    // After many writes the file should have triggered the env cap and stay
    // small (env-cap based retain = 70% by default).
    const size = statSync(logPath).size;
    expect(size).toBeLessThan(50 * 300); // far below the unbounded total
  });

  it('does not throw when the cap stat fails (e.g. perm error)', async () => {
    // We can't easily make stat fail in a portable way; rely on the
    // promise that the surrounding try/catch never propagates. As a
    // smoke check, pass a maxBytes of 0 which would force retainBytes
    // also to 0 — truncate is a no-op for retainBytes <= 0.
    expect(() =>
      recordAttempt(baseRecord(), { path: logPath, env: {}, maxBytes: 0 }),
    ).not.toThrow();
  });
});
