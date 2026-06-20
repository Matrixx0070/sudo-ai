/**
 * @file tests/learning/trace-store-retention.test.ts
 * @description TraceStore.prune() retention — bounds traces.db by age + row cap.
 *
 *   1. age-based: deletes rows older than retentionDays, keeps recent
 *   2. row-cap: keeps only the newest maxRows
 *   3. no-op when nothing exceeds the bounds
 *   4. disabled bounds (0/0) prune nothing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TraceStore } from '../../src/core/learning/trace-store.js';

let tmpDir: string;
let dbPath: string;
let savedCapture: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-retention-'));
  dbPath = path.join(tmpDir, 'traces.db');
  savedCapture = process.env['SUDO_TRACE_CAPTURE'];
  process.env['SUDO_TRACE_CAPTURE'] = '1';
});

afterEach(() => {
  if (savedCapture === undefined) delete process.env['SUDO_TRACE_CAPTURE'];
  else process.env['SUDO_TRACE_CAPTURE'] = savedCapture;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seed(n: number): Promise<TraceStore> {
  const store = new TraceStore(dbPath);
  await store.init();
  for (let i = 0; i < n; i++) {
    store.recordToolCall(`sess-${i}`, 'coder.grep', true, 1, undefined, { i }, `result ${i}`);
  }
  return store;
}

function rowCount(): number {
  const raw = new Database(dbPath);
  const c = (raw.prepare('SELECT COUNT(*) AS c FROM traces').get() as { c: number }).c;
  raw.close();
  return c;
}

describe('TraceStore.prune (retention)', () => {
  it('age-based: deletes rows older than retentionDays, keeps recent', async () => {
    const store = await seed(3);
    // Backdate the oldest row 40 days via a second connection (WAL-safe). Uses
    // datetime('now','-40 days') to match the space-format created_at column.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE traces SET created_at = datetime('now','-40 days') WHERE id = (SELECT MIN(id) FROM traces)").run();
    raw.close();

    const deleted = store.prune({ retentionDays: 30, maxRows: 0 });
    store.close();

    expect(deleted).toBe(1);
    expect(rowCount()).toBe(2);
  });

  it('row-cap: keeps only the newest maxRows', async () => {
    const store = await seed(5);
    const deleted = store.prune({ retentionDays: 0, maxRows: 3 });
    store.close();

    expect(deleted).toBe(2);
    expect(rowCount()).toBe(3);
  });

  it('no-op when nothing exceeds the bounds', async () => {
    const store = await seed(2);
    const deleted = store.prune({ retentionDays: 30, maxRows: 100 });
    store.close();

    expect(deleted).toBe(0);
    expect(rowCount()).toBe(2);
  });

  it('disabled bounds (0/0) prune nothing', async () => {
    const store = await seed(3);
    const deleted = store.prune({ retentionDays: 0, maxRows: 0 });
    store.close();

    expect(deleted).toBe(0);
    expect(rowCount()).toBe(3);
  });

  it('combined: age + row-cap compose (old row pruned, then capped to newest maxRows)', async () => {
    const store = await seed(5); // ids 1..5
    const raw = new Database(dbPath);
    raw.prepare("UPDATE traces SET created_at = datetime('now','-40 days') WHERE id = (SELECT MIN(id) FROM traces)").run();
    raw.close();

    // Age pass drops the backdated oldest (4 left); row-cap then trims to the newest 3.
    const deleted = store.prune({ retentionDays: 30, maxRows: 3 });
    store.close();

    expect(deleted).toBe(2);     // 1 by age + 1 by cap
    expect(rowCount()).toBe(3);  // newest 3 survive
  });
});
