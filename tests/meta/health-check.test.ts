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

// ---------------------------------------------------------------------------
// checkPort / checkServices — false-CRITICAL regression (gateway binds
// 127.0.0.1 IPv4-only; probe must target 127.0.0.1 and a down port must be
// WARN, not CRITICAL)
// ---------------------------------------------------------------------------

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkPort, checkServices } from '../../src/core/tools/builtin/meta/health-check.js';

describe('checkPort / checkServices', () => {
  it('probe succeeds against a 127.0.0.1-only listener (any HTTP response)', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404; // non-200 must still count as "port served"
      res.end('nope');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await checkPort(port, 'test-listener', 2000);
      expect(result.ok).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('a down gateway port yields WARN, never CRITICAL', async () => {
    const server = http.createServer((_req, res) => res.end('x'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const freePort = (server.address() as AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));

    const saved = process.env['GATEWAY_PORT'];
    process.env['GATEWAY_PORT'] = String(freePort); // nothing listens here now
    try {
      const result = await checkServices();
      expect(result.status).toBe('WARN');
    } finally {
      if (saved === undefined) delete process.env['GATEWAY_PORT'];
      else process.env['GATEWAY_PORT'] = saved;
    }
  });
});
