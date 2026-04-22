/**
 * Tests for computer-use-tool.ts
 *
 * NOTE: This file is the canonical runnable test. A spec-path copy also exists
 * at src/core/tools/builtin/browser/__tests__/computer-use-tool.test.ts but
 * vitest.config.ts includes only 'tests/**\/*.test.ts', so that path is not
 * auto-discovered. This file satisfies the `pnpm test -- computer-use-tool`
 * requirement. Deviation logged in deliverable report.
 *
 * Tests:
 *   1. screenshot action skips window guard, calls executeComputerAction
 *   2. click action with getwindowname returning "Terminal" → returns blocked error
 *   3. click action with getwindowname returning "Firefox" → calls executeComputerAction
 *   4. DISPLAY env defaults to :10.0 when unset
 *   5. registerComputerUseTools registers name 'computer.use'
 *
 * Mocking strategy:
 *   - vi.mock('child_process') to control execAsync (window guard)
 *   - vi.mock('../src/...computer-use.js') to control executeComputerAction (delegation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '../../src/core/tools/types.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';

// ---------------------------------------------------------------------------
// Mock child_process — controls the xdotool getwindowname call
// ---------------------------------------------------------------------------

const mockExec = vi.fn();

vi.mock('child_process', () => ({
  exec: mockExec,
}));

// ---------------------------------------------------------------------------
// Mock computer-use.js — controls the executeComputerAction delegate
// ---------------------------------------------------------------------------

const mockExecuteComputerAction = vi.fn();

vi.mock('../../src/core/tools/builtin/browser/computer-use.js', () => ({
  executeComputerAction: mockExecuteComputerAction,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/test',
    config: null,
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
  };
}

/**
 * Set up mockExec so that util.promisify(exec)(cmd) resolves with the given
 * stdout value. util.promisify wraps the Node-style callback form.
 */
function setupExecMock(stdout: string): void {
  mockExec.mockImplementation(
    (_cmd: string, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout, stderr: '' });
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computer-use-tool', () => {
  let originalDisplay: string | undefined;

  beforeEach(() => {
    originalDisplay = process.env['DISPLAY'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDisplay === undefined) {
      delete process.env['DISPLAY'];
    } else {
      process.env['DISPLAY'] = originalDisplay;
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: screenshot action skips window guard, calls executeComputerAction
  // -------------------------------------------------------------------------
  it('Test 1: screenshot action skips window guard and calls executeComputerAction', async () => {
    mockExecuteComputerAction.mockResolvedValue({
      action: 'screenshot',
      success: true,
      screenshot: 'base64data==',
    });

    const { computerUseTool } = await import(
      '../../src/core/tools/builtin/browser/computer-use-tool.js'
    );
    const result = await computerUseTool.execute({ action: 'screenshot' }, makeCtx());

    // Window guard must not have run (no exec call for screenshot).
    expect(mockExec).not.toHaveBeenCalled();

    // executeComputerAction called with screenshot.
    expect(mockExecuteComputerAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'screenshot' }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('screenshot captured');
    expect((result.data as { screenshot: string }).screenshot).toBe('base64data==');
  });

  // -------------------------------------------------------------------------
  // Test 2: click blocked when active window is "Terminal"
  // -------------------------------------------------------------------------
  it('Test 2: click action returns blocked error when window name starts with "Terminal"', async () => {
    setupExecMock('Terminal — Bash');

    const { computerUseTool } = await import(
      '../../src/core/tools/builtin/browser/computer-use-tool.js'
    );
    const result = await computerUseTool.execute(
      { action: 'click', x: 100, y: 200 },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('blocked');
    expect(result.output).toContain('MEMORY.md isolation rule');

    // executeComputerAction must NOT have been called.
    expect(mockExecuteComputerAction).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: click proceeds when active window is "Firefox"
  // -------------------------------------------------------------------------
  it('Test 3: click action calls executeComputerAction when window is "Firefox"', async () => {
    setupExecMock('Firefox');

    mockExecuteComputerAction.mockResolvedValue({
      action: 'click(100,200)',
      success: true,
    });

    const { computerUseTool } = await import(
      '../../src/core/tools/builtin/browser/computer-use-tool.js'
    );
    const result = await computerUseTool.execute(
      { action: 'click', x: 100, y: 200 },
      makeCtx(),
    );

    expect(mockExecuteComputerAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'click', x: 100, y: 200 }),
    );
    expect(result.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: DISPLAY defaults to :10.0 when not set
  // -------------------------------------------------------------------------
  it('Test 4: DISPLAY env defaults to :10.0 when unset', async () => {
    delete process.env['DISPLAY'];

    setupExecMock('xterm');

    mockExecuteComputerAction.mockResolvedValue({
      action: 'key(Return)',
      success: true,
    });

    const { computerUseTool } = await import(
      '../../src/core/tools/builtin/browser/computer-use-tool.js'
    );
    await computerUseTool.execute({ action: 'key', key: 'Return' }, makeCtx());

    expect(process.env['DISPLAY']).toBe(':10.0');
  });

  // -------------------------------------------------------------------------
  // Test 5: registerComputerUseTools registers 'computer.use'
  // -------------------------------------------------------------------------
  it('Test 5: registerComputerUseTools registers tool with name "computer.use"', async () => {
    const { registerComputerUseTools } = await import(
      '../../src/core/tools/builtin/browser/computer-use-tool.js'
    );
    const registry = new ToolRegistry();

    registerComputerUseTools(registry);

    const names = registry.listEnabled().map((t) => t.name);
    expect(names).toContain('computer.use');
  });
});
