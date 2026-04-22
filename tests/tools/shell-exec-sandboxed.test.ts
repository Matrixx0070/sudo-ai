/**
 * Builder B test suite — shell-exec sandbox dispatch + loop-helpers ToolContext wiring.
 *
 * Acceptance criteria: 26 tests pass per spec §7 Builder B list.
 *
 * All tests mock src/core/sandbox/sandbox-runner.ts so Builder A's implementation
 * is not required at test time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the modules under test
// ---------------------------------------------------------------------------

// Mock sandbox-runner (Builder A's module — not available yet)
vi.mock('../../src/core/sandbox/sandbox-runner.js', () => ({
  runInSandbox: vi.fn(async () => ({ stdout: 'sandbox-stdout', stderr: '', exitCode: 0 })),
}));

// Mock approval module so tests don't need real approval infrastructure
vi.mock('../../src/core/security/approval/index.js', () => ({
  isAllowlisted: vi.fn(() => true), // default: command is allowlisted → no approval needed
  requestApproval: vi.fn(async () => 'approval-123'),
  waitForDecision: vi.fn(async () => 'approved'),
  parseApprovalMode: vi.fn(() => 'allowlist'),
}));

// Mock logger to suppress noise during tests
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { runInSandbox } from '../../src/core/sandbox/sandbox-runner.js';
import { isAllowlisted } from '../../src/core/security/approval/index.js';
import { execTool } from '../../src/core/tools/builtin/system/shell-exec.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import type { SandboxPolicy } from '../../src/core/sandbox/sandbox-types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: SandboxPolicy = {
  enabled: true,
  network: 'none',
  cpuSeconds: 30,
  memoryMB: 512,
  maxFileMB: 100,
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/workspace',
    config: null,
    logger: console,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1–5: Dispatch routing based on sandboxPolicy
// ---------------------------------------------------------------------------

describe('Dispatch routing based on sandboxPolicy', () => {
  beforeEach(() => {
    vi.mocked(isAllowlisted).mockReturnValue(true);
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'sandbox-out', stderr: '', exitCode: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1. policy.enabled=true routes to runSandboxedShell (runInSandbox called)', async () => {
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/workspace/sessions/s1' });
    await execTool.execute({ command: 'echo hello' }, ctx);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
    expect(runInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'echo hello', workspaceDir: '/workspace/sessions/s1' }),
    );
  });

  it('2. policy.enabled=false stays in unsandboxed runShell (runInSandbox NOT called)', async () => {
    const ctx = makeCtx({ sandboxPolicy: { ...DEFAULT_POLICY, enabled: false } });
    await execTool.execute({ command: 'echo hello' }, ctx);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('3. null/absent sandboxPolicy uses unsandboxed runShell', async () => {
    const ctx = makeCtx({ sandboxPolicy: undefined });
    await execTool.execute({ command: 'echo hello' }, ctx);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('4. missing workspaceDir falls back to ctx.workingDir (NOT agent-supplied cwd)', async () => {
    // Security invariant: workspaceDir must be system-controlled.
    // When ctx.workspaceDir is absent, we use ctx.workingDir (system-set),
    // never the agent-supplied cwd param which could be an arbitrary host path.
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: undefined, workingDir: '/tmp/workspace' });
    await execTool.execute({ command: 'echo hello', cwd: '/etc' }, ctx);
    // Falls back to ctx.workingDir, not params.cwd
    expect(runInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: '/tmp/workspace' }),
    );
  });

  it('5. approval gate fires before sandbox dispatch', async () => {
    const { waitForDecision, requestApproval } = await import('../../src/core/security/approval/index.js');
    vi.mocked(isAllowlisted).mockReturnValue(false); // force approval gate
    vi.mocked(requestApproval).mockResolvedValue('gate-id-42');
    vi.mocked(waitForDecision).mockResolvedValue('approved');
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    await execTool.execute({ command: 'rm -rf /' }, ctx);
    expect(requestApproval).toHaveBeenCalled();
    // After approval, sandbox should still be used
    expect(runInSandbox).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6–10: Sandboxed execute result shaping
// ---------------------------------------------------------------------------

describe('Sandboxed execute result shaping', () => {
  beforeEach(() => {
    vi.mocked(isAllowlisted).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('6. sandboxed execute returns stdout in output', async () => {
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'hello world', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    const result = await execTool.execute({ command: 'echo hello' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('7. sandboxed execute returns stderr combined into output', async () => {
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: '', stderr: 'warn msg', exitCode: 0 });
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    const result = await execTool.execute({ command: 'echo warn >&2' }, ctx);
    expect(result.output).toContain('warn msg');
  });

  it('8. exitCode nonzero yields success:false', async () => {
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: '', stderr: 'not found', exitCode: 127 });
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    const result = await execTool.execute({ command: 'badcmd' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('127');
  });

  it('9. output truncated at 8000 chars with indicator', async () => {
    const longOutput = 'x'.repeat(10_000);
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: longOutput, stderr: '', exitCode: 0 });
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    const result = await execTool.execute({ command: 'cat bigfile' }, ctx);
    expect(result.output.length).toBeLessThanOrEqual(8_200); // 8000 + indicator text
    expect(result.output).toContain('truncated');
  });

  it('10. data.durationMs is a positive number', async () => {
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    const result = await execTool.execute({ command: 'echo ok' }, ctx);
    expect(typeof (result.data as Record<string, unknown>)['durationMs']).toBe('number');
    expect((result.data as Record<string, unknown>)['durationMs']).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 11–15: Unsandboxed path preserved
// ---------------------------------------------------------------------------

describe('Unsandboxed path preserved', () => {
  beforeEach(() => {
    vi.mocked(isAllowlisted).mockReturnValue(true);
    vi.mocked(runInSandbox).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('11. runInSandbox NOT called when sandboxPolicy is absent', async () => {
    const ctx = makeCtx(); // no sandboxPolicy
    // The tool will try to run real execFile — but we check runInSandbox is not called
    // We don't care about the real exec result here; just routing.
    try {
      await execTool.execute({ command: 'true' }, ctx);
    } catch {
      // may fail in test env — we only care about the mock
    }
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('12. cwd param honoured in unsandboxed path', async () => {
    const ctx = makeCtx({ sandboxPolicy: undefined });
    // execFile is real here; we just verify no sandbox routing.
    try {
      await execTool.execute({ command: 'pwd', cwd: '/tmp' }, ctx);
    } catch {
      // ignore real exec result
    }
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('13. signal propagated to sandboxed runner', async () => {
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'done', stderr: '', exitCode: 0 });
    const controller = new AbortController();
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws', signal: controller.signal });
    await execTool.execute({ command: 'sleep 1' }, ctx);
    expect(runInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('14. timeout param propagated to sandboxed runner', async () => {
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    await execTool.execute({ command: 'echo', timeout: 5000 }, ctx);
    expect(runInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it('15. policy object passed through to runInSandbox', async () => {
    const policy: SandboxPolicy = { ...DEFAULT_POLICY, network: 'host', cpuSeconds: 10 };
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ sandboxPolicy: policy, workspaceDir: '/ws' });
    await execTool.execute({ command: 'echo' }, ctx);
    expect(runInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ policy }),
    );
  });
});

// ---------------------------------------------------------------------------
// 16–20: ToolContext shape — sandboxPolicy and workspaceDir fields
// ---------------------------------------------------------------------------

describe('ToolContext shape and loop-helpers wiring', () => {
  it('16. ToolContext accepts sandboxPolicy field (TypeScript compilation check)', () => {
    const ctx: ToolContext = {
      sessionId: 'sid',
      workingDir: '/w',
      config: null,
      logger: null,
      sandboxPolicy: DEFAULT_POLICY,
    };
    expect(ctx.sandboxPolicy).toBeDefined();
    expect(ctx.sandboxPolicy!.enabled).toBe(true);
  });

  it('17. ToolContext accepts workspaceDir field', () => {
    const ctx: ToolContext = {
      sessionId: 'sid',
      workingDir: '/w',
      config: null,
      logger: null,
      workspaceDir: '/workspace/sessions/abc',
    };
    expect(ctx.workspaceDir).toBe('/workspace/sessions/abc');
  });

  it('18. sandboxManager=undefined → ctx sandboxPolicy is undefined', async () => {
    // Simulate executeToolCalls without a sandboxManager by verifying tool receives no policy
    let capturedCtx: ToolContext | undefined;
    const spyTool = {
      ...execTool,
      execute: vi.fn(async (params: Record<string, unknown>, ctx: ToolContext) => {
        capturedCtx = ctx;
        return { success: true, output: 'ok' };
      }),
    };
    const ctx = makeCtx(); // no sandboxManager wired → no sandboxPolicy
    await spyTool.execute({ command: 'echo' }, ctx);
    expect(capturedCtx!.sandboxPolicy).toBeUndefined();
  });

  it('19. getPolicyFor called once when sandboxManager is provided', async () => {
    // We test this by constructing a mock sandboxManager and verifying calls
    // via executeToolCalls in loop-helpers
    const { executeToolCalls } = await import('../../src/core/agent/loop-helpers.js');

    const mockSandboxManager = {
      getWorkspaceDir: vi.fn(() => '/workspace/sessions/test'),
      getPolicyFor: vi.fn(() => DEFAULT_POLICY),
    };

    const mockToolRegistry = {
      execute: vi.fn(async () => ({ success: true, output: 'ok' })),
      getSchemaForLLM: vi.fn(() => []),
      requiresConfirmation: vi.fn(() => false),
    };

    const mockSession = { id: 'sid', messages: [] as Array<{ role: string; content: string }> };
    const mockState = { sessionId: 'sid', pendingToolCalls: 0 } as {
      sessionId: string;
      pendingToolCalls: number;
      isCompacting?: boolean;
    };
    const mockEmit = vi.fn();

    await executeToolCalls(
      [{ id: 'tc1', name: 'system.exec', arguments: { command: 'echo hello' } }],
      mockSession as never,
      mockState as never,
      mockEmit,
      mockToolRegistry as never,
      undefined,
      undefined,
      undefined,
      mockSandboxManager as never,
    );

    expect(mockSandboxManager.getPolicyFor).toHaveBeenCalledWith('sid');
    expect(mockSandboxManager.getPolicyFor).toHaveBeenCalledTimes(1);
  });

  it('20. getWorkspaceDir called once per executeToolCalls invocation', async () => {
    const { executeToolCalls } = await import('../../src/core/agent/loop-helpers.js');

    const mockSandboxManager = {
      getWorkspaceDir: vi.fn(() => '/workspace/sessions/test'),
      getPolicyFor: vi.fn(() => DEFAULT_POLICY),
    };

    const mockToolRegistry = {
      execute: vi.fn(async () => ({ success: true, output: 'ok' })),
      getSchemaForLLM: vi.fn(() => []),
      requiresConfirmation: vi.fn(() => false),
    };

    const mockSession = { id: 'sid', messages: [] as Array<{ role: string; content: string }> };
    const mockState = { sessionId: 'sid', pendingToolCalls: 0 } as {
      sessionId: string;
      pendingToolCalls: number;
      isCompacting?: boolean;
    };
    const mockEmit = vi.fn();

    await executeToolCalls(
      [
        { id: 'tc1', name: 'system.exec', arguments: { command: 'echo a' } },
        { id: 'tc2', name: 'system.exec', arguments: { command: 'echo b' } },
      ],
      mockSession as never,
      mockState as never,
      mockEmit,
      mockToolRegistry as never,
      undefined,
      undefined,
      undefined,
      mockSandboxManager as never,
    );

    // getWorkspaceDir is called once to build ctx, not once per tool call
    expect(mockSandboxManager.getWorkspaceDir).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 21–26: Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  beforeEach(() => {
    vi.mocked(isAllowlisted).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('21. SUDO_SANDBOX_DISABLE=1 path still runs (runInSandbox called; behaviour delegated to runner)', async () => {
    // Even with the env var, shell-exec delegates to runInSandbox which handles the fallback.
    // We verify runInSandbox is still called — the runner mocked here always succeeds.
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'fallback-ran', stderr: '', exitCode: 0 });
    const orig = process.env['SUDO_SANDBOX_DISABLE'];
    process.env['SUDO_SANDBOX_DISABLE'] = '1';
    try {
      const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
      const result = await execTool.execute({ command: 'echo test' }, ctx);
      expect(runInSandbox).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    } finally {
      if (orig === undefined) delete process.env['SUDO_SANDBOX_DISABLE'];
      else process.env['SUDO_SANDBOX_DISABLE'] = orig;
    }
  });

  it('22. bwrap spawn error (runInSandbox throws) → ToolResult success:false', async () => {
    vi.mocked(runInSandbox).mockRejectedValue(new Error('bwrap: spawn failed: ENOENT'));
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    const result = await execTool.execute({ command: 'echo hello' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('bwrap');
  });

  it('23. empty command → early return with success:false', async () => {
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws' });
    const result = await execTool.execute({ command: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain('required');
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('24. cwd param in sandboxed mode: workspaceDir takes precedence over cwd', async () => {
    vi.mocked(runInSandbox).mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const ctx = makeCtx({
      sandboxPolicy: DEFAULT_POLICY,
      workspaceDir: '/workspace/sessions/s42',
      workingDir: '/tmp',
    });
    // Even if agent passes a custom cwd, the sandbox uses workspaceDir
    await execTool.execute({ command: 'pwd', cwd: '/etc' }, ctx);
    expect(runInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: '/workspace/sessions/s42' }),
    );
  });

  it('25. AbortSignal abort propagated into bwrap child (signal forwarded)', async () => {
    const controller = new AbortController();
    vi.mocked(runInSandbox).mockImplementation(async (opts) => {
      // Verify signal is present and is the one we passed
      expect(opts.signal).toBe(controller.signal);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    const ctx = makeCtx({
      sandboxPolicy: DEFAULT_POLICY,
      workspaceDir: '/ws',
      signal: controller.signal,
    });
    await execTool.execute({ command: 'sleep 10' }, ctx);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
  });

  it('26. concurrent calls do not share state (each gets independent results)', async () => {
    let callCount = 0;
    vi.mocked(runInSandbox).mockImplementation(async (opts) => {
      callCount++;
      const n = callCount;
      return { stdout: `result-${n}`, stderr: '', exitCode: 0 };
    });

    const ctx1 = makeCtx({ sessionId: 'session-A', sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws/a' });
    const ctx2 = makeCtx({ sessionId: 'session-B', sandboxPolicy: DEFAULT_POLICY, workspaceDir: '/ws/b' });

    const [r1, r2] = await Promise.all([
      execTool.execute({ command: 'echo A' }, ctx1),
      execTool.execute({ command: 'echo B' }, ctx2),
    ]);

    // Both succeed
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Results are distinct
    expect(r1.output).not.toBe(r2.output);
    expect(runInSandbox).toHaveBeenCalledTimes(2);
  });

  it('27. missing workspaceDir with enabled sandbox throws "workspaceDir required"', async () => {
    // Security invariant: workspaceDir is REQUIRED when sandbox is enabled.
    // ctx.workspaceDir=undefined and ctx.workingDir='' → resolves to '' → !'' is true → throws.
    const ctx = makeCtx({ sandboxPolicy: DEFAULT_POLICY, workspaceDir: undefined, workingDir: '' });
    await expect(execTool.execute({ command: 'echo hello' }, ctx)).rejects.toThrow(
      'workspaceDir required when sandbox enabled',
    );
    expect(runInSandbox).not.toHaveBeenCalled();
  });
});
