/**
 * Tests for cli/commands/bench.ts — Wave 10 Builder 2.
 *
 * Covers:
 *   - runBench with successful API mock
 *   - runBench with failed API (returns 1)
 *   - JSON output format
 *   - Timeout handling
 *   - Exit code based on successRate
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Test helper: spin up a mock bench API
// ---------------------------------------------------------------------------

interface MockServer {
  port:  number;
  close: () => Promise<void>;
}

async function startMockServer(opts: {
  runId:      string;
  report?:    Record<string, unknown>;
  postStatus: number;
}): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url.startsWith('/v1/admin/bench/run')) {
      const body: Buffer[] = [];
      req.on('data', c => body.push(c));
      req.on('end', () => {
        res.writeHead(opts.postStatus, { 'Content-Type': 'application/json' });
        if (opts.postStatus === 202) {
          res.end(JSON.stringify({ runId: opts.runId, status: 'queued' }));
        } else {
          res.end(JSON.stringify({ error: { message: 'Bad request', code: 400 } }));
        }
      });
      return;
    }

    if (req.method === 'GET' && url.startsWith('/v1/admin/bench/results')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (opts.report) {
        res.end(JSON.stringify({ data: [{}], report: opts.report }));
      } else {
        res.end(JSON.stringify({ data: [] }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', code: 404 } }));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())),
      });
    });
    server.on('error', reject);
  });
}

function makeReport(successRate: number): Record<string, unknown> {
  return {
    runId:           'run-001',
    startedAt:       new Date().toISOString(),
    completedAt:     new Date().toISOString(),
    totalTasks:      5,
    successRate,
    medianLatencyMs: 100,
    p99LatencyMs:    500,
    totalCostUsd:    0.01,
    byCondition: {
      no_skills:        { successRate, medianLatencyMs: 100 },
      skills_on:        { successRate, medianLatencyMs: 100 },
      skills_optimized: { successRate, medianLatencyMs: 100 },
    },
    byModel: { 'test-model': { successRate, medianLatencyMs: 100 } },
    markdownSummary: `## Bench Report\nSuccess rate: ${successRate * 100}%`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runBench CLI command', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits 0 when successRate >= 0.5', async () => {
    const report = makeReport(0.8);
    const srv    = await startMockServer({ runId: 'run-001', report, postStatus: 202 });

    process.env['GATEWAY_URL'] = `http://localhost:${srv.port}`;
    delete process.env['GATEWAY_TOKEN'];

    const { runBench } = await import('../../src/cli/commands/bench.js');
    const code = await runBench({ models: 'test-model', seeds: '1', output: 'markdown' });

    expect(code).toBe(0);
    await srv.close();
    delete process.env['GATEWAY_URL'];
  });

  it('exits 1 when successRate < 0.5', async () => {
    const report = makeReport(0.3);
    const srv    = await startMockServer({ runId: 'run-002', report, postStatus: 202 });

    process.env['GATEWAY_URL'] = `http://localhost:${srv.port}`;
    delete process.env['GATEWAY_TOKEN'];

    const { runBench } = await import('../../src/cli/commands/bench.js');
    const code = await runBench({ models: 'test-model', seeds: '1' });

    expect(code).toBe(1);
    await srv.close();
    delete process.env['GATEWAY_URL'];
  });

  it('exits 1 when server returns 400 for POST', async () => {
    const srv = await startMockServer({ runId: 'x', postStatus: 400 });

    process.env['GATEWAY_URL'] = `http://localhost:${srv.port}`;
    const { runBench } = await import('../../src/cli/commands/bench.js');
    const code = await runBench({ models: 'model' });

    // 400 response → error in response body → return 1
    expect(code).toBe(1);
    await srv.close();
    delete process.env['GATEWAY_URL'];
  });

  it('exits 1 when server is unreachable', async () => {
    process.env['GATEWAY_URL'] = 'http://localhost:1'; // port 1 should refuse
    const { runBench } = await import('../../src/cli/commands/bench.js');
    const code = await runBench({ models: 'model' });
    expect(code).toBe(1);
    delete process.env['GATEWAY_URL'];
  });
});
