/**
 * @file tests/sandbox/wasm-runner.test.ts
 * @description Tests for WasmRunner — wasmtime subprocess invocation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process');

const mockedSpawnSync = vi.mocked(spawnSync);

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests: isAvailable / WasmRunner constructor
// ---------------------------------------------------------------------------

describe('WasmRunner availability', () => {
  it('isAvailable is false when wasmtime --version fails', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'wasmtime: command not found',
      error: undefined,
      pid: 1,
      signal: null,
      output: [],
    } as ReturnType<typeof spawnSync>);

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();
    expect(runner.isAvailable).toBe(false);
  });

  it('isAvailable is true when wasmtime --version succeeds', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'wasmtime 19.0.0',
      stderr: '',
      error: undefined,
      pid: 1,
      signal: null,
      output: [],
    } as ReturnType<typeof spawnSync>);

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();
    expect(runner.isAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: run() when not available
// ---------------------------------------------------------------------------

describe('WasmRunner.run() — wasmtime not available', () => {
  it('returns graceful error result with exit=-1', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'not found',
      error: undefined,
      pid: 1,
      signal: null,
      output: [],
    } as ReturnType<typeof spawnSync>);

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();

    const result = runner.run({ module: '/path/to/module.wasm' });

    expect(result.exit).toBe(-1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('wasmtime not available');
    expect(result.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: run() when available
// ---------------------------------------------------------------------------

describe('WasmRunner.run() — wasmtime available', () => {
  it('calls spawnSync with wasmtime + array args (no shell interpolation)', async () => {
    // First call: version check (available)
    // Subsequent calls: run the module
    let callCount = 0;
    mockedSpawnSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // version check
        return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
      }
      // module run
      return { status: 0, stdout: 'hello from wasm', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
    });

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();

    const result = runner.run({ module: '/tmp/test.wasm' });

    expect(result.stdout).toBe('hello from wasm');
    expect(result.exit).toBe(0);
    expect(result.timedOut).toBe(false);

    // Verify spawnSync was called with array args for the run invocation
    const lastCall = mockedSpawnSync.mock.calls[mockedSpawnSync.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe('wasmtime');
    expect(Array.isArray(lastCall[1])).toBe(true);
    const args = lastCall[1] as string[];
    expect(args).toContain('run');
    expect(args).toContain('/tmp/test.wasm');
  });

  it('detects timeout via SIGKILL signal', async () => {
    let callCount = 0;
    mockedSpawnSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
      }
      return { status: null, stdout: '', stderr: '', error: undefined, pid: 1, signal: 'SIGKILL', output: [] } as ReturnType<typeof spawnSync>;
    });

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();

    const result = runner.run({ module: '/tmp/heavy.wasm', timeout_ms: 1000 });
    expect(result.timedOut).toBe(true);
    expect(result.exit).toBe(124);
  });

  it('returns exit code from subprocess', async () => {
    let callCount = 0;
    mockedSpawnSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
      }
      return { status: 42, stdout: '', stderr: 'exit 42', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
    });

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();
    const result = runner.run({ module: '/tmp/fail.wasm' });
    expect(result.exit).toBe(42);
  });

  it('returns error result when module path is empty', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [],
    } as ReturnType<typeof spawnSync>);

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();

    const result = runner.run({ module: '' });
    expect(result.exit).toBe(-1);
    expect(result.stderr).toContain('module path');
  });

  it('passes stdin input to subprocess', async () => {
    let callCount = 0;
    mockedSpawnSync.mockImplementation((_cmd, _args, opts) => {
      callCount++;
      if (callCount === 1) {
        return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
      }
      const inputVal = (opts as Record<string, unknown>)?.['input'] as string | undefined;
      return { status: 0, stdout: `echoed:${inputVal ?? ''}`, stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
    });

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();
    const result = runner.run({ module: '/tmp/echo.wasm', input: 'hello' });
    expect(result.stdout).toBe('echoed:hello');
  });
});

// ---------------------------------------------------------------------------
// Tests: extraArgs allowlist validator (FIX 6)
// ---------------------------------------------------------------------------

describe('WasmRunner.run() — extraArgs allowlist', () => {
  it('rejects --dir /etc in extraArgs (filesystem escape blocked)', async () => {
    // Make wasmtime appear available
    mockedSpawnSync.mockReturnValue({
      status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [],
    } as ReturnType<typeof spawnSync>);

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();

    expect(() => runner.run({ module: '/tmp/test.wasm', extraArgs: ['--dir', '/etc'] }))
      .toThrow('wasm-runner: extraArg "--dir" rejected (filesystem/env escapes forbidden)');
  });

  it('accepts --max-memory 64 in extraArgs (safe flag allowed)', async () => {
    let callCount = 0;
    mockedSpawnSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
      }
      return { status: 0, stdout: 'ok', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
    });

    const { WasmRunner } = await import('../../src/core/sandbox/wasm-runner.js');
    const runner = new WasmRunner();

    expect(() => runner.run({ module: '/tmp/test.wasm', extraArgs: ['--max-memory', '64'] }))
      .not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: sandbox/index.ts exports
// ---------------------------------------------------------------------------

describe('sandbox/index.ts — WasmRunner exports', () => {
  it('exports WasmRunner, wasmRunner, wasmSandboxAvailable, checkWasmAvailability', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 1, stdout: '', stderr: '', error: undefined, pid: 1, signal: null, output: [],
    } as ReturnType<typeof spawnSync>);

    const sandbox = await import('../../src/core/sandbox/index.js');
    expect(sandbox.WasmRunner).toBeDefined();
    expect(sandbox.wasmRunner).toBeDefined();
    expect(typeof sandbox.wasmSandboxAvailable).toBe('boolean');
    expect(typeof sandbox.checkWasmAvailability).toBe('function');
  });
});
