/**
 * Tests for complexity field in /v1/chat/completions — Wave 10 Builder 2.
 *
 * Verifies that the complexity object is attached to:
 *   - Non-streaming: response body
 *   - Streaming: stop chunk data
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock complexity scorer before importing attachHttpApi
// ---------------------------------------------------------------------------

vi.mock('../../src/core/agent/complexity-scorer.js', () => ({
  scoreComplexity: vi.fn().mockReturnValue({
    score:                0.25,
    tier:                 'moderate',
    signals:              ['message_length'],
    suggested_max_tokens: 4096,
    thinking_model:       false,
  }),
}));

import http from 'node:http';
import { attachHttpApi } from '../../src/core/gateway/http-api.js';
import type { HttpApiDeps } from '../../src/core/gateway/http-api.js';

// ---------------------------------------------------------------------------
// Minimal mock deps
// ---------------------------------------------------------------------------

function makeDeps(): HttpApiDeps {
  return {
    sessionManager: {
      getOrCreate: vi.fn().mockResolvedValue({ id: 'sess-001' }),
    },
    agentLoop: {
      run: vi.fn().mockResolvedValue({ text: 'Hello, world!', attachments: [] }),
    },
  };
}

// ---------------------------------------------------------------------------
// Test server helper
// ---------------------------------------------------------------------------

interface TestSrv { port: number; close: () => Promise<void> }

async function startServer(deps: HttpApiDeps): Promise<TestSrv> {
  const server = http.createServer();
  attachHttpApi(server, deps);
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

async function postChat(port: number, body: unknown): Promise<{ status: number; raw: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path:    '/v1/chat/completions',
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/v1/chat/completions — complexity field', () => {
  afterEach(() => vi.restoreAllMocks());

  it('includes complexity object in non-streaming response', async () => {
    const deps = makeDeps();
    const srv  = await startServer(deps);

    const { status, raw } = await postChat(srv.port, {
      model:    'grok',
      messages: [{ role: 'user', content: 'Hello' }],
      stream:   false,
    });

    expect(status).toBe(200);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toHaveProperty('complexity');
    const complexity = body['complexity'] as Record<string, unknown>;
    expect(complexity).toHaveProperty('score');
    expect(complexity).toHaveProperty('tier');
    expect(complexity).toHaveProperty('signals');
    expect(complexity).toHaveProperty('suggested_max_tokens');
    expect(complexity).toHaveProperty('thinking_model');

    await srv.close();
  });

  it('complexity.tier is moderate for mocked scorer', async () => {
    const deps = makeDeps();
    const srv  = await startServer(deps);

    const { raw } = await postChat(srv.port, {
      model:    'claude',
      messages: [{ role: 'user', content: 'Test prompt' }],
      stream:   false,
    });

    const body = JSON.parse(raw) as Record<string, unknown>;
    const complexity = body['complexity'] as Record<string, unknown>;
    expect(complexity['tier']).toBe('moderate');
    expect(complexity['suggested_max_tokens']).toBe(4096);

    await srv.close();
  });

  it('includes complexity on stop chunk in streaming response', async () => {
    const deps = makeDeps();
    const srv  = await startServer(deps);

    const { status, raw } = await postChat(srv.port, {
      model:    'grok',
      messages: [{ role: 'user', content: 'Hello' }],
      stream:   true,
    });

    expect(status).toBe(200);

    // Find the stop chunk (finish_reason: 'stop')
    const lines = raw.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
    const stopLine = lines.find(l => l.includes('"finish_reason":"stop"'));
    expect(stopLine).toBeDefined();

    const stopChunk = JSON.parse(stopLine!.replace('data: ', '')) as Record<string, unknown>;
    expect(stopChunk).toHaveProperty('complexity');

    await srv.close();
  });
});
