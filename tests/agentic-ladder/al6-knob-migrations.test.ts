/**
 * @file al6-knob-migrations.test.ts
 * @description AL6.2 knob migrations (thin delegation, NO behavior change) +
 * decision-log persistence:
 *   - cheap-model-router now calls through the shared PolicyResolver every
 *     routed turn; application stays on the legacy rule until AL6.5
 *     promotion — a divergent resolver decision (shed) is logged, not applied;
 *   - the graph governor streams budget-pressure signals into the seam
 *     (logged only), with run behavior byte-identical;
 *   - PolicyDecisionLog persists every decision to sqlite `policy_decisions`
 *     with the comparison-query column names (at/intent/route_hint/shadow).
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  PolicyResolver,
  attachSharedDecisionSink,
  getSharedResolver,
  _resetSharedResolverForTests,
  type PolicyDecisionEntry,
} from '../../src/core/agent/policy-resolver.js';
import { PolicyDecisionLog } from '../../src/core/agent/policy-decision-log.js';
import { chooseModel } from '../../src/core/agent/cheap-model-router.js';
import { GraphRunStore, runGovernedGraph } from '../../src/core/orchestration/index.js';
import type { GraphNode, GraphNodeExecutor, WorkflowGraph } from '../../src/core/workflows/index.js';

let scratch: string;
beforeEach(() => _resetSharedResolverForTests());
afterAll(async () => {
  _resetSharedResolverForTests();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const models = { primaryModel: 'primary-x', cheapModel: 'cheap-x' };

describe('AL6.2 knob migration — cheap-model-router through the shared resolver', () => {
  it('behavior is unchanged across the routing matrix while every turn hits the seam', () => {
    const entries: PolicyDecisionEntry[] = [];
    attachSharedDecisionSink((e) => entries.push(e));

    expect(chooseModel({ userText: 'thanks!', history: [], ...models }).model).toBe('cheap-x');
    expect(chooseModel({ userText: 'please debug prod', history: [], ...models }).model).toBe('primary-x');
    expect(chooseModel({ userText: '', history: [], ...models }).model).toBe('primary-x');
    expect(
      chooseModel({ userText: 'ok', history: [{ role: 'assistant', toolCalls: [{}] }], ...models }).model,
    ).toBe('primary-x');

    expect(entries).toHaveLength(4); // one seam decision per routed turn
    expect(entries.map((e) => e.signals.intent)).toEqual(['conversational', 'agentic', 'unknown', 'agentic']);
  });

  it('a diverging resolver decision (load-shed) is logged but NOT applied — legacy rule holds until promotion', () => {
    // Push the SHARED resolver into shedding via load signals (another caller).
    getSharedResolver().resolve({ queueDepth: 99 });
    expect(getSharedResolver().isShedding()).toBe(true);

    // Shed says cheap for non-agentic 'unknown'; legacy says primary. Legacy wins.
    const routed = chooseModel({ userText: '', history: [], ...models });
    expect(routed.model).toBe('primary-x');
    expect(routed.cheapUsed).toBe(false);
  });
});

describe('AL6.2 decision-log persistence — policy_decisions beside llm_calls', () => {
  it('persists decisions with the comparison-query columns and JSON roundtrips', async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'al6log-'));
    const dlog = new PolicyDecisionLog(path.join(scratch, 'gateway.db'));
    attachSharedDecisionSink(dlog.createSink({ sessionId: 'sess-1', turnId: 'turn-1' }));

    chooseModel({ userText: 'thanks!', history: [], ...models });
    chooseModel({ userText: 'refactor the loop', history: [], ...models });

    const rows = dlog.recent();
    expect(rows).toHaveLength(2);
    const latest = rows[0]!; // DESC — the agentic turn
    expect(latest).toMatchObject({
      intent: 'agentic',
      route_hint: 'reasoning',
      shadow: 0,
      shedding: 0,
      session_id: 'sess-1',
      turn_id: 'turn-1',
    });
    expect(latest.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(latest.signals)).toEqual({ intent: 'agentic' });
    expect(JSON.parse(latest.reasons)[0]).toContain('route reasoning');
    expect(rows[1]!.route_hint).toBe('cheap');
    dlog.close();
  });

  it('a closed/broken log never breaks routing (fire-and-forget)', async () => {
    scratch = scratch ?? (await mkdtemp(path.join(tmpdir(), 'al6log-')));
    const dlog = new PolicyDecisionLog(path.join(scratch, 'broken.db'));
    attachSharedDecisionSink(dlog.createSink());
    dlog.close(); // sink now throws internally on every insert
    expect(() => chooseModel({ userText: 'hi', history: [], ...models })).not.toThrow();
  });
});

describe('AL6.2 knob migration — governor streams budget pressure into the seam', () => {
  it('emits pressure per spend event, logged only, run behavior unchanged', async () => {
    scratch = scratch ?? (await mkdtemp(path.join(tmpdir(), 'al6log-')));
    const chain: WorkflowGraph = {
      name: 'pressure',
      nodes: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }, { id: 'c', kind: 'agent' }] as GraphNode[],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    const exec: GraphNodeExecutor = async () => ({ success: true, spend: 60 });
    const entries: PolicyDecisionEntry[] = [];
    const resolver = new PolicyResolver({ onDecision: (e) => entries.push(e), shadow: false });

    const store = new GraphRunStore(path.join(scratch, 'gov.db'));
    const report = await runGovernedGraph({
      store,
      runId: 'run-pressure',
      graph: chain,
      executors: { agent: exec },
      budget: { maxRunSpend: 300 },
      policyResolver: resolver,
    });

    expect(report.status).toBe('success'); // behavior unchanged — signals only
    expect(entries.map((e) => e.signals.budgetPressure)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(entries.every((e) => !e.shedding)).toBe(true);
    store.close();
  });
});
