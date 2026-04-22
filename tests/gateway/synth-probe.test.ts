/**
 * @file tests/gateway/synth-probe.test.ts
 * @description Tests for POST /v1/admin/synth-probe (synth-probe-routes.ts).
 *
 * Tests:
 *   PROBE-1  Returns 503 SYNTH_DISABLED when kill-switch unset
 *   PROBE-2  Returns 401 when GATEWAY_TOKEN set and bearer missing
 *   PROBE-3  Returns 429 with Retry-After after 5 calls in 60s window
 *   PROBE-4  Returns 200 { ok, duration_ms } when enabled (mocked probe)
 *   PROBE-5  Metrics counters increment on probe
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  registerSynthProbeRoutes,
  _testOnly_getRlMap,
  _testOnly_getActiveProbes,
  _testOnly_setActiveProbes,
  _testOnly_clearRlMap,
} from '../../src/core/gateway/synth-probe-routes.js';
import { metrics } from '../../src/core/health/metrics.js';

// ---------------------------------------------------------------------------
// Module-level mock for probeSynthesize so tests don't actually spawn bwrap
// ---------------------------------------------------------------------------

vi.mock('../../src/core/tools/builtin/meta/tool-synthesize.js', () => ({
  probeSynthesize: vi.fn().mockResolvedValue({ ok: true, duration_ms: 12 }),
  // LOW-1: real sanitizeErrorCode logic needed in probe-routes (not a stub)
  sanitizeErrorCode: (s: string | undefined): string | undefined => {
    if (!s) return s;
    return s.replace(/\/[^\s'"]+/g, '<path>').slice(0, 64);
  },
  // re-export everything else as no-ops to keep tsc happy
  runStaticAnalysis: vi.fn().mockReturnValue({ ok: true }),
  isBannedAst: vi.fn().mockReturnValue({ ok: true }),
  sanitizeForPrompt: vi.fn((s: string) => s),
  spawnBwrapSynth: vi.fn(),
  buildSynthBwrapArgs: vi.fn().mockReturnValue([]),
  getSealPath: vi.fn().mockReturnValue(null),
  registerSynthesizeTools: vi.fn(),
  synthesizeTool: { name: 'tool.synthesize', execute: vi.fn() },
}));

import { probeSynthesize } from '../../src/core/tools/builtin/meta/tool-synthesize.js';

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

interface TestServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

async function startProbeServer(token?: string): Promise<TestServer> {
  const tokenBuf = token ? Buffer.from(token, 'utf8') : null;
  const server = http.createServer();
  registerSynthProbeRoutes(server, tokenBuf);

  return new Promise<TestServer>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const close = () => new Promise<void>((res, rej) =>
        server.close(e => e ? rej(e) : res()),
      );
      resolve({ server, port, close });
    });
    server.on('error', reject);
  });
}

async function doPost(
  port: number,
  path: string,
  token?: string,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch { reject(new Error('Invalid JSON response')); }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// PROBE-1: kill-switch 503
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — kill-switch', () => {
  let srv: TestServer;

  beforeEach(async () => {
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    srv = await startProbeServer();
  });

  afterEach(async () => {
    await srv.close();
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    vi.restoreAllMocks();
  });

  it('PROBE-1 returns 503 SYNTH_DISABLED when SUDO_TOOL_SYNTHESIZE_ENABLED unset', async () => {
    const { status, body } = await doPost(srv.port, '/v1/admin/synth-probe');
    expect(status).toBe(503);
    const b = body as { error: string; code: string };
    expect(b.error).toBe('synthesize disabled');
    expect(b.code).toBe('SYNTH_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// PROBE-2: auth enforcement
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — auth', () => {
  const TOKEN = 'test-probe-token-32chars-minimum!';

  afterEach(() => {
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    vi.restoreAllMocks();
  });

  it('PROBE-2 returns 401 when GATEWAY_TOKEN set and bearer absent', async () => {
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    const srv = await startProbeServer(TOKEN);
    const { status } = await doPost(srv.port, '/v1/admin/synth-probe');
    expect(status).toBe(401);
    await srv.close();
  });

  it('passes auth with correct token', async () => {
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    const srv = await startProbeServer(TOKEN);
    const { status } = await doPost(srv.port, '/v1/admin/synth-probe', TOKEN);
    // 200 (kill-switch ON, mock returns ok:true) — just checking auth passes
    expect(status).toBe(200);
    await srv.close();
  });
});

// ---------------------------------------------------------------------------
// PROBE-3: rate limiting
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — rate limit', () => {
  let srv: TestServer;

  beforeEach(async () => {
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    // Use a unique IP-based key for isolation — listen on fresh server port
    srv = await startProbeServer();
  });

  afterEach(async () => {
    await srv.close();
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    vi.restoreAllMocks();
  });

  it('PROBE-3 returns 429 with Retry-After after 5 successful calls in window', async () => {
    // Fire 5 calls to exhaust the window
    for (let i = 0; i < 5; i++) {
      const { status } = await doPost(srv.port, '/v1/admin/synth-probe');
      expect(status).toBe(200);
    }
    // 6th call must be rate-limited
    const { status, headers } = await doPost(srv.port, '/v1/admin/synth-probe');
    expect(status).toBe(429);
    expect(headers['retry-after']).toBeDefined();
    const retryAfter = Number(headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------
// PROBE-4: happy path response shape
// Use a unique token per test so IP-based RL from PROBE-3 doesn't bleed in
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — happy path', () => {
  let srv: TestServer;
  const PROBE4_TOKEN = 'probe4-unique-token-32chars-!!!AA';

  beforeEach(async () => {
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    vi.mocked(probeSynthesize).mockResolvedValue({ ok: true, duration_ms: 42 });
    srv = await startProbeServer(PROBE4_TOKEN);
  });

  afterEach(async () => {
    await srv.close();
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    vi.restoreAllMocks();
  });

  it('PROBE-4 returns 200 { ok: true, duration_ms } shape', async () => {
    const { status, body } = await doPost(srv.port, '/v1/admin/synth-probe', PROBE4_TOKEN);
    expect(status).toBe(200);
    const b = body as { ok: boolean; duration_ms: number };
    expect(b.ok).toBe(true);
    expect(typeof b.duration_ms).toBe('number');
    expect(b.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns errorCode and phase when probe fails', async () => {
    vi.mocked(probeSynthesize).mockResolvedValue({
      ok: false,
      duration_ms: 5,
      errorCode: 'BWRAP_FAIL',
      phase: 'BWRAP_SPAWN',
    });

    const { status, body } = await doPost(srv.port, '/v1/admin/synth-probe', PROBE4_TOKEN);
    expect(status).toBe(200);
    const b = body as { ok: boolean; duration_ms: number; errorCode: string; phase: string };
    expect(b.ok).toBe(false);
    expect(b.errorCode).toBe('BWRAP_FAIL');
    expect(b.phase).toBe('BWRAP_SPAWN');
  });
});

// ---------------------------------------------------------------------------
// PROBE-5: metrics
// Use unique token to avoid rate-limit bleed from earlier describe blocks
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — metrics', () => {
  let srv: TestServer;
  const PROBE5_TOKEN = 'probe5-unique-token-32chars-!!!BB';

  beforeEach(async () => {
    metrics.reset();
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    vi.mocked(probeSynthesize).mockResolvedValue({ ok: true, duration_ms: 7 });
    srv = await startProbeServer(PROBE5_TOKEN);
  });

  afterEach(async () => {
    await srv.close();
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    vi.restoreAllMocks();
  });

  it('PROBE-5 increments synth_probe_total and synth_probe_success_total', async () => {
    await doPost(srv.port, '/v1/admin/synth-probe', PROBE5_TOKEN);
    expect(metrics.getCounter('synth_probe_total')).toBeGreaterThanOrEqual(1);
    expect(metrics.getCounter('synth_probe_success_total')).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// PROBE-6: MEDIUM-1 — RL Map size cap evicts oldest entry
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — RL map cap (MEDIUM-1)', () => {
  const PROBE6_TOKEN = 'probe6-unique-token-32chars-!!!CC';

  beforeEach(async () => {
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    vi.mocked(probeSynthesize).mockResolvedValue({ ok: true, duration_ms: 5 });
    // Clear any state from previous test runs
    _testOnly_clearRlMap();
  });

  afterEach(() => {
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    _testOnly_clearRlMap();
    vi.restoreAllMocks();
  });

  it('PROBE-6 evicts oldest entry when map reaches MAX_RL_ENTRIES (1000)', async () => {
    // Pre-populate the RL map with 1000 fake entries (each with a live timestamp)
    const rlMap = _testOnly_getRlMap();
    const futureTs = Date.now() + 60_000; // won't expire during test
    for (let i = 0; i < 1000; i++) {
      rlMap.set(`fake-key-${i}`, [futureTs]);
    }
    expect(rlMap.size).toBe(1000);

    // Sending a real request with a fresh token should trigger eviction
    const srv = await startProbeServer(PROBE6_TOKEN);
    await doPost(srv.port, '/v1/admin/synth-probe', PROBE6_TOKEN);
    await srv.close();

    // Map must not exceed 1000 entries (oldest fake-key-0 was evicted to make room)
    expect(rlMap.size).toBeLessThanOrEqual(1000);
    // The new token key should have been inserted
    const hasNewKey = [...rlMap.keys()].some(k => k.startsWith('token:'));
    expect(hasNewKey).toBe(true);
    // fake-key-0 (insertion-order oldest) must have been evicted
    expect(rlMap.has('fake-key-0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROBE-7: LOW-1 — errorCode with filesystem path is redacted in response
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — errorCode path redaction (LOW-1)', () => {
  let srv: TestServer;
  const PROBE7_TOKEN = 'probe7-unique-token-32chars-!!!DD';

  beforeEach(async () => {
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    srv = await startProbeServer(PROBE7_TOKEN);
  });

  afterEach(async () => {
    await srv.close();
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    vi.restoreAllMocks();
  });

  it('PROBE-7 redacts filesystem path from errorCode in HTTP response', async () => {
    vi.mocked(probeSynthesize).mockResolvedValue({
      ok: false,
      duration_ms: 3,
      errorCode: 'ENOENT: /root/sudo-ai-v4/quarantine/abc123.ts no such file',
      phase: 'BWRAP_SPAWN',
    });

    const { status, body } = await doPost(srv.port, '/v1/admin/synth-probe', PROBE7_TOKEN);
    expect(status).toBe(200);
    const b = body as { ok: boolean; errorCode: string; phase: string };
    expect(b.ok).toBe(false);
    // Path must be redacted to <path>
    expect(b.errorCode).not.toContain('/root');
    expect(b.errorCode).not.toContain('/quarantine');
    expect(b.errorCode).toContain('<path>');
    // Phase is not redacted
    expect(b.phase).toBe('BWRAP_SPAWN');
  });

  it('PROBE-7b errorCode without paths passes through unchanged', async () => {
    vi.mocked(probeSynthesize).mockResolvedValue({
      ok: false,
      duration_ms: 3,
      errorCode: 'BWRAP_FAIL',
      phase: 'BWRAP_SPAWN',
    });

    const { body } = await doPost(srv.port, '/v1/admin/synth-probe', PROBE7_TOKEN);
    const b = body as { errorCode: string };
    expect(b.errorCode).toBe('BWRAP_FAIL');
  });
});

// ---------------------------------------------------------------------------
// PROBE-8: LOW-2 — concurrency cap returns 429 on 3rd concurrent request
// ---------------------------------------------------------------------------

describe('POST /v1/admin/synth-probe — concurrency cap (LOW-2)', () => {
  const PROBE8_TOKEN = 'probe8-unique-token-32chars-!!!EE';

  beforeEach(() => {
    process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'] = '1';
    _testOnly_setActiveProbes(0);
  });

  afterEach(() => {
    delete process.env['SUDO_TOOL_SYNTHESIZE_ENABLED'];
    _testOnly_setActiveProbes(0);
    vi.restoreAllMocks();
  });

  it('PROBE-8 returns 429 PROBE_CONCURRENCY_LIMIT when 2 probes already in-flight', async () => {
    // Simulate 2 already-active probes without launching real bwrap
    _testOnly_setActiveProbes(2);

    const srv = await startProbeServer(PROBE8_TOKEN);
    const { status, headers, body } = await doPost(srv.port, '/v1/admin/synth-probe', PROBE8_TOKEN);
    await srv.close();

    expect(status).toBe(429);
    expect(headers['retry-after']).toBe('2');
    const b = body as { error: { code: string } };
    expect(b.error.code).toBe('PROBE_CONCURRENCY_LIMIT');
  });
});
