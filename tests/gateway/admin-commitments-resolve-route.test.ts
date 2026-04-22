/**
 * @file tests/gateway/admin-commitments-resolve-route.test.ts
 * @description Wave 6N: POST /v1/admin/commitments/resolve endpoint tests.
 *
 * Tests:
 *   CR-1  200 with ResolutionEntry shape on valid honored body
 *   CR-2  400 when resolution enum is invalid
 *   CR-3  409 when commitmentRef is already resolved
 *   CR-4  401 when bearer token is missing
 *   CR-5  honored resolution triggers trustTierTracker.recordOutcome with spy
 *   CR-6  honored + trustTierTracker.recordOutcome throws still returns 200
 *   CR-7  200 for abandoned resolution (trustTierTracker NOT called)
 *   CR-8  503 when commitmentResolutionTracker is absent
 *   CR-9  400 when commitmentRef is empty string
 *   CR-10 400 when commitmentRef exceeds 200 chars
 *   CR-11 500 when resolve() returns null
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-resolve-token-xyz';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

type ResolutionKind = 'honored' | 'abandoned' | 'expired-acknowledged';

interface MockResolutionEntry {
  id: string;
  commitmentRef: string;
  resolution: string;
  ts: number;
  notes?: string;
}

function makeMockEntry(ref: string, resolution: ResolutionKind, notes?: string): MockResolutionEntry {
  return {
    id: 'test-uuid-1234',
    commitmentRef: ref,
    resolution,
    ts: Date.now(),
    ...(notes !== undefined ? { notes } : {}),
  };
}

interface MockResolutionTracker {
  resolvedRefs: Set<string>;
  resolveReturn: MockResolutionEntry | null;
  resolve: (ref: string, resolution: ResolutionKind, notes?: string) => MockResolutionEntry | null;
  isResolved: (ref: string) => boolean;
}

function makeMockTracker(opts: {
  preResolved?: string[];
  returnNull?: boolean;
} = {}): MockResolutionTracker {
  const resolvedRefs = new Set<string>(opts.preResolved ?? []);
  const resolveReturn = opts.returnNull ? null : makeMockEntry('__ref__', 'honored');

  return {
    resolvedRefs,
    resolveReturn,
    resolve(ref: string, resolution: ResolutionKind, notes?: string): MockResolutionEntry | null {
      if (this.resolveReturn === null) return null;
      return makeMockEntry(ref, resolution, notes);
    },
    isResolved(ref: string): boolean {
      return this.resolvedRefs.has(ref);
    },
  };
}

interface TrustTrackerSpy {
  calls: Array<{ timestamp: number; kind: string; weight?: number }>;
  shouldThrow: boolean;
  recordOutcome(outcome: { timestamp: number; kind: string; weight?: number }): void;
  getAuditSnapshot(): { tier: string; score: number; windowSizeDays: number; lastAdjustedAt: string };
}

function makeTrustTrackerSpy(opts: { shouldThrow?: boolean } = {}): TrustTrackerSpy {
  return {
    calls: [],
    shouldThrow: opts.shouldThrow ?? false,
    recordOutcome(outcome) {
      this.calls.push(outcome);
      if (this.shouldThrow) throw new Error('trust tracker error');
    },
    getAuditSnapshot() {
      return { tier: 'STANDARD', score: 0.75, windowSizeDays: 7, lastAdjustedAt: new Date().toISOString() };
    },
  };
}

function buildBaseDeps(
  tracker?: AdminRoutesDeps['commitmentResolutionTracker'],
  trustTracker?: AdminRoutesDeps['trustTierTracker'],
): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    commitmentResolutionTracker: tracker,
    trustTierTracker: trustTracker,
  };
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

function startServer(deps: AdminRoutesDeps, tokenBuf: Buffer | null): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    registerAdminRoutes(server, deps, tokenBuf);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const close = (): Promise<void> =>
        new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
      resolve({ baseUrl, close });
    });
    server.on('error', reject);
  });
}

async function doPost(
  url: string,
  body: unknown,
  token?: string | null,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token != null) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, json: JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/admin/commitments/resolve', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // CR-1: 200 with ResolutionEntry shape
  // -------------------------------------------------------------------------
  it('CR-1: returns 200 with ResolutionEntry shape on valid honored body', async () => {
    const tracker = makeMockTracker();
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-001', resolution: 'honored', notes: 'Done on time' },
      VALID_TOKEN,
    );

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: MockResolutionEntry };
    expect(body.ok).toBe(true);
    expect(typeof body.data.id).toBe('string');
    expect(body.data.commitmentRef).toBe('commitment-001');
    expect(body.data.resolution).toBe('honored');
    expect(typeof body.data.ts).toBe('number');
  });

  // -------------------------------------------------------------------------
  // CR-2: 400 when resolution enum is invalid
  // -------------------------------------------------------------------------
  it('CR-2: returns 400 when resolution enum is invalid', async () => {
    const tracker = makeMockTracker();
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-001', resolution: 'not-valid' },
      VALID_TOKEN,
    );

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/resolution/i);
  });

  // -------------------------------------------------------------------------
  // CR-3: 409 when commitmentRef is already resolved
  // -------------------------------------------------------------------------
  it('CR-3: returns 409 when commitmentRef is already resolved', async () => {
    const tracker = makeMockTracker({ preResolved: ['commitment-dup'] });
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-dup', resolution: 'honored' },
      VALID_TOKEN,
    );

    expect(status).toBe(409);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/already resolved/i);
  });

  // -------------------------------------------------------------------------
  // CR-4: 401 when bearer token is missing
  // -------------------------------------------------------------------------
  it('CR-4: returns 401 when bearer token is absent', async () => {
    const tracker = makeMockTracker();
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    const { status } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-001', resolution: 'honored' },
      null, // no token
    );

    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // CR-5: honored triggers trustTierTracker.recordOutcome via spy
  // -------------------------------------------------------------------------
  it('CR-5: honored resolution triggers trustTierTracker.recordOutcome with kind=commitment-honored', async () => {
    const tracker = makeMockTracker();
    const spy = makeTrustTrackerSpy();
    ts = await startServer(buildBaseDeps(tracker, spy), makeTokenBuf(VALID_TOKEN));

    const { status } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-honored-ref', resolution: 'honored' },
      VALID_TOKEN,
    );

    expect(status).toBe(200);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.kind).toBe('commitment-honored');
    expect(typeof spy.calls[0]?.timestamp).toBe('number');
  });

  // -------------------------------------------------------------------------
  // CR-6: honored + trustTierTracker throws still returns 200
  // -------------------------------------------------------------------------
  it('CR-6: honored resolution still returns 200 when trustTierTracker.recordOutcome throws', async () => {
    const tracker = makeMockTracker();
    const spy = makeTrustTrackerSpy({ shouldThrow: true });
    ts = await startServer(buildBaseDeps(tracker, spy), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-fault-ref', resolution: 'honored' },
      VALID_TOKEN,
    );

    expect(status).toBe(200);
    const body = json as { ok: boolean };
    expect(body.ok).toBe(true);
    // recordOutcome was attempted but threw — verify calls captured before throw
    expect(spy.calls.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // CR-7: abandoned resolution does NOT call trustTierTracker
  // -------------------------------------------------------------------------
  it('CR-7: abandoned resolution returns 200 and does NOT call trustTierTracker.recordOutcome', async () => {
    const tracker = makeMockTracker();
    const spy = makeTrustTrackerSpy();
    ts = await startServer(buildBaseDeps(tracker, spy), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-abandoned-ref', resolution: 'abandoned' },
      VALID_TOKEN,
    );

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: MockResolutionEntry };
    expect(body.ok).toBe(true);
    expect(body.data.resolution).toBe('abandoned');
    expect(spy.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // CR-8: 503 when commitmentResolutionTracker is absent
  // -------------------------------------------------------------------------
  it('CR-8: returns 503 when commitmentResolutionTracker is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no tracker */), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-001', resolution: 'honored' },
      VALID_TOKEN,
    );

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not configured/i);
  });

  // -------------------------------------------------------------------------
  // CR-9: 400 when commitmentRef is empty string
  // -------------------------------------------------------------------------
  it('CR-9: returns 400 when commitmentRef is empty string', async () => {
    const tracker = makeMockTracker();
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: '   ', resolution: 'honored' },
      VALID_TOKEN,
    );

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/commitmentRef/i);
  });

  // -------------------------------------------------------------------------
  // CR-10: 400 when commitmentRef exceeds 200 chars
  // -------------------------------------------------------------------------
  it('CR-10: returns 400 when commitmentRef exceeds 200 characters', async () => {
    const tracker = makeMockTracker();
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    const longRef = 'a'.repeat(201);
    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: longRef, resolution: 'honored' },
      VALID_TOKEN,
    );

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/commitmentRef/i);
  });

  // -------------------------------------------------------------------------
  // CR-11: 500 when resolve() returns null
  // -------------------------------------------------------------------------
  it('CR-11: returns 500 when resolve() returns null', async () => {
    const tracker = makeMockTracker({ returnNull: true });
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    const { status } = await doPost(
      `${ts.baseUrl}/v1/admin/commitments/resolve`,
      { commitmentRef: 'commitment-null-ref', resolution: 'honored' },
      VALID_TOKEN,
    );

    expect(status).toBe(500);
  });
});
