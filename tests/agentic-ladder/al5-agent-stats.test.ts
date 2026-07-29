/**
 * @file al5-agent-stats.test.ts
 * @description AL5.5 salvage (merge-salvage DECIDED 2026-07-28, Frank's
 * delegated design authority): success-rate agent selection lifted from the
 * quarantined SwarmManager into agents/agent-stats.ts, wired as the AL5.3
 * award function's track-record weight and AL6's failure-rate signal feed.
 * The swarm module itself is untouched (never-drop).
 */

import { describe, it, expect } from 'vitest';
import {
  AgentMessenger,
  AgentPerfTracker,
  awardTask,
  postOffer,
  submitBid,
  type TaskBid,
} from '../../src/core/agents/index.js';

describe('AL5.5 AgentPerfTracker — the salvaged getBestAgent ordering', () => {
  it('smooths rates with a neutral 0.5 prior and orders by rate, then attempts, then id', () => {
    const t = new AgentPerfTracker();
    expect(t.successRate('unknown')).toBe(0.5); // Laplace prior — new agents neutral

    for (let i = 0; i < 8; i++) t.record({ agentId: 'vet', success: true });
    t.record({ agentId: 'vet', success: false }); // 8/9 → (9)/(11) ≈ .818
    t.record({ agentId: 'rookie', success: true }); // 1/1 → 2/3 ≈ .667
    t.record({ agentId: 'flop', success: false }); // 0/1 → 1/3

    expect(t.successRate('vet')).toBeCloseTo(9 / 11);
    expect(t.bestAgent(['flop', 'rookie', 'vet'])).toBe('vet');
    expect(t.bestAgent([])).toBeNull();

    // Equal rates → more attempts wins (the swarm's tasks_completed DESC).
    const t2 = new AgentPerfTracker();
    t2.record({ agentId: 'a', success: true });
    t2.record({ agentId: 'a', success: false });
    t2.record({ agentId: 'a', success: true });
    t2.record({ agentId: 'a', success: false }); // 2/4 → .5
    // 'b' unrecorded → .5 prior with 0 attempts.
    expect(t2.bestAgent(['b', 'a'])).toBe('a');
  });

  it('feeds AL6: unsmoothed failure rate, overall and per role, calm (0) when empty', () => {
    const t = new AgentPerfTracker();
    expect(t.failureRate()).toBe(0);
    t.record({ agentId: 'r1', role: 'researcher', success: true });
    t.record({ agentId: 'r1', role: 'researcher', success: false });
    t.record({ agentId: 'c1', role: 'coder', success: false });
    expect(t.failureRate()).toBeCloseTo(2 / 3);
    expect(t.failureRate('researcher')).toBeCloseTo(1 / 2);
    expect(t.failureRate('coder')).toBe(1);
  });
});

describe('AL5.5 award × track record', () => {
  function bidRound(stats?: AgentPerfTracker) {
    const bus = new AgentMessenger();
    const offer = postOffer(bus, { task: 'x', from: 'orch', eligibleRoles: ['researcher', 'analyst'] });
    const bid = (agentId: string, role: TaskBid['role'], confidence: number, cost: number): TaskBid =>
      ({ taskId: offer.taskId, agentId, role, confidence, estimatedCost: cost });
    submitBid(bus, offer, bid('proven', 'researcher', 0.8, 500));
    submitBid(bus, offer, bid('untried', 'analyst', 0.8, 300));
    return awardTask(bus, offer, stats ? { stats } : {});
  }

  it('without stats behavior is unchanged: confidence tie → lower cost wins', () => {
    expect(bidRound()!.winnerAgentId).toBe('untried');
  });

  it('with stats a proven agent outweighs an equal-confidence cheaper unknown', () => {
    const stats = new AgentPerfTracker();
    for (let i = 0; i < 9; i++) stats.record({ agentId: 'proven', role: 'researcher', success: true });
    // proven: 0.8 × (10/11) ≈ .727 beats untried: 0.8 × 0.5 = .4
    const award = bidRound(stats)!;
    expect(award.winnerAgentId).toBe('proven');
    expect(award.reason).toMatch(/× rate 0\.91/);
  });
});
