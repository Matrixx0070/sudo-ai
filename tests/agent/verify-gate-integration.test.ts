/**
 * @file verify-gate-integration.test.ts
 * Integration test for `executeToolCalls` exercising the verify-gate pipeline.
 *
 * Closes slice 1's MED-2 carryover (an integration test for the escalate hook
 * path) and pins slice 2's grounding-check semantics end-to-end.
 *
 * Branches covered:
 *
 *   VGI-01 destructive tool, gate allows           → tool executes, no gate hooks
 *   VGI-02 destructive tool, gate escalates,       → tool executes,
 *          grounding ok                              `verify_gate_escalated` emitted,
 *                                                    no `verify_gate_grounding_failed`
 *   VGI-03 destructive tool, gate escalates,       → tool executes (observable),
 *          grounding fails, block disabled           both hook events emitted,
 *                                                    `blocked: false` on grounding event
 *   VGI-04 destructive tool, gate escalates,       → tool BLOCKED (registry.execute
 *          grounding fails, block enabled            never called), structured
 *                                                    `[VerifyGate] Tool call blocked` msg,
 *                                                    `blocked: true` on grounding event
 *   VGI-05 grounding checker throws                → fail-open: tool executes,
 *                                                    no `verify_gate_grounding_failed`
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  executeToolCalls,
  type ToolRegistryLike,
  type SessionLike,
  type VerifyGateLike,
  type GroundingCheckerLike,
  type CriticPassLike,
  type HookEmitterLike,
} from '../../src/core/agent/loop-helpers.js';
import { PermissionManager } from '../../src/core/agent/permissions.js';
import type { AgentState } from '../../src/core/agent/types.js';

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `tc-${Math.random().toString(36).slice(2, 9)}`, name, arguments: args };
}

function makeState(): AgentState {
  return {
    sessionId: 'test-session',
    isCompacting: false,
    pendingToolCalls: 0,
    iterationCount: 0,
    maxIterations: 50,
    consecutiveReplans: 0,
  } as AgentState;
}

function makeSession(): SessionLike {
  return { id: 'test-session', messages: [] };
}

function makeRegistry(): { registry: ToolRegistryLike; executed: () => string[] } {
  const calls: string[] = [];
  const registry: ToolRegistryLike = {
    execute: vi.fn(async (name: string) => {
      calls.push(name);
      return { success: true, output: `ok:${name}` };
    }),
    getSchemaForLLM: vi.fn(() => []),
  };
  return { registry, executed: () => calls };
}

function makeHooks(): { hooks: HookEmitterLike; events: Array<{ event: string; ctx: Record<string, unknown> }> } {
  const events: Array<{ event: string; ctx: Record<string, unknown> }> = [];
  const hooks: HookEmitterLike = {
    emit: async (event: string, ctx: Record<string, unknown>) => {
      events.push({ event, ctx });
    },
  };
  return { hooks, events };
}

function escalatingGate(toolName: string): VerifyGateLike {
  return {
    evaluate: (name: string) =>
      name === toolName
        ? { decision: 'escalate', confidence: 0.2, threshold: 0.55, samples: 20, reason: 'below-threshold' }
        : { decision: 'allow', confidence: null, threshold: 0.55, samples: 0, reason: 'readonly' },
  };
}

function allowingGate(): VerifyGateLike {
  return {
    evaluate: () => ({ decision: 'allow', confidence: null, threshold: 0.55, samples: 0, reason: 'readonly' }),
  };
}

function fixedGrounding(ok: boolean, reason = ok ? 'edit-grounding-ok' : 'edit-grounding-fail'): GroundingCheckerLike {
  return {
    check: async () => ({
      ok,
      reason,
      checked: 'edit-grounding',
      evidence: { filePath: '/tmp/x.txt', oldStringLen: 10 },
    }),
  };
}

async function drainMicrotasks(): Promise<void> {
  // safeEmit is fire-and-forget. Drain a full macrotask turn so hook
  // assertions remain stable even if safeEmit grows internal awaits.
  await new Promise((r) => setTimeout(r, 0));
}

// File-level env baseline (defense against future describe-block splits
// into separate files run in parallel workers). Captures the slice-4 and
// slice-5 opt-in flags BEFORE any describe block can mutate them, and
// restores at file-end no matter what individual describe-level cleanup
// did. Vitest's top-level beforeAll/afterAll fire once per file, outside
// any describe scope, so they're the safe outer guard. (Verifier MED-2.)
const FILE_PREV_FEEDBACK = process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
const FILE_PREV_BLOCK = process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'];
afterAll(() => {
  if (FILE_PREV_FEEDBACK === undefined) delete process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
  else process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = FILE_PREV_FEEDBACK;
  if (FILE_PREV_BLOCK === undefined) delete process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'];
  else process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'] = FILE_PREV_BLOCK;
});

describe('executeToolCalls — verify-gate slice 1 + slice 2 integration', () => {
  // Guard against permission-override pollution from any other test in the
  // suite — PermissionManager is a process-wide singleton. Without this,
  // a stray `deny` override on coder.write-file would cause Phase-0 in
  // executeToolCalls to short-circuit BEFORE the gate code runs, silently
  // false-passing every assertion below.
  beforeEach(() => {
    PermissionManager.getInstance().resetAll();
  });
  it('VGI-01 allow decision → tool executes, no gate hooks', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', content: 'hello' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      allowingGate(),
      fixedGrounding(false), // would fire if gate didn't allow
      true,                  // block enabled — proves it's gate-gated
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_escalated')).toBeUndefined();
    expect(events.find((e) => e.event === 'verify_gate_grounding_failed')).toBeUndefined();
  });

  it('VGI-02 escalate + grounding ok → tool runs, escalate hook only', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(true),
      true, // block enabled — doesn't matter, grounding ok
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    const escalated = events.find((e) => e.event === 'verify_gate_escalated');
    expect(escalated).toBeDefined();
    expect(escalated?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      confidence: 0.2,
      threshold: 0.55,
      samples: 20,
      reason: 'below-threshold',
    });
    expect(events.find((e) => e.event === 'verify_gate_grounding_failed')).toBeUndefined();
  });

  it('VGI-03 escalate + grounding fail, block disabled → tool still runs, both hooks emitted', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false, // observable-only
    );

    expect(executed()).toEqual(['coder.write-file']);
    // Positive-shape assertion: message is the tool result (not a permission/
    // security/verify-gate block message) — catches a false-pass if the
    // singleton-state guard above ever regresses.
    expect(session.messages[0]?.role).toBe('tool');
    expect(session.messages[0]?.content).toBe('ok:coder.write-file');
    expect(String(session.messages[0]?.content)).not.toMatch(/^\[(PermissionManager|SecurityGuard|VerifyGate)\]/);
    await drainMicrotasks();
    const escalated = events.find((e) => e.event === 'verify_gate_escalated');
    const groundingFailed = events.find((e) => e.event === 'verify_gate_grounding_failed');
    expect(escalated).toBeDefined();
    expect(groundingFailed).toBeDefined();
    expect(groundingFailed?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      reason: 'edit-grounding-fail',
      checked: 'edit-grounding',
      blocked: false,
      // Slice-3 ergonomics: confidence/threshold carried alongside grounding
      // result so a critic consumer doesn't have to correlate two hook events.
      confidence: 0.2,
      threshold: 0.55,
    });
  });

  it('VGI-04 escalate + grounding fail, block enabled → tool BLOCKED, registry.execute never called', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      true, // BLOCK
    );

    expect(executed()).toEqual([]); // tool was not executed
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe('tool');
    expect(String(session.messages[0]?.content)).toMatch(/^\[VerifyGate\] Tool call blocked: coder\.write-file/);
    expect(String(session.messages[0]?.content)).toMatch(/edit-grounding-fail/);

    await drainMicrotasks();
    const escalated = events.find((e) => e.event === 'verify_gate_escalated');
    const groundingFailed = events.find((e) => e.event === 'verify_gate_grounding_failed');
    expect(escalated).toBeDefined();
    expect(groundingFailed?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      reason: 'edit-grounding-fail',
      blocked: true,
    });
  });

  // Slice 3 — auto-critic. The critic verdict ships out as a hook event but
  // never blocks tool execution in slice 3 (observable-only).

  function recordingCritic(
    review: CriticPassLike['review'],
  ): { critic: CriticPassLike; reviews: Array<Parameters<CriticPassLike['review']>[0]> } {
    const reviews: Array<Parameters<CriticPassLike['review']>[0]> = [];
    const critic: CriticPassLike = {
      review: async (input) => {
        reviews.push(input);
        return review(input);
      },
    };
    return { critic, reviews };
  }

  it('VGI-06 escalate + grounding fail observable → critic invoked with grounding-failed trigger', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'old_string not present in file',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false, // observable-only
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']); // critic is observable-only
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      confidence: 0.2,
      threshold: 0.55,
    });
    expect(reviews[0]?.evidence).toMatchObject({ reason: 'edit-grounding-fail' });

    await drainMicrotasks();
    const invoked = events.find((e) => e.event === 'verify_gate_critic_invoked');
    expect(invoked).toBeDefined();
    expect(invoked?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      verdict: 'reject',
      rationale: 'old_string not present in file',
    });
  });

  it('VGI-07 escalate + grounding ok → critic gets low-confidence trigger, skipped hook event', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: false,
      verdict: 'skip',
      reason: 'soft-skip',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(true),
      true, // block enabled — doesn't matter, grounding ok
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.trigger).toBe('low-confidence');
    // No grounding evidence on the soft path.
    expect(reviews[0]?.evidence).toBeUndefined();

    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    const skipped = events.find((e) => e.event === 'verify_gate_critic_skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'low-confidence',
      reason: 'soft-skip',
    });
  });

  it('VGI-08 escalate + grounding fail, block enabled → critic never invoked (already blocked)', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'approve',
      reason: 'invoked',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      true, // BLOCK — short-circuits before the critic
      critic,
    );

    expect(executed()).toEqual([]);
    expect(reviews).toHaveLength(0);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    expect(events.find((e) => e.event === 'verify_gate_critic_skipped')).toBeUndefined();
  });

  it('VGI-09 critic returns budget-exhausted → dedicated hook event, no invoked event', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic } = recordingCritic(async () => ({
      invoked: false,
      verdict: 'skip',
      reason: 'budget-exhausted',
      rationale: 'errors=2/3',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    const budget = events.find((e) => e.event === 'verify_gate_critic_budget_exhausted');
    expect(budget).toBeDefined();
    expect(budget?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      reason: 'budget-exhausted',
      // MED-2: rationale carries errors=K/N so ops can distinguish
      // "flaky provider burned the budget" from "real reviews burned it".
      rationale: 'errors=2/3',
    });
  });

  it('VGI-12 grounding checker throws + critic wired → soft low-confidence trigger', async () => {
    // LOW-1 coverage: VGI-05 covered the throw path before slice 3 existed and
    // did not assert critic behavior. Here we pin: when grounding threw and
    // groundingFailedObservable stays false, the critic gets the SOFT trigger
    // ('low-confidence') and immediately short-circuits — no LLM call.
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: false,
      verdict: 'skip',
      reason: 'soft-skip',
    }));
    const throwing: GroundingCheckerLike = {
      check: async () => { throw new Error('disk on fire'); },
    };
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      throwing,
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.trigger).toBe('low-confidence');
    expect(reviews[0]?.evidence).toBeUndefined();
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_grounding_error')).toBeDefined();
    const skipped = events.find((e) => e.event === 'verify_gate_critic_skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'low-confidence',
      reason: 'soft-skip',
    });
  });

  it('VGI-10 critic.review throws → fail-open, dedicated error event, tool still runs', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const critic: CriticPassLike = {
      review: async () => { throw new Error('critic on fire'); },
    };
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    const erred = events.find((e) => e.event === 'verify_gate_critic_error');
    expect(erred).toBeDefined();
    expect(erred?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      err: expect.stringContaining('critic on fire'),
    });
  });

  it('VGI-11 gate allow → critic never consulted (no escalation, nothing to critique)', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', content: 'hello' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      allowingGate(),
      fixedGrounding(false),
      true,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    expect(reviews).toHaveLength(0);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    expect(events.find((e) => e.event === 'verify_gate_critic_skipped')).toBeUndefined();
  });

  it('VGI-05 grounding checker throws → fail-open, tool runs, no grounding_failed event', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const throwing: GroundingCheckerLike = {
      check: async () => { throw new Error('disk on fire'); },
    };
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      throwing,
      true, // block enabled — should still NOT block since grounding threw
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_escalated')).toBeDefined();
    expect(events.find((e) => e.event === 'verify_gate_grounding_failed')).toBeUndefined();
    // MED-3: distinguish "checker threw" from "no checker wired" — the
    // throw path emits a dedicated verify_gate_grounding_error event so
    // ops dashboards and slice-3 critics don't read a silent pass-through.
    const erred = events.find((e) => e.event === 'verify_gate_grounding_error');
    expect(erred).toBeDefined();
    expect(erred?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      err: expect.stringContaining('disk on fire'),
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — agent-facing feedback via tool-result prefix
//
// `Brain.toSDKMessages` drops mid-conversation `role: 'system'` messages from
// the request, so a naïve system-message inject would be silently swallowed.
// Slice 4 prepends the critic's rationale to the rejected tool's own
// `role: 'tool'` result content — that channel passes straight through to the
// model, so the agent sees the criticism on its next turn.
//
// Branches covered:
//   VGI-13 reject + feedback flag on    → tool message stored with prefix,
//                                         tool-result event un-prefixed,
//                                         tool_result_persist sees prefix
//   VGI-14 reject + feedback flag off   → tool message stored WITHOUT prefix
//                                         (default-OFF opt-in)
//   VGI-15 approve + flag on            → no prefix (only `'reject'` triggers)
//   VGI-16 low-confidence soft-skip     → no prefix (critic never returned a verdict)
// ---------------------------------------------------------------------------

describe('executeToolCalls — verify-gate slice 4 (agent-facing feedback)', () => {
  function recordingCritic(
    review: CriticPassLike['review'],
  ): { critic: CriticPassLike; reviews: Array<Parameters<CriticPassLike['review']>[0]> } {
    const reviews: Array<Parameters<CriticPassLike['review']>[0]> = [];
    const critic: CriticPassLike = {
      review: async (input) => {
        reviews.push(input);
        return review(input);
      },
    };
    return { critic, reviews };
  }

  // PermissionManager + process.env are process-wide singletons.
  // Reset both around each test so a stray override / leftover flag
  // can't false-pass another assertion. PREV_ENV is captured inside
  // beforeAll (NOT at describe-evaluation time) so an earlier test file
  // that mutated the env and didn't clean up can't silently contaminate
  // our restore baseline. (Verifier MED-2 on slice 4.)
  let PREV_ENV: string | undefined;
  beforeAll(() => {
    PREV_ENV = process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
  });
  beforeEach(() => {
    PermissionManager.getInstance().resetAll();
    delete process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
  });
  afterAll(() => {
    if (PREV_ENV === undefined) delete process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
    else process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = PREV_ENV;
  });

  it('VGI-13 reject + flag on → tool message prefixed, tool-result event un-prefixed', async () => {
    process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = '1';
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const { critic } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'old_string not present in file',
    }));
    const emitted: Array<{ type: string; result?: string }> = [];
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(),
      (ev) => { emitted.push(ev as { type: string; result?: string }); },
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false, // observable-only — critic must reach reject path
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']); // slice 4 stays observable too

    // (a) session history carries the prefix → model sees it on next turn.
    expect(session.messages).toHaveLength(1);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored.startsWith('[VERIFY-GATE CRITIC REJECT] old_string not present in file')).toBe(true);
    expect(stored.endsWith('ok:coder.write-file')).toBe(true);
    // Order: prefix line, blank line, raw output. Pin it.
    expect(stored).toBe('[VERIFY-GATE CRITIC REJECT] old_string not present in file\n\nok:coder.write-file');

    // (b) live tool-result event still carries the un-prefixed payload —
    // telemetry and stream observers see exactly what the tool returned.
    const toolResultEvent = emitted.find((e) => e.type === 'tool-result');
    expect(toolResultEvent?.result).toBe('ok:coder.write-file');

    // (c) tool_result_persist hook fires with the persisted (prefixed) content
    // so a downstream subscriber can correlate with verify_gate_critic_invoked.
    await drainMicrotasks();
    const persist = events.find((e) => e.event === 'tool_result_persist');
    expect(persist?.ctx?.['result']).toBe(stored);
  });

  it('VGI-14 reject + flag OFF → tool message stored WITHOUT prefix (default-OFF opt-in)', async () => {
    // Flag explicitly NOT set — beforeEach already deleted it.
    const { registry, executed } = makeRegistry();
    const { hooks } = makeHooks();
    const session = makeSession();
    const { critic } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'old_string not present in file',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored).toBe('ok:coder.write-file');
    expect(stored).not.toMatch(/VERIFY-GATE CRITIC/);
  });

  it('VGI-15 approve + flag on → no prefix (only reject triggers feedback)', async () => {
    process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = '1';
    const { registry, executed } = makeRegistry();
    const { hooks } = makeHooks();
    const session = makeSession();
    const { critic } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'approve',
      reason: 'invoked',
      rationale: 'file is reversible, edit looks safe',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored).toBe('ok:coder.write-file');
    expect(stored).not.toMatch(/VERIFY-GATE CRITIC/);
  });

  it('VGI-17 reject + flag on + tool_not_found fallback → prefix attached on fallback result', async () => {
    // The code comment claims criticFeedback is still informative on the
    // tool_not_found path because the critic ran on the call the agent
    // *planned*. Pin that contract: prefix lands on the fallback message.
    process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = '1';
    const session = makeSession();
    const { hooks } = makeHooks();
    const { critic } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'tool name looks made-up',
    }));
    // Registry that throws tool_not_found on every execute (matches the
    // ToolError code branch in executeSingleToolCall's catch).
    const { ToolError } = await import('../../src/core/shared/errors.js');
    const calls: string[] = [];
    const notFoundRegistry: ToolRegistryLike = {
      execute: vi.fn(async (name: string) => {
        calls.push(name);
        // ToolError constructor is (message, code) — getting this backwards
        // makes err.code !== 'tool_not_found' and the tool_not_found branch
        // is missed silently. Pin it.
        throw new ToolError(`Tool not registered: ${name}`, 'tool_not_found');
      }),
      getSchemaForLLM: vi.fn(() => []),
    };

    await executeToolCalls(
      [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })],
      session, makeState(), () => undefined,
      notFoundRegistry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false, // observable-only — critic must reach reject path
      critic,
    );

    // tool_not_found triggers the 3-step fallback chain on the registry,
    // which in turn calls registry.execute again for tool.search-mcp-catalog
    // / search-npm / synthesize — all of which our throwing stub also rejects
    // with tool_not_found, so the chain exhausts and returns the "could not
    // be auto-resolved" message. That's the content the prefix should land on.
    expect(session.messages).toHaveLength(1);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored.startsWith('[VERIFY-GATE CRITIC REJECT] tool name looks made-up')).toBe(true);
    // The fallback message format is pinned by _toolNotFoundFallback.
    expect(stored).toMatch(/Tool not found and could not be auto-resolved: coder\.write-file/);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('VGI-16 low-confidence soft-skip + flag on → no prefix (critic never returned a verdict)', async () => {
    process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = '1';
    const { registry, executed } = makeRegistry();
    const { hooks } = makeHooks();
    const session = makeSession();
    const { critic } = recordingCritic(async () => ({
      invoked: false,
      verdict: 'skip',
      reason: 'soft-skip',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(true), // grounding OK → soft-skip path
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored).toBe('ok:coder.write-file');
    expect(stored).not.toMatch(/VERIFY-GATE CRITIC/);
  });
});

// ---------------------------------------------------------------------------
// Slice 5 — critic-reject hard block (SUDO_VERIFY_GATE_CRITIC_BLOCK=1)
//
// Closes the campaign's last "soft → hard" gradient. Slice 3 ships the
// critic observable-only; slice 5 lets an operator opt in to refusing
// any `'reject'` invoke before `toolRegistry.execute` runs.
//
// Branches covered:
//   VGI-18  reject + block on            → tool BLOCKED (registry.execute
//                                          never called), `[VerifyGate] Tool
//                                          call blocked: ... — critic reject`
//                                          message stored, critic event still
//                                          fired (slice 3 contract preserved)
//   VGI-19  reject + block off           → tool runs (slice-3 observable
//                                          contract intact when flag absent)
//   VGI-20  approve + block on           → tool runs (only `'reject'` triggers
//                                          the block; soft-skips + approvals
//                                          stay observable per slice-3 cadence)
//   VGI-21  reject + block on + feedback → BLOCK wins; the block message
//          on (precedence)                 itself names the critic rejection,
//                                          so the slice-4 prefix is NOT
//                                          prepended on top
// ---------------------------------------------------------------------------

describe('executeToolCalls — verify-gate slice 5 (critic-reject hard block)', () => {
  function recordingCritic(
    review: CriticPassLike['review'],
  ): { critic: CriticPassLike; reviews: Array<Parameters<CriticPassLike['review']>[0]> } {
    const reviews: Array<Parameters<CriticPassLike['review']>[0]> = [];
    const critic: CriticPassLike = {
      review: async (input) => {
        reviews.push(input);
        return review(input);
      },
    };
    return { critic, reviews };
  }

  // PREV_BLOCK + PREV_FEEDBACK captured inside beforeAll so an earlier
  // test file that mutated env and didn't clean up can't silently
  // contaminate our restore baseline (verifier MED-2 on slice 4).
  let PREV_BLOCK: string | undefined;
  let PREV_FEEDBACK: string | undefined;
  beforeAll(() => {
    PREV_BLOCK = process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'];
    PREV_FEEDBACK = process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
  });
  beforeEach(() => {
    PermissionManager.getInstance().resetAll();
    delete process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'];
    delete process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
  });
  afterAll(() => {
    if (PREV_BLOCK === undefined) delete process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'];
    else process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'] = PREV_BLOCK;
    if (PREV_FEEDBACK === undefined) delete process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'];
    else process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = PREV_FEEDBACK;
  });

  it('VGI-18 reject + block on → tool BLOCKED, structured message stored, critic event still fired', async () => {
    process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'] = '1';
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'old_string not present in file',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false, // grounding observable (so we reach the critic path, not the grounding-block path)
      critic,
    );

    // (a) Tool was not executed.
    expect(executed()).toEqual([]);

    // (b) Block message landed in session history in the slice-2 shape so
    //     downstream observers can catch both block paths with one regex.
    expect(session.messages).toHaveLength(1);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored).toBe('[VerifyGate] Tool call blocked: coder.write-file — critic reject (old_string not present in file)');
    expect(stored).toMatch(/^\[VerifyGate\] Tool call blocked: \S+ — critic reject \(/);

    // (c) Critic was reached (slice-3 contract preserved: events fire BEFORE the block decision).
    expect(reviews).toHaveLength(1);
    await drainMicrotasks();
    const invoked = events.find((e) => e.event === 'verify_gate_critic_invoked');
    expect(invoked?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      verdict: 'reject',
      rationale: 'old_string not present in file',
    });

    // (d) Slice 6 — dedicated `verify_gate_critic_blocked` correlator
    //     event carries the full block context so alert routers don't
    //     have to regex-match the `[VerifyGate]` message shape.
    const blockedEvent = events.find((e) => e.event === 'verify_gate_critic_blocked');
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.ctx).toMatchObject({
      // sessionId spot-check guards a future regression that accidentally
      // omits it from the correlator payload (verifier LOW-2 on slice 6).
      sessionId: expect.any(String),
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      confidence: 0.2,
      threshold: 0.55,
      rationale: 'old_string not present in file',
      message: stored,
    });

    // (e) Order: invoked fires BEFORE blocked (verdict → enforcement).
    const invokedIdx = events.findIndex((e) => e.event === 'verify_gate_critic_invoked');
    const blockedIdx = events.findIndex((e) => e.event === 'verify_gate_critic_blocked');
    expect(invokedIdx).toBeGreaterThanOrEqual(0);
    expect(blockedIdx).toBeGreaterThan(invokedIdx);
  });

  it('VGI-19 reject + block OFF → tool runs (slice-3 observable contract intact when flag absent), no verify_gate_critic_blocked event', async () => {
    // Flag explicitly NOT set — beforeEach already deleted it.
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const { critic } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'old_string not present in file',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored).toBe('ok:coder.write-file');
    expect(stored).not.toMatch(/Tool call blocked/);

    // Slice 6 — the dedicated blocked event must NOT fire on the
    // observable-only path. Slice-3's invoked event still does.
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeDefined();
    expect(events.find((e) => e.event === 'verify_gate_critic_blocked')).toBeUndefined();
  });

  it('VGI-20 approve + block on → tool runs (only invoked reject triggers the block), no verify_gate_critic_blocked event', async () => {
    process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'] = '1';
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const { critic } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'approve',
      reason: 'invoked',
      rationale: 'edit looks reversible',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    const stored = String(session.messages[0]?.content ?? '');
    expect(stored).toBe('ok:coder.write-file');
    expect(stored).not.toMatch(/Tool call blocked/);

    // Slice 6 — the blocked event must NOT fire on an approve verdict
    // even when the block flag is on. Guards against a regression that
    // keys the event on the flag alone instead of (flag && reject).
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_blocked')).toBeUndefined();
  });

  it('VGI-21 reject + block on + feedback on → BLOCK wins, no slice-4 prefix on top, slice-6 event still fires', async () => {
    // Both flags on: precedence is BLOCK > FEEDBACK because the block
    // message itself already names the critic rejection. Prepending
    // [VERIFY-GATE CRITIC REJECT] on top would be doubly redundant.
    process.env['SUDO_VERIFY_GATE_CRITIC_BLOCK'] = '1';
    process.env['SUDO_VERIFY_GATE_CRITIC_FEEDBACK'] = '1';
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const { critic } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'old_string not present in file',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual([]);
    const stored = String(session.messages[0]?.content ?? '');
    // Block message present, but no slice-4 prefix anywhere.
    expect(stored.startsWith('[VerifyGate] Tool call blocked: coder.write-file — critic reject (')).toBe(true);
    expect(stored).not.toMatch(/VERIFY-GATE CRITIC REJECT/);

    // Slice 6 — the blocked event fires exactly once on the precedence
    // path. Guards against a regression that ties the event emission to
    // the feedback-flag branch rather than the block branch (verifier
    // MED-1 on slice 6).
    await drainMicrotasks();
    const blockedEvents = events.filter((e) => e.event === 'verify_gate_critic_blocked');
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      rationale: 'old_string not present in file',
      message: stored,
    });
  });
});
