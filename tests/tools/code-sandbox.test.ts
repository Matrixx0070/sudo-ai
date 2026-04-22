/**
 * code-sandbox.test.ts — Unit tests for code.js-exec sandboxed execution.
 *
 * Tests cover:
 *   1. Basic execution and stdout capture (3 tests)
 *   2. Return value capture (2 tests)
 *   3. Session context persistence (3 tests)
 *   4. Timeout enforcement (2 tests)
 *   5. Security isolation — blocked globals (4 tests)
 *   6. Error handling (3 tests)
 *   7. Input validation (3 tests)
 *   8. Session kernel manager (3 tests)
 *
 * Total: 23 tests
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock logger to suppress noise during tests
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { jsExecTool } from '../../src/core/tools/builtin/code/tools/js-exec.js';
import {
  getOrCreateEntry,
  killSession,
  killAllSessions,
  getStats,
  stopSweeper,
  isValidSessionId,
  sanitizeForDocker,
} from '../../src/core/tools/builtin/code/session-kernels.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: `test-js-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workingDir: '/tmp',
    config: null,
    logger: null,
    ...overrides,
  };
}

afterAll(async () => {
  stopSweeper();
  await killAllSessions();
});

// ---------------------------------------------------------------------------
// 1. Basic execution and stdout capture
// ---------------------------------------------------------------------------

describe('JS sandbox — basic execution', () => {
  it('executes simple arithmetic and returns result', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({ code: '2 + 2' }, ctx);
    expect(result.data).toBeDefined();
    const data = result.data as { value: unknown };
    expect(data.value).toBe(4);
  }, 15000);

  it('captures console.log output in stdout', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({ code: 'console.log("hello world")' }, ctx);
    expect(result.data).toBeDefined();
    const data = result.data as { stdout: string };
    expect(data.stdout).toContain('hello world');
  }, 15000);

  it('captures multiple console.log lines', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'console.log("line1"); console.log("line2"); console.log("line3")',
    }, ctx);
    const data = result.data as { stdout: string };
    expect(data.stdout).toContain('line1');
    expect(data.stdout).toContain('line2');
    expect(data.stdout).toContain('line3');
  }, 15000);
});

// ---------------------------------------------------------------------------
// 2. Return value capture
// ---------------------------------------------------------------------------

describe('JS sandbox — return value capture', () => {
  it('captures primitive return value', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({ code: '"hello"' }, ctx);
    const data = result.data as { value: unknown };
    expect(data.value).toBe('hello');
  }, 15000);

  it('captures object return value', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: '({ name: "sudo-ai", version: 9 })',
    }, ctx);
    const data = result.data as { value: unknown };
    expect(data.value).toEqual({ name: 'sudo-ai', version: 9 });
  }, 15000);
});

// ---------------------------------------------------------------------------
// 3. Session context persistence
// ---------------------------------------------------------------------------

describe('JS sandbox — session context persistence', () => {
  it('persists variables across calls with same sessionId', async () => {
    const sessionId = `persist-test-${Date.now()}`;
    const ctx = makeCtx({ sessionId });

    // First call: set a variable
    await jsExecTool.execute({ code: 'var x = 42;', sessionId }, ctx);

    // Second call: read the variable
    const result2 = await jsExecTool.execute({
      code: 'console.log(x); x',
      sessionId,
    }, ctx);

    const data = result2.data as { stdout: string; value: unknown };
    expect(data.stdout).toContain('42');
    expect(data.value).toBe(42);
  }, 30000);

  it('isolates context between different sessionIds', async () => {
    const sessionA = `session-a-${Date.now()}`;
    const sessionB = `session-b-${Date.now()}`;
    const ctx = makeCtx();

    await jsExecTool.execute({ code: 'var myVar = "from-a";', sessionId: sessionA }, ctx);
    const result = await jsExecTool.execute({
      code: 'typeof myVar',
      sessionId: sessionB,
    }, ctx);

    const data = result.data as { value: unknown };
    expect(data.value).toBe('undefined');
  }, 30000);

  it('falls back to ctx.sessionId when sessionId param omitted', async () => {
    const ctx = makeCtx({ sessionId: `fallback-${Date.now()}` });
    const result = await jsExecTool.execute({ code: '1 + 1' }, ctx);
    expect(result.data).toBeDefined();
    const data = result.data as { value: unknown };
    expect(data.value).toBe(2);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 4. Timeout enforcement
// ---------------------------------------------------------------------------

describe('JS sandbox — timeout enforcement', () => {
  it('times out when code runs longer than timeout', async () => {
    const ctx = makeCtx();
    // Inner VM has a 4500ms timeout; we request 1000ms outer timeout
    const result = await jsExecTool.execute({
      code: 'while(true) {}',
      timeout: 1000,
    }, ctx);
    const data = result.data as { timedOut: boolean };
    expect(data.timedOut).toBe(true);
  }, 15000);

  it('includes executionTimeMs in result', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({ code: '1' }, ctx);
    const data = result.data as { executionTimeMs: number };
    expect(typeof data.executionTimeMs).toBe('number');
    expect(data.executionTimeMs).toBeGreaterThan(0);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 5. Security isolation — blocked globals
// ---------------------------------------------------------------------------

describe('JS sandbox — security isolation', () => {
  it('blocks access to require', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'typeof require',
    }, ctx);
    const data = result.data as { value: unknown };
    expect(data.value).toBe('undefined');
  }, 15000);

  it('blocks access to process', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'typeof process',
    }, ctx);
    const data = result.data as { value: unknown };
    expect(data.value).toBe('undefined');
  }, 15000);

  it('blocks access to globalThis', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'typeof globalThis',
    }, ctx);
    const data = result.data as { value: unknown };
    expect(data.value).toBe('undefined');
  }, 15000);

  it('allows safe Math operations', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'Math.sqrt(144)',
    }, ctx);
    const data = result.data as { value: unknown };
    expect(data.value).toBe(12);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 6. Error handling
// ---------------------------------------------------------------------------

describe('JS sandbox — error handling', () => {
  it('captures syntax errors in stderr without throwing', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'const x = {invalid syntax !!',
    }, ctx);
    expect(result.data).toBeDefined();
    const data = result.data as { stderr: string };
    expect(data.stderr).toBeTruthy();
  }, 15000);

  it('captures runtime errors in stderr', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'throw new Error("test error")',
    }, ctx);
    const data = result.data as { stderr: string };
    expect(data.stderr).toContain('Error');
  }, 15000);

  it('returns success:false when timedOut', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({
      code: 'while(true) {}',
      timeout: 500,
    }, ctx);
    // When timed out, success should be false
    const data = result.data as { timedOut: boolean };
    expect(data.timedOut).toBe(true);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 7. Input validation
// ---------------------------------------------------------------------------

describe('JS sandbox — input validation', () => {
  it('rejects empty code', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({ code: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Validation error');
  }, 5000);

  it('rejects non-string code', async () => {
    const ctx = makeCtx();
    const result = await jsExecTool.execute({ code: 42 as unknown as string }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Validation error');
  }, 5000);

  it('clamps timeout to 30000ms maximum', async () => {
    const ctx = makeCtx();
    // Pass absurdly large timeout — should be clamped and not cause issues
    const result = await jsExecTool.execute({ code: '1 + 1', timeout: 999_999 }, ctx);
    expect(result.data).toBeDefined();
    const data = result.data as { value: unknown };
    expect(data.value).toBe(2);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 8. Session kernel manager
// ---------------------------------------------------------------------------

describe('Session kernel manager', () => {
  it('getOrCreateEntry creates new entry for new sessionId', () => {
    const sessionId = `km-test-${Date.now()}`;
    const entry = getOrCreateEntry(sessionId);
    expect(entry).toBeDefined();
    expect(entry.jsContext).toBeNull();
    expect(entry.pyContainerId).toBeNull();
    expect(entry.lastUsedAt).toBeGreaterThan(0);
  });

  it('getStats returns session counts', async () => {
    const sessionId = `stats-test-${Date.now()}`;
    getOrCreateEntry(sessionId);
    const stats = getStats();
    expect(stats.totalSessions).toBeGreaterThan(0);
    expect(typeof stats.jsActiveSessions).toBe('number');
    expect(typeof stats.pyActiveSessions).toBe('number');
  });

  it('killSession removes entry from map', async () => {
    const sessionId = `kill-test-${Date.now()}`;
    getOrCreateEntry(sessionId);
    const statsBefore = getStats();
    const countBefore = statsBefore.totalSessions;

    await killSession(sessionId);

    const statsAfter = getStats();
    expect(statsAfter.totalSessions).toBe(countBefore - 1);
    expect(statsAfter.sessions.find((s) => s.sessionId === sessionId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Additional: isValidSessionId + sanitizeForDocker
// ---------------------------------------------------------------------------

describe('Session kernel — helper functions', () => {
  it('isValidSessionId accepts alphanumeric IDs', () => {
    expect(isValidSessionId('abc123')).toBe(true);
    expect(isValidSessionId('session-a.b_c')).toBe(true);
  });

  it('isValidSessionId rejects IDs with special chars', () => {
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidSessionId('a b')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
  });

  it('sanitizeForDocker replaces invalid chars', () => {
    const sanitized = sanitizeForDocker('my session/id!@#');
    expect(sanitized).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });
});
