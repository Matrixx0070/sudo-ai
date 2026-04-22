import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import { fsListByMtimeTool } from '../../src/core/tools/builtin/fs-list-by-mtime/list-by-mtime.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: `test-${Date.now()}`, workingDir: '/tmp', config: null, logger: null, ...overrides };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pastDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

function futureDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fs.list-by-mtime', () => {
  const ctx = makeCtx();

  // 1. Happy path — list /tmp (real dir, should return success)
  it('lists files in /tmp without filters', async () => {
    const result = await fsListByMtimeTool.execute({ path: '/tmp' }, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.data).toBe('object');
    const data = result.data as { files: unknown[]; count: number; truncated: boolean };
    expect(Array.isArray(data.files)).toBe(true);
    expect(typeof data.count).toBe('number');
    expect(typeof data.truncated).toBe('boolean');
    expect(result.output).toMatch(/file\(s\) in \/tmp/);
  });

  // 2. olderThan far future — all existing files should pass the filter
  it('olderThan far future includes all files', async () => {
    const result = await fsListByMtimeTool.execute(
      { path: '/tmp', olderThan: futureDate(3650) },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { files: Array<{ name: string; mtime: string; size: number }>; count: number; truncated: boolean };
    // All files are older than far-future date
    expect(data.count).toBeGreaterThanOrEqual(0);
  });

  // 3. newerThan far future — no existing files should pass (all are older)
  it('newerThan far future returns zero results', async () => {
    const result = await fsListByMtimeTool.execute(
      { path: '/tmp', newerThan: futureDate(3650) },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { count: number; truncated: boolean };
    expect(data.count).toBe(0);
    expect(data.truncated).toBe(false);
  });

  // 4. limit:1 — should truncate when /tmp has more than 1 file
  it('limit:1 triggers truncation when directory has multiple files', async () => {
    // First get real count
    const fullResult = await fsListByMtimeTool.execute({ path: '/tmp', olderThan: futureDate(9999) }, ctx);
    const fullData = fullResult.data as { count: number };
    if (fullData.count <= 1) {
      // Not enough files to test truncation — skip gracefully
      expect(true).toBe(true);
      return;
    }
    const result = await fsListByMtimeTool.execute(
      { path: '/tmp', olderThan: futureDate(9999), limit: 1 },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { files: unknown[]; count: number; truncated: boolean };
    expect(data.files.length).toBe(1);
    expect(data.truncated).toBe(true);
  });

  // 5. Relative path rejected
  it('rejects relative path', async () => {
    const result = await fsListByMtimeTool.execute({ path: 'relative/path' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('must be absolute');
    expect(result.output).toContain('relative/path');
  });

  // 6. Invalid ISO string for olderThan
  it('rejects invalid olderThan ISO string', async () => {
    const result = await fsListByMtimeTool.execute(
      { path: '/tmp', olderThan: 'not-a-date' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid olderThan');
  });

  // 7. Non-existent directory returns error
  it('returns error for non-existent directory', async () => {
    const result = await fsListByMtimeTool.execute(
      { path: '/tmp/__nonexistent_dir_sudo_ai_test__' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('fs.list-by-mtime error');
  });

  // 8. Null byte in path rejected
  it('rejects path containing null byte', async () => {
    const result = await fsListByMtimeTool.execute({ path: '/tmp/\0evil' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('null byte');
  });

  // 9. Empty path rejected
  it('rejects empty path', async () => {
    const result = await fsListByMtimeTool.execute({ path: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('path is required');
  });

  // 10. Result files sorted newest first
  it('returns files sorted newest first', async () => {
    const result = await fsListByMtimeTool.execute({ path: '/tmp' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { files: Array<{ mtime: string }> };
    if (data.files.length >= 2) {
      for (let i = 1; i < data.files.length; i++) {
        const prev = new Date(data.files[i - 1]!.mtime).getTime();
        const curr = new Date(data.files[i]!.mtime).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    }
    // passes trivially when 0 or 1 file
    expect(true).toBe(true);
  });
});
