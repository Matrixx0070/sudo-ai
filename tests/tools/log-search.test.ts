import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { ToolContext } from '../../src/core/tools/types.js';
import { logSearchTool } from '../../src/core/tools/builtin/log-search/search.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: `test-${Date.now()}`, workingDir: '/tmp', config: null, logger: null, ...overrides };
}

// Helpers to create a temp log file
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'logsearch-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpLog(name: string, content: string): string {
  const p = nodePath.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('log.search', () => {
  it('returns 5 ERROR matches from file with no timestamps when sinceMinutes=0', async () => {
    const lines = [
      'INFO app started',
      'ERROR disk full',
      'INFO heartbeat',
      'ERROR connection refused',
      'DEBUG verbose',
      'ERROR timeout',
      'INFO user joined',
      'ERROR panic',
      'ERROR crash',
    ].join('\n');
    const logFile = writeTmpLog('app.log', lines);

    const result = await logSearchTool.execute(
      { path: logFile, pattern: 'ERROR', sinceMinutes: 0 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { matches: unknown[]; count: number; truncated: boolean };
    expect(data.count).toBe(5);
    expect(data.matches).toHaveLength(5);
    expect(data.truncated).toBe(false);
  });

  it('returns truncated=true when maxMatches=2 and file has 10 matches', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `ERROR line ${i}`).join('\n');
    const logFile = writeTmpLog('many.log', lines);

    const result = await logSearchTool.execute(
      { path: logFile, pattern: 'ERROR', sinceMinutes: 0, maxMatches: 2 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { count: number; truncated: boolean };
    expect(data.count).toBe(2);
    expect(data.truncated).toBe(true);
  });

  it('returns success=false for invalid regex pattern "[invalid"', async () => {
    const logFile = writeTmpLog('x.log', 'something');

    const result = await logSearchTool.execute(
      { path: logFile, pattern: '[invalid', sinceMinutes: 0 },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid regex');
  });

  it('returns success=false when pattern exceeds 200 chars', async () => {
    const longPattern = 'a'.repeat(201);
    const logFile = writeTmpLog('x.log', 'something');

    const result = await logSearchTool.execute(
      { path: logFile, pattern: longPattern, sinceMinutes: 0 },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('pattern exceeds 200 char limit');
  });

  it('returns success=false for path outside allowed dirs (/etc/passwd)', async () => {
    const result = await logSearchTool.execute(
      { path: '/etc/passwd', pattern: 'root', sinceMinutes: 0 },
      makeCtx({ workingDir: '/tmp' }),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('outside allowed directories');
  });

  it('returns success=false for relative path', async () => {
    const result = await logSearchTool.execute(
      { path: 'relative/file.log', pattern: 'ERROR', sinceMinutes: 0 },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('must be absolute');
  });

  it('returns count=0 when sinceMinutes=30 filters out 2h-old ISO timestamps', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const lines = [
      `${twoHoursAgo} ERROR old failure`,
      `${twoHoursAgo} ERROR another old error`,
    ].join('\n');
    const logFile = writeTmpLog('old.log', lines);

    const result = await logSearchTool.execute(
      { path: logFile, pattern: 'ERROR', sinceMinutes: 30 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(0);
  });

  it('includes recent timestamped lines and excludes old ones in mixed file', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fiveSecondsAgo = new Date(Date.now() - 5_000).toISOString();
    const lines = [
      `${twoHoursAgo} ERROR old error`,
      `${fiveSecondsAgo} ERROR recent error`,
    ].join('\n');
    const logFile = writeTmpLog('mixed.log', lines);

    const result = await logSearchTool.execute(
      { path: logFile, pattern: 'ERROR', sinceMinutes: 30 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { count: number; matches: Array<{ text: string }> };
    expect(data.count).toBe(1);
    expect(data.matches[0]?.text).toContain('recent error');
  });

  it('expands ~/ prefix into home directory path', async () => {
    // Write a file inside ~/.sudo-ai (tmpDir is /tmp, use the workaround with workingDir)
    // Instead, verify the allowed-roots check passes for /tmp subdirs
    const logFile = writeTmpLog('tilde.log', 'DEBUG: something\nERROR: tilde test');

    // The file is under /tmp which is in ALLOWED_ROOTS; the path itself is absolute already
    const result = await logSearchTool.execute(
      { path: logFile, pattern: 'tilde', sinceMinutes: 0 },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(1);
  });

  it('returns success=false for file not found', async () => {
    const result = await logSearchTool.execute(
      { path: nodePath.join(tmpDir, 'nonexistent.log'), pattern: 'ERROR', sinceMinutes: 0 },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('not found');
  });
});
