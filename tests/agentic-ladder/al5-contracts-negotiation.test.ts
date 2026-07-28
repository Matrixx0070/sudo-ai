/**
 * @file al5-contracts-negotiation.test.ts
 * @description AL5.2 role contracts + AL5.3 contract-net negotiation
 * (docs/OPUS_HANDOFF_AGENTIC_LADDER.md):
 *   - contracts are ENFORCED at spawn/message time: a role without delegation
 *     rights attempting a spawn is rejected with an actionable error; the
 *     global spawn-depth ceiling closes the audit's recursion exposure;
 *     capabilities and knowledge scope have enforcement primitives;
 *   - one full contract-net round-trip over the EXISTING messenger:
 *     offer → bids (incl. ineligible + malformed, skipped not crashed) →
 *     deterministic award, with the award cited from the message log.
 */

import { describe, it, expect } from 'vitest';
import {
  AgentMessenger,
  AgentSpawner,
  assertKnowledgeScope,
  assertMessageAllowed,
  assertSpawnAllowed,
  assertToolAllowed,
  awardTask,
  getContract,
  GLOBAL_MAX_SPAWN_DEPTH,
  postOffer,
  submitBid,
  type TaskAward,
  type TaskBid,
} from '../../src/core/agents/index.js';

// ---------------------------------------------------------------------------
// AL5.2 role contracts
// ---------------------------------------------------------------------------

describe('AL5.2 role contracts — enforced, not documented', () => {
  it('a role without delegation rights is rejected at spawn time with an actionable error', async () => {
    const spawner = new AgentSpawner(
      { call: async () => ({ content: '', toolCalls: [] }) },
      { execute: async () => ({ success: true, output: '' }) },
      { get: () => undefined, save: () => undefined, create: () => ({ id: 's', messages: [] }) },
    );
    await expect(
      spawner.spawn({
        role: 'researcher',
        task: 'look something up',
        spawnedBy: { role: 'coder', depth: 1 },
      }),
    ).rejects.toThrow(/Role "coder" has no delegation right to spawn "researcher".*may not spawn any role/);
  });

  it('a granted right passes the contract check; the depth ceiling still binds', () => {
    expect(() => assertSpawnAllowed({ role: 'architect', depth: 0 }, 'researcher')).not.toThrow();
    expect(() => assertSpawnAllowed({ role: 'architect', depth: 1 }, 'coder')).toThrow(
      /no delegation right to spawn "coder".*may spawn: researcher/,
    );
    expect(() =>
      assertSpawnAllowed({ role: 'architect', depth: GLOBAL_MAX_SPAWN_DEPTH }, 'researcher'),
    ).toThrow(/spawn-depth ceiling is 3/);
  });

  it('message rights are enforced through the messenger when role metadata is present', () => {
    const bus = new AgentMessenger();
    // tester may message the build chain…
    expect(() =>
      bus.send({ from: 't1', to: 'd1', type: 'context', content: 'repro attached', fromRole: 'tester', toRole: 'debugger' }),
    ).not.toThrow();
    // …but not outward-facing roles.
    expect(() =>
      bus.send({ from: 't1', to: 'm1', type: 'context', content: 'hi', fromRole: 'tester', toRole: 'marketing-agent' }),
    ).toThrow(/Role "tester" may not message "marketing-agent"/);
    // Id-only sends (no role metadata) stay unrestricted — back-compat.
    expect(() => bus.send({ from: 'x', to: 'y', type: 'context', content: 'legacy' })).not.toThrow();
    expect(() => assertMessageAllowed('architect', 'marketing-agent')).not.toThrow(); // default: all
  });

  it('capabilities are the enforced tool allowlist; knowledge scope gates memory tiers', () => {
    expect(() => assertToolAllowed('architect', 'coder.read-file')).not.toThrow();
    expect(() => assertToolAllowed('architect', 'coder.write-file')).toThrow(
      /Role "architect" capability list does not include tool "coder.write-file"/,
    );
    expect(() => assertKnowledgeScope('coder', 'read', 'semantic')).not.toThrow();
    expect(() => assertKnowledgeScope('coder', 'write', 'semantic')).toThrow(
      /may not write memory tier "semantic".*invariant 5/,
    );
    // Contract shape: budget rides the role definition.
    expect(getContract('coder').budget.maxIterations).toBeGreaterThan(0);
    expect(getContract('coder').delegationRights.spawn).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AL5.3 contract-net negotiation
// ---------------------------------------------------------------------------

describe('AL5.3 contract-net — offer → bids → award over the existing messenger', () => {
  it('runs one full round-trip and the award is cited in the message log', () => {
    const bus = new AgentMessenger();
    const offer = postOffer(bus, {
      task: 'Summarize the last 24h of prod errors',
      from: 'orchestrator-1',
      eligibleRoles: ['researcher', 'analyst'],
    });

    const bid = (agentId: string, role: TaskBid['role'], confidence: number, estimatedCost: number): TaskBid =>
      ({ taskId: offer.taskId, agentId, role, confidence, estimatedCost });

    submitBid(bus, offer, bid('res-1', 'researcher', 0.9, 500));
    submitBid(bus, offer, bid('ana-1', 'analyst', 0.9, 300));
    submitBid(bus, offer, bid('cod-1', 'coder', 1.0, 10)); // ineligible role — must lose by rejection
    bus.send({ from: 'chaos', to: 'orchestrator-1', type: 'bid', content: '{not json' }); // malformed

    const award = awardTask(bus, offer);
    expect(award).not.toBeNull();
    // Deterministic: confidence tie (0.9) broken by lower estimatedCost.
    expect(award).toMatchObject<Partial<TaskAward>>({
      taskId: offer.taskId,
      winnerAgentId: 'ana-1',
      winnerRole: 'analyst',
    });
    expect(award!.reason).toMatch(/confidence 0\.9 @ ~300 tokens/);
    expect(award!.reason).toMatch(/2 rejected/); // ineligible + malformed, named not silent

    // The award is on the bus as an auditable broadcast — the cited log.
    const log = bus.getAll();
    const awardMsg = log.find((m) => m.type === 'award')!;
    expect(awardMsg.to).toBe('all');
    expect(JSON.parse(awardMsg.content)).toMatchObject({ winnerAgentId: 'ana-1' });
    expect(log.map((m) => m.type)).toEqual(['task-offer', 'bid', 'bid', 'bid', 'bid', 'award']);
    // buildContext renders the negotiation for any agent catching up.
    expect(bus.buildContext('res-1')).toContain('[TASK OFFER from orchestrator-1]');
    expect(bus.buildContext('res-1')).toContain('[AWARD from orchestrator-1]');
  });

  it('author-side bid validation is fail-loud; no eligible bids → null award (offerer decides fallback)', () => {
    const bus = new AgentMessenger();
    const offer = postOffer(bus, { task: 'x', from: 'orch', eligibleRoles: ['researcher'] });
    expect(() =>
      submitBid(bus, offer, { taskId: offer.taskId, agentId: 'a', role: 'researcher', confidence: 1.7, estimatedCost: 1 }),
    ).toThrow(/confidence must be 0\.\.1/);
    expect(() =>
      submitBid(bus, offer, { taskId: 'other-task', agentId: 'a', role: 'researcher', confidence: 0.5, estimatedCost: 1 }),
    ).toThrow(/does not match offer/);
    expect(awardTask(bus, offer)).toBeNull();
  });
});
