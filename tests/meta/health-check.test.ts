/**
 * @file tests/meta/health-check.test.ts
 * @description Tests for meta.health-check tool — validates pid field addition to full action
 *   and verifies other actions remain unaffected.
 */

import { describe, it, expect } from 'vitest';
import type { ToolContext, ToolResult } from '../../src/core/tools/types.js';
import { healthCheckTool } from '../../src/core/tools/builtin/meta/health-check.js';

// ---------------------------------------------------------------------------
// Minimal stub context — no registry needed for these checks
// ---------------------------------------------------------------------------

const stubCtx: ToolContext = {
  sessionId: 'test-session',
  config: {},
};

// ---------------------------------------------------------------------------
// Helper — invoke tool and assert success
// ---------------------------------------------------------------------------

async function invoke(action: string): Promise<ToolResult & { data: Record<string, unknown> }> {
  const result = await healthCheckTool.execute({ action }, stubCtx);
  if (!result.success) {
    throw new Error(`health-check '${action}' returned success=false: ${result.output}`);
  }
  return result as ToolResult & { data: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('meta.health-check', () => {
  it('full action: data.pid equals process.pid', async () => {
    const result = await invoke('full');
    expect(result.data.pid).toBe(process.pid);
    expect(typeof result.data.pid).toBe('number');
  });

  it('full action: nested path data.sections.Process.details.pid still present', async () => {
    const result = await invoke('full');
    const sections = result.data.sections as Record<string, { details?: Record<string, unknown> }>;
    expect(sections['Process']?.details?.pid).toBe(process.pid);
  });

  it('full action: data.overall is a valid status', async () => {
    const result = await invoke('full');
    expect(['OK', 'WARN', 'CRITICAL']).toContain(result.data.overall);
  });

  it('full action: data.timestamp is ISO string', async () => {
    const result = await invoke('full');
    expect(isNaN(Date.parse(result.data.timestamp as string))).toBe(false);
  });

  it('system action: does not include top-level pid field', async () => {
    const result = await invoke('system');
    expect(Object.prototype.hasOwnProperty.call(result.data, 'pid')).toBe(false);
  });
});
