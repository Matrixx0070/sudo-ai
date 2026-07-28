/**
 * @file al9-generations-eval.test.ts
 * @description AL9.3 generation ledger + AL9.4 eval self-expansion:
 *   - the scorecard is DERIVED from the two existing stores (proposal stamps
 *     + retention rows) — lineage attributes adoptions, score deltas, and
 *     recheck flags back to the manifest version that produced them;
 *   - the eval-expansion queue is ADDITIVE ONLY (no removal/weaken API
 *     exists), dedupes by failure key, and human decisions are terminal;
 *   - the generations telemetry route serves the scorecard (async provider)
 *     and 404s honestly when unwired.
 */

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  buildGenerationScorecard,
  EvalExpansionQueue,
  RetentionLedger,
} from '../../src/core/self-improvement/index.js';
import type { DetectedPatterns } from '../../src/core/self-improvement/index.js';
import type { AgentConfigProposal } from '../../src/core/shared/wave10-types.js';
import { registerGraphRunsRoutes } from '../../src/core/gateway/graph-runs-routes.js';

const dir = mkdtempSync(join(tmpdir(), 'al93-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const proposal = (id: string, version: string, status: AgentConfigProposal['status']): AgentConfigProposal => ({
  id,
  agentId: 'pipeline:prompt',
  rationale: 'r',
  delta: { manifestVersion: version },
  traceQuality: 0,
  traceCount: 0,
  status,
  createdAt: '2026-07-28T00:00:00Z',
  updatedAt: '2026-07-28T00:00:00Z',
});

describe('AL9.3 generation ledger — lineage from stamps + retention', () => {
  it('attributes proposals, adoptions, score deltas, and flags to their manifest generation', async () => {
    const ledger = new RetentionLedger(join(dir, 'gen.db'));
    const adopt = (proposalId: string, baseline: number, candidate: number) =>
      ledger.recordAdoption({
        proposalId, artifactType: 'prompt', baselineScore: baseline, candidateScore: candidate,
        evalSetHash: 'sha256:x', adoptionPr: 'pr', revertRef: 'rev',
      });
    adopt('p1', 0.6, 0.8); // v1.0.0, delta +0.2
    adopt('p2', 0.7, 0.75); // v1.0.0, delta +0.05
    adopt('p4', 0.7, 0.9); // v1.1.0, delta +0.2
    await ledger.recheck(async (row) => (row.proposalId === 'p2' ? 0.5 : null)); // p2 → flagged

    const sc = buildGenerationScorecard({
      proposals: [
        proposal('p1', '1.0.0', 'applied'),
        proposal('p2', '1.0.0', 'applied'),
        proposal('p3', '1.0.0', 'rejected'),
        proposal('p4', '1.1.0', 'applied'),
        { ...proposal('x', '9.9.9', 'pending'), agentId: 'not-pipeline' }, // ignored: not pipeline lineage
      ],
      retention: ledger.list(),
    });

    expect(sc.generations.map((g) => g.manifestVersion)).toEqual(['1.0.0', '1.1.0']);
    const v1 = sc.generations[0]!;
    expect(v1).toMatchObject({ proposals: 3, adopted: 2, flagged: 1 });
    expect(v1.byStatus).toMatchObject({ applied: 2, rejected: 1 });
    expect(v1.meanScoreDelta).toBeCloseTo(0.125);
    expect(sc.generations[1]!).toMatchObject({ proposals: 1, adopted: 1, flagged: 0 });
    expect(sc.generations[1]!.meanScoreDelta).toBeCloseTo(0.2);
    ledger.close();
  });
});

describe('AL9.4 eval self-expansion — additive-only review queue', () => {
  const patterns: DetectedPatterns = {
    failingTools: [{ name: 'browser.scrape', calls: 10, failures: 4, failRate: 0.4 }],
    unusedTools: [],
    badFeedbackTypes: [{ taskType: 'summarize', badCount: 3, totalCount: 5, badRate: 0.6 } as never],
    routingGaps: [],
    cronIssues: [],
    healthScore: 80,
    analysedAt: '2026-07-28T12:00:00.000Z',
  };

  it('mines candidates from failures, dedupes by key, and human decisions are terminal', () => {
    const q = new EvalExpansionQueue(join(dir, 'evalq.db'));
    expect(q.proposeFromPatterns(patterns)).toBe(2);
    expect(q.proposeFromPatterns(patterns)).toBe(0); // dedup — no re-proposal spam
    const pending = q.listPending();
    expect(pending.map((c) => c.key).sort()).toEqual(['bad-feedback:summarize', 'tool-failure:browser.scrape']);
    expect(pending[0]!.evidence).toBeTruthy();

    const decided = q.decide(pending[0]!.id, true, 'frank');
    expect(decided.status).toBe('accepted');
    expect(() => q.decide(pending[0]!.id, false, 'frank')).toThrow(/already decided/);
    expect(q.listPending()).toHaveLength(1);

    // ADDITIVE ONLY: the queue exposes no removal/weakening API — pinned by
    // the type surface itself (compile-time), asserted here for the record.
    expect((q as unknown as Record<string, unknown>)['removeEvalCase']).toBeUndefined();
    expect((q as unknown as Record<string, unknown>)['weakenEvalCase']).toBeUndefined();
    q.close();
  });
});

describe('AL9.3 telemetry route — /v1/admin/graph-runs/generations', () => {
  async function get(port: number, pathname: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('serves the async scorecard; 404s honestly when unwired', async () => {
    const mkServer = (generations?: () => Promise<unknown>) =>
      new Promise<{ port: number; close: () => void }>((resolve) => {
        const server = http.createServer();
        registerGraphRunsRoutes(server, {
          store: { listRuns: () => [], listPendingApprovals: () => [] },
          generations,
        }, null);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() });
        });
      });

    const wired = await mkServer(async () => ({ generatedAt: 'now', generations: [{ manifestVersion: '1.0.0' }] }));
    const ok = await get(wired.port, '/v1/admin/graph-runs/generations');
    expect(ok.status).toBe(200);
    expect(ok.body.scorecard.generations[0].manifestVersion).toBe('1.0.0');
    wired.close();

    const bare = await mkServer();
    const missing = await get(bare.port, '/v1/admin/graph-runs/generations');
    expect(missing.status).toBe(404);
    bare.close();
  });
});
