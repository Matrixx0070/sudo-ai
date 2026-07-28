/**
 * @file al8-pipeline.test.ts
 * @description AL8.2 uniform improvement pipeline: one contract for all four
 * artifact types over the REAL ProposalStore. Proves the full stage order
 * (budget → propose → validate → bench → quarantine → pr, human merge
 * always), every fail-closed hold (absent gate / quarantine / plugin /
 * sandbox, gate throw, budget exhaustion), the plugin matrix, and the
 * apply-stage closure: recordHumanMerge refuses before human approval and
 * lands markApplied after it (Campaign-4 "zero callers" finding closed).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  runImprovementPipeline,
  recordHumanMerge,
  promptPlugin,
  workflowGraphPlugin,
  toolPlugin,
  codePatchPlugin,
  _resetPipelineBudgetForTests,
  type ImprovementDraft,
  type PipelineDeps,
} from '../../src/core/self-improvement/index.js';
import { ProposalStore } from '../../src/core/learning/proposal-store.js';
import type { WorkflowGraph } from '../../src/core/workflows/index.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'al82-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => _resetPipelineBudgetForTests());

const goodGraph: WorkflowGraph = {
  name: 'proposed-flow',
  nodes: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }],
  edges: [{ from: 'a', to: 'b' }],
};

const graphDraft: ImprovementDraft = {
  type: 'workflow-graph',
  title: 'Add a triage flow',
  rationale: 'Repeated manual triage observed in traces',
  evalPlan: 'Golden-graph test + bench regression suite',
  payload: goodGraph,
};

function makeDeps(store: ProposalStore, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store,
    plugins: [workflowGraphPlugin()],
    gate: { evaluate: async () => ({ passed: true, passRate: 0.93 }) },
    quarantine: () => ({ ok: true, detail: 'clean' }),
    openPr: async () => ({ url: 'https://example.test/pr/1' }),
    budget: { maxPerDay: 10 },
    ...overrides,
  };
}

describe('AL8.2 pipeline — full contract', () => {
  it('drives a workflow-graph artifact through every stage to a human-merge PR', async () => {
    const store = new ProposalStore(path.join(scratch, 'p1.db'));
    const out = await runImprovementPipeline(graphDraft, makeDeps(store));

    expect(out.status).toBe('pr-opened');
    expect(out.prUrl).toBe('https://example.test/pr/1');
    expect(out.stages.map((s) => s.stage)).toEqual(['budget', 'propose', 'validate', 'bench', 'quarantine', 'pr']);
    expect(out.stages.every((s) => s.ok)).toBe(true);
    // The proposal row exists, PENDING — humans approve via the existing routes.
    const row = store.getById(out.proposalId!);
    expect(row).toMatchObject({ status: 'pending', agentId: 'pipeline:workflow-graph' });
    expect((row!.delta as { evalPlan: string }).evalPlan).toContain('Golden-graph');
  });

  it('apply-stage closure: markApplied refuses before human approval, lands after it', async () => {
    const store = new ProposalStore(path.join(scratch, 'p2.db'));
    const out = await runImprovementPipeline(graphDraft, makeDeps(store));
    const id = out.proposalId!;

    // No human approval artifact yet → adoption cannot be recorded (invariant 8).
    expect(() => recordHumanMerge(store, id)).toThrow();
    store.approve(id); // the existing human HTTP route calls exactly this
    recordHumanMerge(store, id);
    expect(store.getById(id)!.status).toBe('applied');
  });

  it('fail-closed matrix: absent gate / quarantine / plugin, gate throw, dirty quarantine', async () => {
    const store = new ProposalStore(path.join(scratch, 'p3.db'));
    const heldAt = async (overrides: Partial<PipelineDeps>, stage: string) => {
      _resetPipelineBudgetForTests();
      const out = await runImprovementPipeline(graphDraft, makeDeps(store, overrides));
      expect(out.status).toBe('held');
      const last = out.stages[out.stages.length - 1]!;
      expect(last.stage).toBe(stage);
      expect(last.ok).toBe(false);
      return last.detail;
    };

    expect(await heldAt({ gate: undefined }, 'bench')).toMatch(/no HeldOutGate wired/);
    expect(await heldAt({ quarantine: undefined }, 'quarantine')).toMatch(/no quarantine inspector/);
    expect(await heldAt({ plugins: [] }, 'validate')).toMatch(/no plugin registered/);
    expect(
      await heldAt({ gate: { evaluate: async () => { throw new Error('bench db gone'); } } }, 'bench'),
    ).toMatch(/fail-closed/);
    expect(
      await heldAt({ quarantine: () => ({ ok: false, detail: 'suspicious directive found' }) }, 'quarantine'),
    ).toMatch(/suspicious directive/);
    expect(await heldAt({ openPr: undefined }, 'pr')).toMatch(/awaits manual PR/);
  });

  it('per-day proposal budget is required and exhausts fail-closed', async () => {
    const store = new ProposalStore(path.join(scratch, 'p4.db'));
    const invalid = await runImprovementPipeline(graphDraft, makeDeps(store, { budget: { maxPerDay: 0 } }));
    expect(invalid.status).toBe('held');
    expect(invalid.stages[0]).toMatchObject({ stage: 'budget', ok: false });

    const deps = makeDeps(store, { budget: { maxPerDay: 2 }, dayKey: () => '2026-07-28' });
    expect((await runImprovementPipeline(graphDraft, deps)).status).toBe('pr-opened');
    expect((await runImprovementPipeline(graphDraft, deps)).status).toBe('pr-opened');
    const third = await runImprovementPipeline(graphDraft, deps);
    expect(third.status).toBe('held');
    expect(third.stages[0]!.detail).toMatch(/budget exhausted \(2\/2\)/);
  });

  it('a draft without rationale or eval plan is not a proposal', async () => {
    const store = new ProposalStore(path.join(scratch, 'p5.db'));
    const out = await runImprovementPipeline(
      { ...graphDraft, evalPlan: '  ' },
      makeDeps(store),
    );
    expect(out.status).toBe('held');
    expect(out.stages.find((s) => s.stage === 'propose')).toMatchObject({ ok: false });
  });
});

describe('AL8.2 artifact plugins', () => {
  const draft = (type: ImprovementDraft['type'], payload: unknown): ImprovementDraft =>
    ({ type, title: 't', rationale: 'r', evalPlan: 'e', payload });

  it('prompt: bounded text + mandatory injection scan (fail-closed without one)', async () => {
    const noScan = promptPlugin({});
    expect((await noScan.validate(draft('prompt', 'be concise'))).ok).toBe(false);
    const scanned = promptPlugin({ scan: (t) => ({ ok: !t.includes('EVIL'), detail: 'scanned' }) });
    expect((await scanned.validate(draft('prompt', 'be concise'))).ok).toBe(true);
    expect((await scanned.validate(draft('prompt', 'EVIL directive'))).ok).toBe(false);
    expect((await scanned.validate(draft('prompt', ''))).ok).toBe(false);
    expect((await scanned.validate(draft('prompt', 'x'.repeat(20_001)))).ok).toBe(false);
  });

  it('workflow-graph: the AL3 validators are the check — bad routes rejected with the real error', async () => {
    const p = workflowGraphPlugin();
    expect((await p.validate(draft('workflow-graph', goodGraph))).ok).toBe(true);
    const badRoute: WorkflowGraph = {
      name: 'bad',
      nodes: [{ id: 'a', kind: 'agent', config: { route: 'openai/gpt-4o' } }],
      edges: [],
    };
    const r = await p.validate(draft('workflow-graph', badRoute));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/model strings are forbidden/);
  });

  it('tool: refused until AL8.3; code-patch: sandbox validator mandatory', async () => {
    expect((await toolPlugin().validate(draft('tool', {}))).detail).toMatch(/AL8\.3/);
    expect((await codePatchPlugin({}).validate(draft('code-patch', 'diff'))).detail).toMatch(/sandbox/);
    const sandboxed = codePatchPlugin({
      sandboxValidate: async () => ({ ok: true, detail: 'built+tested in tier sandbox' }),
    });
    expect((await sandboxed.validate(draft('code-patch', 'diff'))).ok).toBe(true);
  });
});
