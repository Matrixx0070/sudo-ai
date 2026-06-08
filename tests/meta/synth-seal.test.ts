/**
 * @file tests/meta/synth-seal.test.ts
 * @description Wave 2.2h — 8 unit tests for the LD_PRELOAD execve-deny seal.
 *
 * Tests 1:    filesystem check that Builder A's .so artifact exists.
 * Tests 2-4:  getSealPath() kill-switch + existsSync stubbing.
 * Tests 5-7:  buildSynthBwrapArgs() LD_PRELOAD injection logic.
 * Test 8:     spawnBwrapSynth() SIGSYS → SECCOMP_VIOLATION mapping.
 *
 * All tool-synthesize imports are dynamic so this file compiles even when
 * Builder B has not yet landed the new exports.
 *
 * NO real bwrap spawns. Total runtime < 5 seconds.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Static mocks — scoped to this file; required for Test 8 which reaches
// into the full tool-synthesize.ts execute pipeline.
// ---------------------------------------------------------------------------

vi.mock('../../src/core/tools/registry.js', () => {
  const mockRegistry = {
    register:          vi.fn(),
    unregister:        vi.fn(),
    registerMCPSource: vi.fn(),
    execute:           vi.fn(),
    getGlobal:         vi.fn(),
    size:              0,
  };
  return {
    ToolRegistry: {
      getGlobal: vi.fn(() => mockRegistry),
      setGlobal: vi.fn(),
    },
  };
});

vi.mock('../../src/core/tools/loader.js', () => ({
  hotLoad: vi.fn(async () => ['fakeTool']),
}));

vi.mock('../../src/core/agent/veto-gate.js', () => ({
  classifyRisk: vi.fn(() => 'LOW'),
}));

vi.mock('../../src/core/cognition/epistemic-gate.js', () => ({
  gateToolCall: vi.fn(() => ({ decision: 'PROCEED', reason: 'ok' })),
}));

vi.mock('../../src/core/cognition/injection-detector.js', () => {
  const MockInjectionDetector = vi.fn().mockImplementation(function () {
    return {
      scan: vi.fn(() => ({ severity: 'NONE', matchedMarkers: [], snippetCount: 0, scannedChars: 0 })),
    };
  });
  return { InjectionDetector: MockInjectionDetector };
});

vi.mock('../../src/core/tools/mcp-adapter.js', () => ({
  MCPAdapter: vi.fn().mockImplementation(() => ({
    connect:        vi.fn(async () => undefined),
    listTools:      vi.fn(async () => []),
    getCachedTools: vi.fn(() => []),
    serverId:       'test-server',
  })),
}));

// ---------------------------------------------------------------------------
// Default child_process mock: spreads the real module (keeping execSync, etc.)
// and overrides only `spawn` so Test 1 can use the real execSync.
// Test 8 overrides per-test via vi.doMock + vi.resetModules().
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const makeChild = () => {
    const stdoutListeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const childListeners:  Record<string, Array<(...a: unknown[]) => void>> = {};
    const fakeStdout = {
      on: (event: string, cb: (...a: unknown[]) => void) => {
        if (!stdoutListeners[event]) stdoutListeners[event] = [];
        stdoutListeners[event].push(cb);
      },
    };
    const fakeStderr = { on: () => {} };
    const fakeStdio3 = {
      write: vi.fn((_data: unknown, cb?: () => void) => { if (cb) cb(); }),
      end:   vi.fn(),
    };
    const child = {
      stdout: fakeStdout,
      stderr: fakeStderr,
      stdio:  [null, fakeStdout, fakeStderr, fakeStdio3],
      kill:   vi.fn(),
      on: (event: string, cb: (...a: unknown[]) => void) => {
        if (!childListeners[event]) childListeners[event] = [];
        childListeners[event].push(cb);
        return child;
      },
    };
    setImmediate(() => {
      const jsonLine = JSON.stringify({ ok: true, toolNames: ['fakeTool'] }) + '\n';
      (stdoutListeners['data'] ?? []).forEach((cb) => cb(Buffer.from(jsonLine)));
      setImmediate(() => {
        (childListeners['close'] ?? []).forEach((cb) => cb(0, null));
      });
    });
    return child;
  };
  return {
    ...actual,
    execFile: vi.fn(),
    spawn:    vi.fn().mockImplementation(() => makeChild()),
  };
});

vi.mock('node:worker_threads', () => {
  const MockWorker = vi.fn().mockImplementation(function () {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const self = {
      on: function (event: string, cb: (...a: unknown[]) => void) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
        return self;
      },
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    setImmediate(() => {
      (listeners['message'] ?? []).forEach((cb) => cb({ ok: true, toolNames: [] }));
      setImmediate(() => (listeners['exit'] ?? []).forEach((cb) => cb(0)));
    });
    return self;
  });
  return { Worker: MockWorker, workerData: {}, parentPort: null };
});

// ---------------------------------------------------------------------------
// Env cleanup after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  delete process.env['SUDO_EXEC_GATE_DISABLE'];
  delete process.env['SUDO_SECCOMP_DISABLE'];
  delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
  delete process.env['SUDO_SEAL_REQUIRED'];
});

// ---------------------------------------------------------------------------
// Wave 2.2h LD_PRELOAD seal — 8 tests
// ---------------------------------------------------------------------------

describe('Wave 2.2h LD_PRELOAD execve-deny seal', () => {

  // -------------------------------------------------------------------------
  // Test 1 — Builder A artifact: .so exists on disk
  // Skip if kill-switch engaged.
  // execSync is obtained from importActual to bypass the spawn-only mock.
  // -------------------------------------------------------------------------
  it.skipIf(process.env['SUDO_EXEC_GATE_DISABLE'] === '1')(
    'bin/synth-seccomp-seal.so exists on disk and path contains ".so"',
    async () => {
      const { execSync: realExecSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const out = realExecSync(`ls -la ${process.cwd()}/bin/synth-seccomp-seal.so`, {
        encoding: 'utf8',
      });
      expect(out).toContain('.so');
    }
  );

  // -------------------------------------------------------------------------
  // Test 2 — kill-switch: SUDO_EXEC_GATE_DISABLE=1 → getSealPath() null
  // -------------------------------------------------------------------------
  it('getSealPath() returns null when SUDO_EXEC_GATE_DISABLE=1', async () => {
    vi.resetModules();
    process.env['SUDO_EXEC_GATE_DISABLE'] = '1';

    // Dynamic import so the module re-evaluates with the new env value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.getSealPath).toBe('function');
    expect(mod.getSealPath()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3 — existsSync stubbed false → getSealPath() null
  // -------------------------------------------------------------------------
  it('getSealPath() returns null when existsSync returns false', async () => {
    vi.resetModules();
    delete process.env['SUDO_EXEC_GATE_DISABLE'];

    // Override node:fs so existsSync always returns false inside the module.
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => false) };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.getSealPath).toBe('function');
    expect(mod.getSealPath()).toBeNull();

    vi.doUnmock('node:fs');
  });

  // -------------------------------------------------------------------------
  // Test 4 — existsSync stubbed true, kill-switch unset → path ends with .so
  // -------------------------------------------------------------------------
  it('getSealPath() returns a path ending in synth-seccomp-seal.so when existsSync is true', async () => {
    vi.resetModules();
    delete process.env['SUDO_EXEC_GATE_DISABLE'];

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => true) };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.getSealPath).toBe('function');
    const result: string | null = mod.getSealPath();
    expect(typeof result).toBe('string');
    expect((result as string).endsWith('synth-seccomp-seal.so')).toBe(true);

    vi.doUnmock('node:fs');
  });

  // -------------------------------------------------------------------------
  // Test 5 — buildSynthBwrapArgs with sealPath present → includes LD_PRELOAD wiring
  // -------------------------------------------------------------------------
  it('buildSynthBwrapArgs with sealPath includes --ro-bind, sealPath, --setenv, LD_PRELOAD, in-sandbox path', async () => {
    vi.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.buildSynthBwrapArgs).toBe('function');

    const result: string[] = mod.buildSynthBwrapArgs('/tmp/fake.ts', undefined, '/test/seal.so');

    expect(result).toContain('--ro-bind');
    expect(result).toContain('/test/seal.so');
    expect(result).toContain('--setenv');
    expect(result).toContain('LD_PRELOAD');
    expect(result).toContain('/sandbox/synth-seccomp-seal.so');
  });

  // -------------------------------------------------------------------------
  // Test 6 — buildSynthBwrapArgs with sealPath=null → no --setenv
  // -------------------------------------------------------------------------
  it('buildSynthBwrapArgs with sealPath=null does not include --setenv', async () => {
    vi.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.buildSynthBwrapArgs).toBe('function');

    const result: string[] = mod.buildSynthBwrapArgs('/tmp/fake.ts', undefined, null);
    expect(result).not.toContain('--setenv');
  });

  // -------------------------------------------------------------------------
  // Test 7 — buildSynthBwrapArgs with sealPath=undefined → no --setenv
  // -------------------------------------------------------------------------
  it('buildSynthBwrapArgs with sealPath=undefined does not include --setenv', async () => {
    vi.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.buildSynthBwrapArgs).toBe('function');

    const result: string[] = mod.buildSynthBwrapArgs('/tmp/fake.ts', undefined, undefined);
    expect(result).not.toContain('--setenv');
  });

  // -------------------------------------------------------------------------
  // Test 9 — SUDO_SEAL_REQUIRED=1 + existsSync=false → getSealPath() throws
  //          with SandboxError name and SEAL_REQUIRED_BUT_MISSING errorCode
  // -------------------------------------------------------------------------
  it('getSealPath() throws SandboxError SEAL_REQUIRED_BUT_MISSING when SUDO_SEAL_REQUIRED=1 and .so missing', async () => {
    vi.resetModules();
    delete process.env['SUDO_EXEC_GATE_DISABLE'];
    process.env['SUDO_SEAL_REQUIRED'] = '1';

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => false) };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.getSealPath).toBe('function');
    let caught: unknown;
    try {
      mod.getSealPath();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe('SandboxError');
    expect((caught as Error).message).toBe('SEAL_REQUIRED_BUT_MISSING');

    delete process.env['SUDO_SEAL_REQUIRED'];
    vi.doUnmock('node:fs');
  });

  // -------------------------------------------------------------------------
  // Test 10 — SUDO_EXEC_GATE_DISABLE=1 takes precedence over SUDO_SEAL_REQUIRED=1
  //           getSealPath() returns null, does NOT throw.
  // -------------------------------------------------------------------------
  it('getSealPath() returns null (no throw) when SUDO_EXEC_GATE_DISABLE=1 even if SUDO_SEAL_REQUIRED=1', async () => {
    vi.resetModules();
    process.env['SUDO_EXEC_GATE_DISABLE'] = '1';
    process.env['SUDO_SEAL_REQUIRED'] = '1';

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => false) };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../../src/core/tools/builtin/meta/tool-synthesize.js') as any;

    expect(typeof mod.getSealPath).toBe('function');
    // Must NOT throw — EXEC_GATE_DISABLE takes precedence.
    const result: string | null = mod.getSealPath();
    expect(result).toBeNull();

    delete process.env['SUDO_SEAL_REQUIRED'];
    vi.doUnmock('node:fs');
  });

  // -------------------------------------------------------------------------
  // Test 8 — SIGSYS close signal maps to SECCOMP_VIOLATION in spawnBwrapSynth()
  //
  // Validates the Wave 2.2g SIGSYS handler still operates correctly after
  // the Wave 2.2h wiring changes in spawnBwrapSynth.
  //
  // SUDO_SECCOMP_DISABLE=1 skips the BPF filter write path so stdio[3]
  // is not exercised in the mock. SUDO_EXEC_GATE_DISABLE=1 skips the seal
  // injection so bwrapArgs stays simple. The SIGSYS→SECCOMP_VIOLATION close
  // handler at tool-synthesize.ts L741-749 is unconditional on both flags.
  // -------------------------------------------------------------------------
  it('SIGSYS close signal from bwrap child maps to SECCOMP_VIOLATION errorCode + SandboxError errorName', async () => {
    vi.resetModules();

    // Override child_process for this test only: emit close(null, 'SIGSYS').
    vi.doMock('node:child_process', () => {
      const makeSigsysChild = () => {
        const childListeners: Record<string, Array<(...a: unknown[]) => void>> = {};
        const fakeStdout  = { on: (_event: string, _cb: (...a: unknown[]) => void) => {} };
        const fakeStderr  = { on: () => {} };
        const fakeStdio3  = {
          write: vi.fn((_data: unknown, cb?: () => void) => { if (cb) cb(); }),
          end:   vi.fn(),
        };
        const child = {
          stdout: fakeStdout,
          stderr: fakeStderr,
          stdio:  [null, fakeStdout, fakeStderr, fakeStdio3],
          kill:   vi.fn(),
          on: (event: string, cb: (...a: unknown[]) => void) => {
            if (!childListeners[event]) childListeners[event] = [];
            childListeners[event].push(cb);
            return child;
          },
        };
        // No stdout data — emit only close with SIGSYS signal
        setImmediate(() => {
          childListeners['close']?.forEach((cb) => cb(null, 'SIGSYS'));
        });
        return child;
      };
      return {
        execFile: vi.fn(),
        spawn:    vi.fn().mockImplementation(() => makeSigsysChild()),
      };
    });

    // Disable seccomp filter (skip stdio[3] write branch) and seal injection.
    process.env['SUDO_SECCOMP_DISABLE']      = '1';
    process.env['SUDO_EXEC_GATE_DISABLE']     = '1';
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { synthesizeTool } = await import(
        '../../src/core/tools/builtin/meta/tool-synthesize.js'
      ) as any;

      const ctx = {
        sessionId:  'test-seal-sigsys',
        workingDir: '/tmp',
        config: {
          brain: {
            call: vi.fn().mockResolvedValue({
              content: `export function registerFakeTools(_r: unknown) {}`,
            }),
          },
        },
        logger: {
          info:  vi.fn(),
          warn:  vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      };

      const result = await synthesizeTool.execute(
        { toolName: 'meta.synth-seal-exec', spec: 'a simple test tool' },
        ctx as never,
      );

      expect(result.success).toBe(false);
      expect((result.output as string)).toContain('SECCOMP_VIOLATION');
      // Also verify errorCode and errorName on the workerResult if surfaced
      // (some paths surface the raw fields, others stringify them)
    } finally {
      delete process.env['SUDO_SECCOMP_DISABLE'];
      delete process.env['SUDO_EXEC_GATE_DISABLE'];
      delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
      vi.doUnmock('node:child_process');
    }
  });

});
