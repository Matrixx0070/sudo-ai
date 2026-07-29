/**
 * @file al9-manifest-meta.test.ts
 * @description AL9.1 pipeline-as-artifact + AL9.2 meta-proposals + AL9.5
 * independence ordering (docs/OPUS_HANDOFF_AGENTIC_LADDER.md, Campaign 5):
 *   - the manifest is validated, semver-compared, and never-weaken-checked;
 *   - every proposal is STAMPED with the manifest version active at proposal
 *     time, and its bench bar reads from that pinned manifest — a later
 *     manifest never applies retroactively (the AL9.5 ordering test);
 *   - pipeline-change artifacts are gated behind SUDO_AL_META (default OFF,
 *     fail-closed), require a strict version increase + existing
 *     retention-ledger citations, and structurally refuse machine-proposed
 *     weakening. Meta-proposals are ALWAYS human-merged.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  CURRENT_MANIFEST,
  findWeakenings,
  isVersionIncrease,
  pipelineChangePlugin,
  promptPlugin,
  runImprovementPipeline,
  validateManifest,
  RetentionLedger,
  _resetPipelineBudgetForTests,
  type ImprovementDraft,
  type PipelineDeps,
  type PipelineManifest,
} from '../../src/core/self-improvement/index.js';
import { ProposalStore } from '../../src/core/learning/proposal-store.js';

const dir = mkdtempSync(join(tmpdir(), 'al9-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['SUDO_AL_META'];
});
beforeEach(() => {
  _resetPipelineBudgetForTests();
  delete process.env['SUDO_AL_META'];
});

const bump = (over: Partial<PipelineManifest> = {}): PipelineManifest => ({
  ...CURRENT_MANIFEST,
  ...over,
  version: over.version ?? '1.1.0',
  validators: { ...CURRENT_MANIFEST.validators, ...(over.validators ?? {}) },
  evalSuite: { ...CURRENT_MANIFEST.evalSuite, ...(over.evalSuite ?? {}) },
  adoption: { ...CURRENT_MANIFEST.adoption, ...(over.adoption ?? {}) },
});

describe('AL9.1 manifest — validation, semver, never-weaken', () => {
  it('validates structure fail-loud and compares versions strictly', () => {
    expect(() => validateManifest(CURRENT_MANIFEST)).not.toThrow();
    expect(() => validateManifest(bump({ version: 'v2' }))).toThrow(/not semver/);
    expect(() => validateManifest(bump({ adoption: { minPassRate: 1.5, proposalsPerDay: 10 } }))).toThrow(/0\.\.1/);
    expect(isVersionIncrease('1.0.0', '1.0.1')).toBe(true);
    expect(isVersionIncrease('1.0.0', '2.0.0')).toBe(true);
    expect(isVersionIncrease('1.0.0', '1.0.0')).toBe(false);
    expect(isVersionIncrease('1.2.0', '1.1.9')).toBe(false);
  });

  it('findWeakenings catches every loosening direction and passes tightenings', () => {
    expect(findWeakenings(CURRENT_MANIFEST, bump({ adoption: { minPassRate: 0.6, proposalsPerDay: 5 } }))).toEqual([]);
    const w = findWeakenings(
      bump({ version: '1.0.0', adoption: { minPassRate: 0.5, proposalsPerDay: 10 } }),
      bump({
        version: '1.1.0',
        adoption: { minPassRate: 0.3, proposalsPerDay: 50 },
        validators: { requireInjectionScan: false, requireSandboxForCode: false, maxPromptChars: 100_000 },
        evalSuite: { suites: ['agent-tasks'] },
      }),
    );
    expect(w.join(' ')).toMatch(/minPassRate lowered/);
    expect(w.join(' ')).toMatch(/proposalsPerDay raised/);
    expect(w.join(' ')).toMatch(/requireInjectionScan disabled/);
    expect(w.join(' ')).toMatch(/requireSandboxForCode disabled/);
    expect(w.join(' ')).toMatch(/suites removed: builtin-tasks/);
    expect(w.join(' ')).toMatch(/maxPromptChars more than doubled/);
  });
});

describe('AL9.5 independence ordering — bars ride the PINNED manifest', () => {
  const promptDraft: ImprovementDraft = {
    type: 'prompt',
    title: 'tighter summaries',
    rationale: 'observed verbosity',
    evalPlan: 'bench prompt suite',
    payload: 'be concise; cite evidence',
  };

  function deps(store: ProposalStore, manifest: PipelineManifest, passRate: number): PipelineDeps {
    return {
      store,
      plugins: [promptPlugin({ scan: () => ({ ok: true, detail: 'clean' }), manifest })],
      gate: { evaluate: async () => ({ passed: true, passRate }) },
      quarantine: () => ({ ok: true, detail: 'clean' }),
      openPr: async () => ({ url: 'https://example.test/pr/1' }),
      budget: { maxPerDay: 10 },
      manifest,
    };
  }

  it('a proposal under v1.0.0 passes at a rate a LATER stricter manifest would refuse — and stamps prove the pin', async () => {
    const store = new ProposalStore(join(dir, 'order.db'));

    // Generation N: manifest v1.0.0 (bar 0) — passRate 0.4 clears the bench.
    const a = await runImprovementPipeline(promptDraft, deps(store, CURRENT_MANIFEST, 0.4));
    expect(a.status).toBe('pr-opened');
    expect((store.getById(a.proposalId!)!.delta as { manifestVersion: string }).manifestVersion).toBe('1.0.0');

    // Generation N+1: manifest v1.1.0 raises the bar to 0.9. The SAME draft at
    // the SAME 0.4 pass rate is now held — the new bar applies only to
    // proposals made AFTER the manifest change; A's outcome stands untouched.
    const strict = bump({ version: '1.1.0', adoption: { minPassRate: 0.9, proposalsPerDay: 10 } });
    const b = await runImprovementPipeline(promptDraft, deps(store, strict, 0.4));
    expect(b.status).toBe('held');
    const bench = b.stages.find((s) => s.stage === 'bench')!;
    expect(bench.ok).toBe(false);
    expect(bench.detail).toMatch(/bar 0\.9 @ manifest 1\.1\.0/);
    expect((store.getById(b.proposalId!)!.delta as { manifestVersion: string }).manifestVersion).toBe('1.1.0');
    // A's stored row still carries its own generation's manifest.
    expect((store.getById(a.proposalId!)!.delta as { manifestVersion: string }).manifestVersion).toBe('1.0.0');
  });
});

describe('AL9.2 meta-proposals — pipeline-change, strictly MORE gated', () => {
  const metaDraft = (payload: unknown): ImprovementDraft => ({
    type: 'pipeline-change',
    title: 'raise the adoption bar',
    rationale: 'retention recheck flagged regressions',
    evalPlan: 'AL8 regression suite must stay green under the new bar',
    payload,
  });

  function ledgerWith(proposalId: string): RetentionLedger {
    const ledger = new RetentionLedger(join(dir, `meta-${proposalId}.db`));
    ledger.recordAdoption({
      proposalId,
      artifactType: 'prompt',
      baselineScore: 0.7,
      candidateScore: 0.8,
      evalSetHash: 'sha256:x',
      adoptionPr: 'https://example.test/pr/40',
      revertRef: 'revert:cafe',
    });
    return ledger;
  }

  it('default OFF: SUDO_AL_META unset refuses fail-closed (AL9.6 rung gate)', async () => {
    const plugin = pipelineChangePlugin({ retention: ledgerWith('p-off') });
    const r = await plugin.validate(metaDraft({
      targetManifest: bump({ adoption: { minPassRate: 0.5, proposalsPerDay: 10 } }),
      evidence: { retentionProposalIds: ['p-off'], summary: 'raise bar' },
    }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/SUDO_AL_META != 1.*rung not activated/);
  });

  it('flag ON: a tightening change with existing citations validates, marked human-merge-only', async () => {
    process.env['SUDO_AL_META'] = '1';
    const plugin = pipelineChangePlugin({ retention: ledgerWith('p-ok') });
    const r = await plugin.validate(metaDraft({
      targetManifest: bump({ adoption: { minPassRate: 0.5, proposalsPerDay: 10 } }),
      evidence: { retentionProposalIds: ['p-ok'], summary: 'flagged rows justify a real bar' },
    }));
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/human merge only — no auto-merge class exists for pipeline-change, ever/);
  });

  it('refuses: weakening, non-increase, missing/unverifiable evidence', async () => {
    process.env['SUDO_AL_META'] = '1';
    const ledger = ledgerWith('p-evi');
    const plugin = pipelineChangePlugin({ retention: ledger });

    const weaken = await plugin.validate(metaDraft({
      targetManifest: bump({ validators: { requireSandboxForCode: false, requireInjectionScan: true, maxPromptChars: 20_000 } }),
      evidence: { retentionProposalIds: ['p-evi'], summary: 's' },
    }));
    expect(weaken.ok).toBe(false);
    expect(weaken.detail).toMatch(/never-weaken.*human-authored PR only/);

    const stale = await plugin.validate(metaDraft({
      targetManifest: bump({ version: '1.0.0' }),
      evidence: { retentionProposalIds: ['p-evi'], summary: 's' },
    }));
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/not a strict increase/);

    const ghost = await plugin.validate(metaDraft({
      targetManifest: bump(),
      evidence: { retentionProposalIds: ['no-such-row'], summary: 's' },
    }));
    expect(ghost.ok).toBe(false);
    expect(ghost.detail).toMatch(/do not exist: no-such-row/);

    const blind = await pipelineChangePlugin({}).validate(metaDraft({
      targetManifest: bump(),
      evidence: { retentionProposalIds: ['p-evi'], summary: 's' },
    }));
    expect(blind.ok).toBe(false);
    expect(blind.detail).toMatch(/no retention-ledger seam.*fail-closed/);
  });

  it('a meta-proposal drives the FULL pipeline end-to-end (dev) and lands as a pending human-merge PR', async () => {
    process.env['SUDO_AL_META'] = '1';
    const store = new ProposalStore(join(dir, 'meta-e2e.db'));
    const ledger = ledgerWith('p-e2e');
    const out = await runImprovementPipeline(
      metaDraft({
        targetManifest: bump({ adoption: { minPassRate: 0.5, proposalsPerDay: 10 } }),
        evidence: { retentionProposalIds: ['p-e2e'], summary: 'ledger shows candidates comfortably above 0.5' },
      }),
      {
        store,
        plugins: [pipelineChangePlugin({ retention: ledger })],
        gate: { evaluate: async () => ({ passed: true, passRate: 1 }) },
        quarantine: () => ({ ok: true, detail: 'clean' }),
        openPr: async () => ({ url: 'https://example.test/pr/90' }),
        budget: { maxPerDay: 3 },
      },
    );
    expect(out.status).toBe('pr-opened');
    const row = store.getById(out.proposalId!)!;
    expect(row.status).toBe('pending'); // human approve + human merge — always
    expect(row.agentId).toBe('pipeline:pipeline-change');
    expect((row.delta as { manifestVersion: string }).manifestVersion).toBe('1.0.0');
  });
});
