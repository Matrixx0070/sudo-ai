/**
 * IntelligenceTeam.spawn → brain.call passes { tier: 'high-stakes' }.
 *
 * Verifies the planning wire-in from PR #244. The synthesis call site
 * (in IntelligenceTeam.run, line ~445) is verified by code inspection
 * + lint; building a full team to exercise the run() path would require
 * worker_threads infrastructure unsuitable for a unit test. The worker
 * proxy at line ~248 is intentionally left WITHOUT the tier hint — it's
 * a per-worker-step hot path and 3× cost there would be catastrophic.
 */

import { describe, it, expect, vi } from 'vitest';
import { IntelligenceTeam, type Brain, type ToolRegistry } from '../../../src/core/agent/team/intelligence-team.js';

describe('IntelligenceTeam.spawn → planning brain.call', () => {
  it('forwards { tier: "high-stakes" } as the second arg', async () => {
    // Brain returns a valid empty array — spawn() will fall back to the
    // default single-agent role, but planning brain.call still fires.
    const call = vi.fn().mockResolvedValue({ content: '[]' });
    const brain: Brain = { call };
    const registry: ToolRegistry = {};

    await IntelligenceTeam.spawn('demo task', registry, brain);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'high-stakes' });
  });

  it('still forwards the tier hint when planning JSON is malformed (catch path)', async () => {
    // Garbage content → JSON.parse throws → fallback to default agent.
    // The brain call STILL happened and STILL carried the tier hint.
    const call = vi.fn().mockResolvedValue({ content: 'not-json-at-all' });
    const brain: Brain = { call };

    await IntelligenceTeam.spawn('demo task', {}, brain);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'high-stakes' });
  });
});
