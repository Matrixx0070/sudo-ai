/**
 * @file tests/meta/synth-seccomp.test.ts
 * @description Wave 2.2g — 8 unit/integration tests for the seccomp BPF filter.
 *
 * Tests 1-7: pure unit tests against compileSynthBpfFilter() + _resetFilterCache()
 *            from synth-seccomp-filter.ts (Builder A).
 * Test 8:    scoped mock integration — SIGSYS from bwrap child maps to
 *            SECCOMP_VIOLATION in tool.synthesize execute() output.
 *
 * NO real bwrap spawns. Total runtime < 3 seconds.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Static mocks — scoped to this file, do not affect other test suites.
// These are needed only for Test 8 (tool.synthesize execute pipeline).
// Tests 1-7 only import synth-seccomp-filter.ts which has no deps on these.
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
// Default child_process mock: emits success response via stdout+close(0).
// Test 8 overrides this per-test via vi.doMock + vi.resetModules().
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => {
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
// Imports — BPF filter module (static; Builder A's file)
// ---------------------------------------------------------------------------

import {
  compileSynthBpfFilter,
  _resetFilterCache,
} from '../../src/core/tools/builtin/meta/synth-seccomp-filter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Scan every BPF instruction in `buf` for a JEQ (0x15) matching NR `nr` with jt > 0. */
function findAllowlistJeq(buf: Buffer, nr: number): boolean {
  const instrCount = buf.length / 8;
  for (let i = 0; i < instrCount; i++) {
    const code = buf.readUInt16LE(i * 8);
    const jt   = buf.readUInt8(i * 8 + 2);
    const k    = buf.readUInt32LE(i * 8 + 4);
    if (code === 0x15 && k === nr && jt > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Wave 2.2g seccomp BPF filter — 8 tests
// ---------------------------------------------------------------------------

describe('Wave 2.2g seccomp BPF filter', () => {

  // Ensure the module-level cache starts clean before this suite runs.
  beforeAll(() => {
    _resetFilterCache();
  });

  // Re-enable kill-switch for Tests 1-7 (make sure seccomp is ON by default).
  beforeEach(() => {
    delete process.env['SUDO_SECCOMP_DISABLE'];
  });

  // -------------------------------------------------------------------------
  // Test 1 — Buffer structure
  // -------------------------------------------------------------------------
  it('returns a Buffer whose length is a multiple of 8 and greater than 40 bytes', () => {
    const buf = compileSynthBpfFilter();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length % 8).toBe(0);
    expect(buf.length).toBeGreaterThan(40);
  });

  // -------------------------------------------------------------------------
  // Test 2 — First instruction is arch LD
  // -------------------------------------------------------------------------
  it('first instruction loads the architecture field (BPF_LD|BPF_W|BPF_ABS at ARCH_OFFSET=4)', () => {
    const buf = compileSynthBpfFilter();
    // code field (bytes 0-1 LE) must be 0x20 (BPF_LD | BPF_W | BPF_ABS)
    expect(buf.readUInt16LE(0)).toBe(0x20);
    // k field (bytes 4-7 LE) must be 4 (seccomp_data.arch offset)
    expect(buf.readUInt32LE(4)).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Second instruction is arch JEQ (AUDIT_ARCH_X86_64, jt=1)
  // -------------------------------------------------------------------------
  it('second instruction is JEQ AUDIT_ARCH_X86_64 with jt=1 (wrong arch → kill)', () => {
    const buf = compileSynthBpfFilter();
    // code at byte offset 8 (instruction index 1) must be 0x15 (BPF_JMP|BPF_JEQ|BPF_K)
    expect(buf.readUInt16LE(8)).toBe(0x15);
    // k at byte offset 12 must be AUDIT_ARCH_X86_64 = 0xC000003E
    expect(buf.readUInt32LE(12)).toBe(0xC000003E);
    // jt at byte offset 10 must be 1 (jump past the KILL instruction)
    expect(buf.readUInt8(10)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 4 — mmap (NR 9) is in allowlist
  // -------------------------------------------------------------------------
  it('mmap (NR 9) has a JEQ allowlist instruction (jt > 0)', () => {
    const buf = compileSynthBpfFilter();
    expect(findAllowlistJeq(buf, 9)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5 — ptrace (NR 101) is NOT in allowlist
  // -------------------------------------------------------------------------
  it('ptrace (NR 101) has no JEQ allowlist instruction (must be denied via SIGSYS)', () => {
    const buf = compileSynthBpfFilter();
    expect(findAllowlistJeq(buf, 101)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6 — Cache returns same reference
  // -------------------------------------------------------------------------
  it('calling compileSynthBpfFilter() twice returns the exact same Buffer reference', () => {
    const first  = compileSynthBpfFilter();
    const second = compileSynthBpfFilter();
    expect(first === second).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7 — _resetFilterCache forces recompile
  // -------------------------------------------------------------------------
  it('_resetFilterCache() causes recompile: new instance (different ref) but identical content', () => {
    const buf1 = compileSynthBpfFilter();
    _resetFilterCache();
    const buf2 = compileSynthBpfFilter();
    // Must be a different object
    expect(buf1 === buf2).toBe(false);
    // But must have identical bytes
    expect(buf1.equals(buf2)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8 — SIGSYS maps to SECCOMP_VIOLATION in tool.synthesize execute()
  //
  // Uses vi.doMock + vi.resetModules() to scope the SIGSYS-emitting child_process
  // mock exclusively to this test — it does NOT leak to Tests 1-7.
  //
  // SUDO_SECCOMP_DISABLE=1 is set so getSynthBpfFilter() returns null,
  // which prevents the code from writing to child.stdio[3] (simplifying the mock).
  // The SIGSYS→SECCOMP_VIOLATION close-handler path at L736-748 is unconditional
  // on the disable state — the mapping is exercised regardless.
  // -------------------------------------------------------------------------
  it('SIGSYS close signal maps to SECCOMP_VIOLATION in tool.synthesize execute() output', async () => {
    // Reset module registry so fresh imports pick up our doMock below.
    vi.resetModules();

    // Override child_process for this test only: emit close(null, 'SIGSYS') with no stdout.
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
        // No stdout data event — emit only close with SIGSYS signal
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

    // Disable seccomp filter write so stdio[3] path is not exercised in mock.
    process.env['SUDO_SECCOMP_DISABLE'] = '1';
    // Enable synthesize so execute() does not bail out at the kill-switch.
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';

    try {
      // Dynamic import picks up the fresh doMock override.
      const { synthesizeTool } = await import(
        '../../src/core/tools/builtin/meta/tool-synthesize.js'
      );

      const ctx = {
        sessionId:  'test-sigsys',
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

      const result = await synthesizeTool.execute({ toolName: 'fake.sigsys-tool', spec: 'a tool' }, ctx as never);

      expect(result.success).toBe(false);
      expect((result.output as string)).toContain('SECCOMP_VIOLATION');
    } finally {
      // Clean up env regardless of test outcome.
      delete process.env['SUDO_SECCOMP_DISABLE'];
      delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    }
  });

});
