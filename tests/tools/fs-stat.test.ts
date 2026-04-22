import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import type { ToolContext } from '../../src/core/tools/types.js';
import { fsStatTool } from '../../src/core/tools/builtin/fs-stat/stat.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: `test-${Date.now()}`, workingDir: '/tmp', config: null, logger: null, ...overrides };
}

// ---------------------------------------------------------------------------
// Mock node:fs/promises stat
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

import { stat as mockStat } from 'node:fs/promises';
const mockedStat = mockStat as ReturnType<typeof vi.fn>;

function makeStat(overrides: Partial<{
  mode: number; size: number; mtime: Date; isFile: boolean; isDir: boolean;
}> = {}) {
  const defaults = {
    mode: 0o100644,  // regular file, 0o644 perms
    size: 1024,
    mtime: new Date('2026-01-15T12:00:00.000Z'),
    isFile: true,
    isDir: false,
  };
  const merged = { ...defaults, ...overrides };
  return {
    mode: merged.mode,
    size: merged.size,
    mtime: merged.mtime,
    isFile: () => merged.isFile,
    isDirectory: () => merged.isDir,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fs.stat tool', () => {
  it('happy path — file exists returns correct metadata', async () => {
    mockedStat.mockResolvedValueOnce(makeStat({ mode: 0o100644, size: 512, isFile: true, isDir: false }));

    const result = await fsStatTool.execute({ path: '/tmp/testfile.txt' }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      exists: true,
      size: 512,
      isFile: true,
      isDir: false,
      worldReadable: true,
    });
    expect(result.output).toContain('512 bytes');
    expect(result.output).toContain('/tmp/testfile.txt');
  });

  it('happy path — directory exists returns correct metadata', async () => {
    mockedStat.mockResolvedValueOnce(makeStat({ mode: 0o040755, size: 4096, isFile: false, isDir: true }));

    const result = await fsStatTool.execute({ path: '/tmp/testdir' }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      exists: true,
      isFile: false,
      isDir: true,
      worldReadable: true,  // 0o755 has world read bit set
    });
  });

  it('missing path — returns exists:false with success:true', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockedStat.mockRejectedValueOnce(err);

    const result = await fsStatTool.execute({ path: '/tmp/does-not-exist' }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ exists: false });
    expect(result.output).toContain('Path does not exist');
    expect(result.output).toContain('/tmp/does-not-exist');
  });

  it('relative path — rejected before stat is called', async () => {
    const result = await fsStatTool.execute({ path: 'relative/path' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.output).toContain('path must be absolute');
    expect(result.output).toContain('relative/path');
    expect(mockedStat).not.toHaveBeenCalled();
  });

  it('null byte in path — rejected before stat is called', async () => {
    const result = await fsStatTool.execute({ path: '/tmp/evil\0file' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.output).toContain('null byte');
    expect(mockedStat).not.toHaveBeenCalled();
  });

  it('EACCES — returns success:false with error:eacces', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockedStat.mockRejectedValueOnce(err);

    const result = await fsStatTool.execute({ path: '/etc/shadow' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.data).toEqual({ error: 'eacces' });
    expect(result.output).toContain('Permission denied');
  });

  it('worldReadable flag — 0o644 is true, 0o600 is false', async () => {
    // 0o100644 — world readable
    mockedStat.mockResolvedValueOnce(makeStat({ mode: 0o100644 }));
    const r1 = await fsStatTool.execute({ path: '/tmp/pub.txt' }, makeCtx());
    expect((r1.data as { worldReadable: boolean }).worldReadable).toBe(true);

    // 0o100600 — NOT world readable
    mockedStat.mockResolvedValueOnce(makeStat({ mode: 0o100600 }));
    const r2 = await fsStatTool.execute({ path: '/tmp/priv.txt' }, makeCtx());
    expect((r2.data as { worldReadable: boolean }).worldReadable).toBe(false);
  });
});
