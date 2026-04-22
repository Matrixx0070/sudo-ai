/**
 * @file tests/security/signer-integration.test.ts
 * @description Integration tests for ArtifactSigner wired into approve REST handlers.
 *
 * Wave 10E Builder B — INT-S1..INT-S10
 * Wave 10G QE fixes:
 *  - SUDO_KEY_ROTATION_DB_PATH set per-test for DB isolation.
 *  - vi.resetModules() in beforeEach + all route imports done dynamically so each
 *    test gets a fresh ArtifactSigner singleton pointing at the per-test temp DB.
 *  - INT-S10 pub key path updated from wave10-signer.pub to wave10-signer-v1.pub.
 *  - KR-15: INT-S1 and INT-S4 now assert keyVersion is a positive integer.
 *
 * Key isolation: each test that calls sign() directly uses a fresh ArtifactSigner
 * instance pointed at a per-test tmp dir (SUDO_SIGNER_KEY_DIR) to avoid the
 * prod-singleton keypair being cached across tests.
 *
 * Route-level tests (INT-S4..S11) drive the routes via an in-process HTTP server
 * to exercise the exact production code path including the kill-switch. All
 * imports of route modules are dynamic (inside the test) so they pick up env vars
 * set in beforeEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Key-dir isolation
// ---------------------------------------------------------------------------

let testKeyDir: string;

beforeEach(() => {
  vi.resetModules();
  testKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-int-test-'));
  process.env['SUDO_SIGNER_KEY_DIR'] = testKeyDir;
  process.env['SUDO_KEY_ROTATION_DB_PATH'] = path.join(testKeyDir, 'key-rotation.db');
  delete process.env['SUDO_SIGNING_DISABLE'];
});

afterEach(() => {
  delete process.env['SUDO_SIGNER_KEY_DIR'];
  delete process.env['SUDO_KEY_ROTATION_DB_PATH'];
  delete process.env['SUDO_SIGNING_DISABLE'];
  try { fs.rmSync(testKeyDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers — proposal factories
// ---------------------------------------------------------------------------

import type { AgentConfigProposal, SkillOptimizationProposal } from '../../src/core/shared/wave10-types.js';

function makeProposal(overrides: Partial<AgentConfigProposal> = {}): AgentConfigProposal {
  return {
    id:           randomUUID(),
    agentId:      'agent-001',
    rationale:    'Improve routing',
    delta:        { maxIterations: 100 },
    traceQuality: 0.9,
    traceCount:   5,
    status:       'pending',
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    ...overrides,
  };
}

function makeSkillProposal(overrides: Partial<SkillOptimizationProposal> = {}): SkillOptimizationProposal {
  return {
    id:            randomUUID(),
    skillId:       'skill-001',
    skillName:     'web-summary',
    targetField:   'description',
    currentValue:  'old desc',
    proposedValue: 'new desc',
    evidence:      'trace-data',
    confidence:    0.8,
    status:        'pending',
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers — proposal store factories
// ---------------------------------------------------------------------------

import type { ProposalStoreLike } from '../../src/core/gateway/learning-routes.js';

function makeLearningStore(proposals: AgentConfigProposal[]): ProposalStoreLike {
  const items = [...proposals];
  return {
    list({ status, limit, offset }) {
      const f = status ? items.filter(p => p.status === status) : items;
      return { data: f.slice(offset, offset + limit), total: f.length };
    },
    approve(id: string) {
      const p = items.find(i => i.id === id);
      if (!p) throw new Error(`Not found: ${id}`);
      p.status = 'approved';
      return p;
    },
    reject(id: string) {
      const p = items.find(i => i.id === id);
      if (!p) throw new Error(`Not found: ${id}`);
      p.status = 'rejected';
      return p;
    },
    getById(id: string) { return items.find(i => i.id === id) ?? null; },
  };
}

interface SkillOptimizationStoreLike {
  getById(id: string): SkillOptimizationProposal | null;
  approve(id: string): SkillOptimizationProposal;
  reject(id: string, reason?: string): SkillOptimizationProposal;
  list(filter: { status?: string; limit: number; offset: number }): { data: SkillOptimizationProposal[]; total: number };
}

function makeSkillStore(proposals: SkillOptimizationProposal[]): SkillOptimizationStoreLike {
  const items = [...proposals];
  return {
    list({ status, limit, offset }) {
      const f = status ? items.filter(p => p.status === status) : items;
      return { data: f.slice(offset, offset + limit), total: f.length };
    },
    approve(id: string) {
      const p = items.find(i => i.id === id);
      if (!p) throw new Error(`Not found: ${id}`);
      p.status = 'approved';
      return p;
    },
    reject(id: string) {
      const p = items.find(i => i.id === id);
      if (!p) throw new Error(`Not found: ${id}`);
      p.status = 'rejected';
      return p;
    },
    getById(id: string) { return items.find(i => i.id === id) ?? null; },
  };
}

// ---------------------------------------------------------------------------
// Helpers — HTTP server helpers (all route registrations are dynamic imports)
// ---------------------------------------------------------------------------

interface TestServer { port: number; close: () => Promise<void> }

async function startLearningServer(store: ProposalStoreLike): Promise<TestServer> {
  // Dynamic import ensures fresh signer singleton with current env vars
  const { registerLearningRoutes } = await import('../../src/core/gateway/learning-routes.js');
  const server = http.createServer();
  registerLearningRoutes(server, { proposalStore: store }, null);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())) });
    });
    server.on('error', reject);
  });
}

async function startAdminServer(skillStore: SkillOptimizationStoreLike): Promise<TestServer> {
  // Dynamic import ensures fresh signer singleton with current env vars
  const { registerAdminRoutes } = await import('../../src/core/gateway/admin-routes.js');
  const server = http.createServer();
  const deps = { skillOptimizationStore: skillStore } as Parameters<typeof registerAdminRoutes>[1];
  registerAdminRoutes(server, deps, null);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())) });
    });
    server.on('error', reject);
  });
}

async function doRequest(
  port:    number,
  method:  string,
  pathname: string,
  body?:   string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (body) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// INT-S1: sign config_proposal returns valid SignedArtifact
// ---------------------------------------------------------------------------

describe('INT-S1: sign config_proposal returns valid SignedArtifact', () => {
  it('artifactSigner.sign returns all required fields for config_proposal', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const payload = { id: 'test-001', rationale: 'test', status: 'approved' };
    const artifact = signer.sign(payload, 'config_proposal');

    expect(artifact).toHaveProperty('payload');
    expect(artifact).toHaveProperty('signedAt');
    expect(artifact).toHaveProperty('keyId');
    expect(artifact).toHaveProperty('signature');
    expect(artifact).toHaveProperty('artifactType', 'config_proposal');
    expect(artifact.signature.length).toBeGreaterThan(0);
    expect(typeof artifact.keyId).toBe('string');
    expect(artifact.keyId).toMatch(/^[0-9a-f]{8}$/);
    // KR-15: keyVersion must be a positive integer in Wave 10G+
    expect(typeof artifact.keyVersion).toBe('number');
    expect(artifact.keyVersion).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// INT-S2: verify config_proposal succeeds
// ---------------------------------------------------------------------------

describe('INT-S2: verify config_proposal succeeds', () => {
  it('sign then verify returns valid=true', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const proposal = makeProposal({ status: 'approved' });
    const artifact = signer.sign(proposal, 'config_proposal');
    const result = signer.verify(artifact);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INT-S3: sign skill returns artifactType=skill
// ---------------------------------------------------------------------------

describe('INT-S3: sign skill returns artifactType=skill', () => {
  it('artifactType field is set to "skill" when signing a skill proposal', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    const skillProposal = makeSkillProposal({ status: 'approved' });
    const artifact = signer.sign(skillProposal, 'skill');

    expect(artifact.artifactType).toBe('skill');
    expect(artifact.payload).toEqual(skillProposal);
    const result = signer.verify(artifact);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INT-S4: learning approve route returns signedArtifact when signing enabled
// ---------------------------------------------------------------------------

describe('INT-S4: learning approve route — signedArtifact in response when signing enabled', () => {
  it('POST /approve returns signedArtifact with artifactType=config_proposal', async () => {
    const p = makeProposal({ status: 'pending' });
    const store = makeLearningStore([p]);
    const srv = await startLearningServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('proposal');
    expect(b).toHaveProperty('signedArtifact');
    const sa = b['signedArtifact'] as Record<string, unknown>;
    expect(sa['artifactType']).toBe('config_proposal');
    expect(typeof sa['signature']).toBe('string');
    expect(typeof sa['keyId']).toBe('string');
    expect(typeof sa['signedAt']).toBe('string');
    // KR-15: keyVersion must be a number in Wave 10G+
    expect(typeof sa['keyVersion']).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// INT-S5: learning approve route — no signedArtifact when SUDO_SIGNING_DISABLE=1
// ---------------------------------------------------------------------------

describe('INT-S5: learning approve route — only proposal returned when SUDO_SIGNING_DISABLE=1', () => {
  it('SUDO_SIGNING_DISABLE=1 omits signedArtifact key', async () => {
    process.env['SUDO_SIGNING_DISABLE'] = '1';
    const p = makeProposal({ status: 'pending' });
    const store = makeLearningStore([p]);
    const srv = await startLearningServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('proposal');
    expect(b).not.toHaveProperty('signedArtifact');
  });
});

// ---------------------------------------------------------------------------
// INT-S6: admin skill approve route — signedArtifact in response when signing enabled
// ---------------------------------------------------------------------------

describe('INT-S6: admin skill approve route — signedArtifact in response when signing enabled', () => {
  it('POST /v1/admin/skill-optimization/:id/approve returns signedArtifact with artifactType=skill', async () => {
    const sp = makeSkillProposal({ status: 'pending' });
    const store = makeSkillStore([sp]);
    const srv = await startAdminServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/skills/optimizations/${sp.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('ok', true);
    expect(b).toHaveProperty('data');
    expect(b).toHaveProperty('signedArtifact');
    const sa = b['signedArtifact'] as Record<string, unknown>;
    expect(sa['artifactType']).toBe('skill');
  });
});

// ---------------------------------------------------------------------------
// INT-S7: admin skill approve route — no signedArtifact when SUDO_SIGNING_DISABLE=1
// ---------------------------------------------------------------------------

describe('INT-S7: admin skill approve route — only data returned when SUDO_SIGNING_DISABLE=1', () => {
  it('SUDO_SIGNING_DISABLE=1 omits signedArtifact key from skill approve response', async () => {
    process.env['SUDO_SIGNING_DISABLE'] = '1';
    const sp = makeSkillProposal({ status: 'pending' });
    const store = makeSkillStore([sp]);
    const srv = await startAdminServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/skills/optimizations/${sp.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('ok', true);
    expect(b).toHaveProperty('data');
    expect(b).not.toHaveProperty('signedArtifact');
  });
});

// ---------------------------------------------------------------------------
// INT-S8: signing failure is fail-open — proposal still returned with 200
// ---------------------------------------------------------------------------

describe('INT-S8: signing failure is fail-open — proposal still returned', () => {
  it('when sign() throws, route returns 200 with proposal and no signedArtifact', async () => {
    // Import the singleton dynamically (fresh due to vi.resetModules in beforeEach)
    const signerMod = await import('../../src/core/security/signer.js');
    const spy = vi.spyOn(signerMod.artifactSigner, 'sign').mockImplementationOnce(() => {
      throw new Error('simulated signing failure');
    });

    const p = makeProposal({ status: 'pending' });
    const store = makeLearningStore([p]);
    // Start server AFTER spy is set up — same module instance
    const srv = await startLearningServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('proposal');
    expect(b).not.toHaveProperty('signedArtifact');
    expect(spy).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// INT-S9: signedArtifact.payload equals the approved proposal
// ---------------------------------------------------------------------------

describe('INT-S9: signedArtifact.payload equals proposal', () => {
  it('payload in signedArtifact round-trips correctly with proposal data', async () => {
    const p = makeProposal({ status: 'pending' });
    const store = makeLearningStore([p]);
    const srv = await startLearningServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    const proposal = b['proposal'] as Record<string, unknown>;
    const sa = b['signedArtifact'] as Record<string, unknown>;

    // payload must equal the approved proposal (same id, status=approved)
    expect(sa['payload']).toBeDefined();
    const payload = sa['payload'] as Record<string, unknown>;
    expect(payload['id']).toBe(proposal['id']);
    expect(payload['status']).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// INT-S11: Wave 10F Item 3 — SUDO_SIGNING_DISABLE only triggers on exact "1"
// ---------------------------------------------------------------------------

describe('INT-S11: Wave 10F Item 3 — SUDO_SIGNING_DISABLE only triggers on exact "1"', () => {
  it('signing runs when SUDO_SIGNING_DISABLE is "0" (not "1")', async () => {
    process.env['SUDO_SIGNING_DISABLE'] = '0';
    const p = makeProposal({ status: 'pending' });
    const store = makeLearningStore([p]);
    const srv = await startLearningServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    // With '0', feature is ON — signedArtifact must be present.
    expect(b).toHaveProperty('signedArtifact');
  });

  it('signing runs when SUDO_SIGNING_DISABLE is "true" (not "1")', async () => {
    process.env['SUDO_SIGNING_DISABLE'] = 'true';
    const p = makeProposal({ status: 'pending' });
    const store = makeLearningStore([p]);
    const srv = await startLearningServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    // With 'true', feature is ON — signedArtifact must be present.
    expect(b).toHaveProperty('signedArtifact');
  });

  it('signing disabled when SUDO_SIGNING_DISABLE is exactly "1"', async () => {
    process.env['SUDO_SIGNING_DISABLE'] = '1';
    const p = makeProposal({ status: 'pending' });
    const store = makeLearningStore([p]);
    const srv = await startLearningServer(store);

    const { status, body } = await doRequest(srv.port, 'POST', `/v1/admin/learning/proposals/${p.id}/approve`, '{}');
    await srv.close();

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).not.toHaveProperty('signedArtifact');
  });
});

// ---------------------------------------------------------------------------
// INT-S10: keyId is 8 hex chars of public key
// ---------------------------------------------------------------------------

describe('INT-S10: keyId is 8 hex chars of public key', () => {
  it('keyId in signedArtifact matches pub key DER hex chars [24..32) per Wave 10G Decision 3', async () => {
    const { ArtifactSigner } = await import('../../src/core/security/signer.js');
    const signer = new ArtifactSigner();
    // Sign once to trigger key generation
    const artifact = signer.sign({ test: true }, 'config_proposal');

    // keyId must be exactly 8 lowercase hex chars
    expect(artifact.keyId).toMatch(/^[0-9a-f]{8}$/);

    // Wave 10G: auto-seed writes wave10-signer-v1.pub (not the legacy wave10-signer.pub)
    const pubKeyPath = path.join(testKeyDir, 'wave10-signer-v1.pub');
    const pubKeyHex = fs.readFileSync(pubKeyPath, 'utf8').trim();
    // Wave 10G Decision 3: keyId = pubHex.slice(24, 32) (skips 12-byte constant DER/SPKI prefix)
    expect(pubKeyHex.slice(24, 32)).toBe(artifact.keyId);
  });
});
