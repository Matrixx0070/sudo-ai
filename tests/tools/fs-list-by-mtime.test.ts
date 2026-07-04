import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsListByMtimeTool } from '../../src/core/tools/builtin/fs-list-by-mtime/list-by-mtime.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: `test-${Date.now()}`, workingDir: '/tmp', config: null, logger: null, ...overrides };
}

function futureDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString();
}

// An isolated temp dir with a KNOWN set of files (a=oldest … c=newest) so the
// count/sort/truncation assertions are deterministic. The tests previously read
// the real /tmp, which is unbounded and shared — flaky (huge dir → timeouts,
// unpredictable counts).
describe('fs.list-by-mtime', () => {
  const ctx = makeCtx();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fslist-'));
    const base = Math.floor(Date.now() / 1000);
    // a oldest → c newest (ages in seconds ago).
    for (const [name, ageSec] of [['a.txt', 300], ['b.txt', 200], ['c.txt', 100]] as const) {
      const p = join(dir, name);
      writeFileSync(p, name);
      const t = base - ageSec;
      utimesSync(p, t, t);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Happy path — list the isolated dir (3 known files).
  it('lists files without filters', async () => {
    const result = await fsListByMtimeTool.execute({ path: dir }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { files: unknown[]; count: number; truncated: boolean };
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.count).toBe(3);
    expect(data.truncated).toBe(false);
    expect(result.output).toMatch(/file\(s\) in/);
  });

  // 2. olderThan far future — all 3 files are older, so all pass.
  it('olderThan far future includes all files', async () => {
    const result = await fsListByMtimeTool.execute({ path: dir, olderThan: futureDate(3650) }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(3);
  });

  // 3. newerThan far future — none are newer than a far-future date.
  it('newerThan far future returns zero results', async () => {
    const result = await fsListByMtimeTool.execute({ path: dir, newerThan: futureDate(3650) }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { count: number; truncated: boolean };
    expect(data.count).toBe(0);
    expect(data.truncated).toBe(false);
  });

  // 4. limit:1 truncates when the dir has more than 1 file.
  it('limit:1 triggers truncation when directory has multiple files', async () => {
    const result = await fsListByMtimeTool.execute(
      { path: dir, olderThan: futureDate(9999), limit: 1 },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { files: unknown[]; truncated: boolean };
    expect(data.files.length).toBe(1);
    expect(data.truncated).toBe(true);
  });

  // 5. Relative path rejected.
  it('rejects relative path', async () => {
    const result = await fsListByMtimeTool.execute({ path: 'relative/path' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('must be absolute');
    expect(result.output).toContain('relative/path');
  });

  // 6. Invalid ISO string for olderThan.
  it('rejects invalid olderThan ISO string', async () => {
    const result = await fsListByMtimeTool.execute({ path: dir, olderThan: 'not-a-date' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid olderThan');
  });

  // 7. Non-existent directory returns error.
  it('returns error for non-existent directory', async () => {
    const result = await fsListByMtimeTool.execute(
      { path: join(dir, '__nonexistent_dir_sudo_ai_test__') },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('fs.list-by-mtime error');
  });

  // 8. Null byte in path rejected.
  it('rejects path containing null byte', async () => {
    const result = await fsListByMtimeTool.execute({ path: `${dir}/\0evil` }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('null byte');
  });

  // 9. Empty path rejected.
  it('rejects empty path', async () => {
    const result = await fsListByMtimeTool.execute({ path: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('path is required');
  });

  // 10. Result files sorted newest first (c, b, a) — deterministic mtimes.
  it('returns files sorted newest first', async () => {
    const result = await fsListByMtimeTool.execute({ path: dir }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { files: Array<{ name: string; mtime: string }> };
    expect(data.files.map((f) => f.name)).toEqual(['c.txt', 'b.txt', 'a.txt']);
    for (let i = 1; i < data.files.length; i++) {
      const prev = new Date(data.files[i - 1]!.mtime).getTime();
      const curr = new Date(data.files[i]!.mtime).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});
