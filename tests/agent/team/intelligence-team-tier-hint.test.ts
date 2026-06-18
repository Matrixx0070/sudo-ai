/**
 * IntelligenceTeam.spawn → brain.call wire-in tests.
 *
 * Verifies the planning wire-in from PR #244 plus the schema-verifier
 * extension (this PR). The synthesis call site (in IntelligenceTeam.run,
 * line ~515) is verified by code inspection + lint; building a full team
 * to exercise the run() path would require worker_threads infrastructure
 * unsuitable for a unit test. The worker proxy at line ~318 is
 * intentionally left WITHOUT the tier hint — it's a per-worker-step hot
 * path and 3× cost there would be catastrophic.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  IntelligenceTeam,
  buildTeamPlanVerifier,
  type Brain,
  type ToolRegistry,
} from '../../../src/core/agent/team/intelligence-team.js';

describe('IntelligenceTeam.spawn → planning brain.call', () => {
  it('forwards { tier: "high-stakes", verifier } as the second arg', async () => {
    // Brain returns a valid empty array — spawn() will fall back to the
    // default single-agent role, but planning brain.call still fires.
    const call = vi.fn().mockResolvedValue({ content: '[]' });
    const brain: Brain = { call };
    const registry: ToolRegistry = {};

    await IntelligenceTeam.spawn('demo task', registry, brain);

    expect(call).toHaveBeenCalledTimes(1);
    const opts = call.mock.calls[0]?.[1];
    expect(opts.tier).toBe('high-stakes');
    expect(typeof opts.verifier).toBe('function');
  });

  it('still forwards the tier hint + verifier when planning JSON is malformed (catch path)', async () => {
    // Garbage content → JSON.parse throws → fallback to default agent.
    // The brain call STILL happened and STILL carried the tier hint + verifier.
    const call = vi.fn().mockResolvedValue({ content: 'not-json-at-all' });
    const brain: Brain = { call };

    await IntelligenceTeam.spawn('demo task', {}, brain);

    expect(call).toHaveBeenCalledTimes(1);
    const opts = call.mock.calls[0]?.[1];
    expect(opts.tier).toBe('high-stakes');
    expect(typeof opts.verifier).toBe('function');
  });
});

describe('buildTeamPlanVerifier — predicate', () => {
  const REQ = { messages: [{ role: 'user' as const, content: 'demo' }] };
  function resp(content: string) {
    return {
      content,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      model: 'stub',
      finishReason: 'stop' as const,
    };
  }
  const validTeam = JSON.stringify([
    { name: 'researcher', systemPrompt: 'You research things.', task: 'find sources' },
    { name: 'writer', systemPrompt: 'You write things.', task: 'draft prose' },
  ]);

  it('accepts a valid team plan with required fields', async () => {
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp(validTeam), REQ);
    expect(verdict.score).toBe(1.0);
    expect(verdict.reason).toBeUndefined();
  });

  it('rejects an object root (planner returned a single object, not an array)', async () => {
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp('{"name":"r","systemPrompt":"sp","task":"t"}'), REQ);
    expect(verdict.score).toBe(0.0);
    // The schema verifier extracts a balanced JSON literal first; the
    // object root parses successfully but predicate then rejects it.
    expect(verdict.reason).toMatch(/JSON array of agent objects|top-level array rejected/);
  });

  it('rejects an empty array (below MIN_TEAM_SIZE)', async () => {
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp('[]'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/out of range/);
  });

  it('rejects a 7-agent array (above MAX_TEAM_SIZE)', async () => {
    const team = Array.from({ length: 7 }, (_, i) => ({
      name: `a${i}`,
      systemPrompt: 'sp',
      task: 't',
    }));
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp(JSON.stringify(team)), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/team size 7 out of range/);
  });

  it('rejects an array containing a non-object item', async () => {
    const team = [
      { name: 'r', systemPrompt: 'sp', task: 't' },
      'oops-just-a-string',
    ];
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp(JSON.stringify(team)), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/agent 1 is not an object/);
  });

  it('rejects an agent with a missing required field', async () => {
    const team = [{ name: 'r', systemPrompt: 'sp' /* task missing */ }];
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp(JSON.stringify(team)), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/agent 0 missing or non-string field: task/);
  });

  it('rejects an agent with an empty-string required field', async () => {
    const team = [{ name: 'r', systemPrompt: '   ', task: 't' }];
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp(JSON.stringify(team)), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/agent 0 missing or non-string field: systemPrompt/);
  });

  it('rejects malformed JSON (parse failure)', async () => {
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp('[{name: "r"}]'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/JSON parse failed|no JSON literal/);
  });

  it('tolerates a JSON code fence (``` wrapped output)', async () => {
    const v = buildTeamPlanVerifier();
    const verdict = await v(resp('```json\n' + validTeam + '\n```'), REQ);
    expect(verdict.score).toBe(1.0);
  });
});
