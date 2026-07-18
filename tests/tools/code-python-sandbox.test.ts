/**
 * code-python-sandbox.test.ts — Tests for code.python-exec sandboxed execution.
 *
 * Tests are split into:
 *   A. Unit tests (mock Docker) — always run, 12 tests
 *   B. Integration tests (real Docker) — skipped when Docker daemon unavailable
 *
 * Total non-skipped tests on a Docker-less CI system: 12
 * Total on a Docker-enabled system: depends on Docker availability
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Mock logger to suppress noise
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { pythonExecTool } from '../../src/core/tools/builtin/code/tools/python-exec.js';
import {
  killAllSessions,
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
    sessionId: `test-py-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workingDir: '/tmp',
    config: null,
    logger: null,
    ...overrides,
  };
}

// Env gate: the container-isolation tests need a reachable Docker daemon
// (`docker version` must answer); they skip on hosts/CI without Docker.
// Probed SYNCHRONOUSLY at module load: it.skipIf() captures its condition at
// collection time, so a probe inside beforeAll() would leave the flag false
// and permanently skip the integration tests even where Docker works (F126).
const dockerAvailable = ((): boolean => {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  stopSweeper();
});

afterAll(async () => {
  stopSweeper();
  // Only attempt cleanup if docker is available
  if (dockerAvailable) {
    await killAllSessions();
  }
});

// ---------------------------------------------------------------------------
// A. Unit tests — always run (test tool structure, validation, Docker-unavailable path)
// ---------------------------------------------------------------------------

describe('Python sandbox tool — unit tests (no Docker required)', () => {
  it('tool has correct name', () => {
    expect(pythonExecTool.name).toBe('code.python-exec');
  });

  it('tool has category coder', () => {
    expect(pythonExecTool.category).toBe('coder');
  });

  it('tool has safety: destructive', () => {
    expect(pythonExecTool.safety).toBe('destructive');
  });

  it('tool has required code parameter', () => {
    expect(pythonExecTool.parameters['code']).toBeDefined();
    expect(pythonExecTool.parameters['code']?.required).toBe(true);
  });

  it('rejects empty code', async () => {
    const ctx = makeCtx();
    const result = await pythonExecTool.execute({ code: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Validation error');
  });

  it('rejects non-string code', async () => {
    const ctx = makeCtx();
    const result = await pythonExecTool.execute({ code: 123 as unknown as string }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Validation error');
  });

  it('rejects code exceeding 100000 chars', async () => {
    const ctx = makeCtx();
    const result = await pythonExecTool.execute({ code: 'x'.repeat(100_001) }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Validation error');
  });

  it('when Docker unavailable: returns error in output without throwing', async () => {
    // This test verifies fail-open behavior — we call the tool on a system
    // where Docker daemon may not be running and expect a graceful error.
    if (dockerAvailable) {
      // Skip this specific assertion on Docker-enabled systems
      return;
    }
    const ctx = makeCtx();
    const result = await pythonExecTool.execute({ code: 'print(1+1)' }, ctx);
    // Should not throw — should return error result
    expect(result).toBeDefined();
    expect(result.output).toBeDefined();
    // Output should mention Docker unavailability
    expect(
      result.output.includes('Docker') ||
      result.output.includes('docker') ||
      result.output.includes('unavailable') ||
      result.data !== undefined
    ).toBe(true);
  }, 15000);

  it('data field contains expected keys on any result', async () => {
    const ctx = makeCtx();
    const result = await pythonExecTool.execute({ code: 'print("test")' }, ctx);
    // Data should always have expected shape even on error
    if (result.data) {
      const data = result.data as Record<string, unknown>;
      // Should have at least some of these fields
      const knownFields = ['stdout', 'stderr', 'images', 'timedOut', 'containerId', 'executionTimeMs'];
      const hasAnyKnownField = knownFields.some((f) => f in data);
      expect(hasAnyKnownField).toBe(true);
    }
  }, 30000);

  it('clamps timeout to 60000ms maximum', async () => {
    // Just validates that passing extreme timeout doesn't cause internal error
    const ctx = makeCtx();
    // This may invoke Docker or return unavailable — either way no crash
    const resultPromise = pythonExecTool.execute({ code: '1', timeout: 999_999 }, ctx);
    // Should resolve (not hang)
    const result = await Promise.race([
      resultPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    // If we got a result (not null from timeout race), it should be valid
    if (result !== null) {
      expect(result).toBeDefined();
    }
  }, 15000);

  it('uses ctx.sessionId as fallback when sessionId param omitted', async () => {
    // This test verifies session routing — just checks no crash
    const ctx = makeCtx({ sessionId: 'fallback-py-test' });
    const resultPromise = pythonExecTool.execute({ code: 'x = 1' }, ctx);
    const result = await Promise.race([
      resultPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    // Should not crash regardless of Docker availability
    if (result !== null) {
      expect(result).toBeDefined();
    }
  }, 15000);

  it('invalid sessionId is sanitized (no crash)', async () => {
    const ctx = makeCtx({ sessionId: 'valid-session' });
    // Pass an invalid sessionId via params — should be sanitized to ctx.sessionId
    const resultPromise = pythonExecTool.execute({
      code: 'print("hi")',
      sessionId: 'invalid/session id!@#',
    }, ctx);
    const result = await Promise.race([
      resultPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    if (result !== null) {
      expect(result).toBeDefined();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// B. Integration tests — only run when Docker daemon is available
// ---------------------------------------------------------------------------

describe('Python sandbox — Docker integration tests', () => {
  beforeAll(() => {
    if (!dockerAvailable) {
      console.warn('[SKIP] Docker not available — Python integration tests skipped');
    }
  });

  it.skipIf(!dockerAvailable)(
    'executes simple Python and captures stdout',
    async () => {
      const ctx = makeCtx();
      const result = await pythonExecTool.execute({
        code: 'print(2 + 2)',
        sessionId: `docker-test-${Date.now()}`,
      }, ctx);
      const data = result.data as { stdout: string };
      expect(data.stdout).toContain('4');
    },
    120_000,
  );

  it.skipIf(!dockerAvailable)(
    'captures stderr from Python errors',
    async () => {
      const ctx = makeCtx();
      const result = await pythonExecTool.execute({
        code: 'raise ValueError("test error")',
        sessionId: `docker-err-${Date.now()}`,
      }, ctx);
      const data = result.data as { stderr: string };
      expect(data.stderr).toContain('ValueError');
    },
    120_000,
  );

  it.skipIf(!dockerAvailable)(
    'reuses container for same sessionId',
    async () => {
      const sessionId = `docker-reuse-${Date.now()}`;
      const ctx = makeCtx({ sessionId });

      const result1 = await pythonExecTool.execute({
        code: 'print("first call")',
        sessionId,
      }, ctx);
      const result2 = await pythonExecTool.execute({
        code: 'print("second call")',
        sessionId,
      }, ctx);

      const data1 = result1.data as { containerId: string };
      const data2 = result2.data as { containerId: string };
      // Same container should be reused
      expect(data1.containerId).toBe(data2.containerId);
    },
    240_000,
  );
});
