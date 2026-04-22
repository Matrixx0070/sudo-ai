/**
 * Tests for computer-use-tool.ts
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
 *   - vi.mock('../computer-use.js') to control executeComputerAction (delegation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '../../../types.js';
import { ToolRegistry } from '../../../registry.js';

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

vi.mock('../computer-use.js', () => ({
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
 * Set up mockExec so that util.promisify(exec)(cmd, callback) resolves with
 * the given stdout value.
 *
 * util.promisify converts the Node-style (cmd, callback) signature into a
 * promise. We need the mock to call the callback with (null, { stdout, stderr }).
 */
function setupExecMock(stdout: string): void {
  mockExec.mockImplementation(
    (_cmd: string, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout, stderr: '' });
    },
  );
}

/**
 * Set up mockExec to simulate an error (no active window / no display).
 */
function setupExecErrorMock(error: Error): void {
  mockExec.mockImplementation(
    (_cmd: string, callback: (err: Error) => void) => {
      callback(error);
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
    // Restore DISPLAY so tests don't leak env state.
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
    // Screenshot must NOT invoke execAsync (no window guard).
    // The exec mock should not be called.
    mockExecuteComputerAction.mockResolvedValue({
      action: 'screenshot',
      success: true,
      screenshot: 'base64data==',
    });

    // Dynamic import after mocks are in place.
    const { computerUseTool } = await import('../computer-use-tool.js');
    const result = await computerUseTool.execute({ action: 'screenshot' }, makeCtx());

    // execAsync was not called (window guard skipped for screenshot).
    expect(mockExec).not.toHaveBeenCalled();

    // executeComputerAction was called with screenshot action.
    expect(mockExecuteComputerAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'screenshot' }),
    );

    // Result shape for screenshot.
    expect(result.success).toBe(true);
    expect(result.output).toBe('screenshot captured');
    expect((result.data as { screenshot: string }).screenshot).toBe('base64data==');
  });

  // -------------------------------------------------------------------------
  // Test 2: click blocked when active window is "Terminal"
  // -------------------------------------------------------------------------
  it('Test 2: click action returns blocked error when window name starts with "Terminal"', async () => {
    setupExecMock('Terminal — Bash');

    const { computerUseTool } = await import('../computer-use-tool.js');
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

    const { computerUseTool } = await import('../computer-use-tool.js');
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

    // Simulate a safe window so the guard passes.
    setupExecMock('xterm');

    mockExecuteComputerAction.mockResolvedValue({
      action: 'key(Return)',
      success: true,
    });

    const { computerUseTool } = await import('../computer-use-tool.js');
    await computerUseTool.execute({ action: 'key', key: 'Return' }, makeCtx());

    // After the execute call, DISPLAY must have been set to :10.0.
    expect(process.env['DISPLAY']).toBe(':10.0');
  });

  // -------------------------------------------------------------------------
  // Test 5: registerComputerUseTools registers 'computer.use'
  // -------------------------------------------------------------------------
  it('Test 5: registerComputerUseTools registers tool with name "computer.use"', async () => {
    const { registerComputerUseTools } = await import('../computer-use-tool.js');
    const registry = new ToolRegistry();

    registerComputerUseTools(registry);

    const names = registry.listEnabled().map((t) => t.name);
    expect(names).toContain('computer.use');
  });
});
