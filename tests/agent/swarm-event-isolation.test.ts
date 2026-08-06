/**
 * @file tests/agent/swarm-event-isolation.test.ts
 * @description Pins the invariant the TUI model-header fix depends on.
 *
 * The header names the model that actually answered, sourced from
 * trace-meta{activeModel} which AgentLoop._innerLoop emits per Brain call.
 * Sub-agents run _innerLoop too — so if a sub-agent's events reached the
 * parent's handler, the header would flip to a sub-agent's (often cheap-tier)
 * model instead of the one that authored the user's reply.
 *
 * They cannot, for one reason: AgentSwarm builds its OWN AgentLoop and calls
 * run() with `undefined` for onEvent, and emit() is optional-chained
 * (loop.ts: `onEvent?.(event)`). That is a load-bearing detail with nothing
 * else pinning it — passing the parent's handler through would look like a
 * feature ("surface sub-agent progress") and silently corrupt the header.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const swarmSrc = readFileSync(join(process.cwd(), 'src/core/agent/swarm.ts'), 'utf8');
const loopSrc = readFileSync(join(process.cwd(), 'src/core/agent/loop.ts'), 'utf8');

describe('sub-agent events never reach the parent handler', () => {
  it('every AgentSwarm loop.run() passes undefined for onEvent', () => {
    // Strip comments first: the file discusses "loop.run()" in prose, and a
    // naive match picks that up and fails on English rather than on code.
    const code = swarmSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const calls = (code.match(/loop\.run\([^)]*\)/g) ?? []).filter((c) => c !== 'loop.run()');
    expect(calls.length, 'expected AgentSwarm to run sub-agent loops').toBeGreaterThan(0);
    for (const call of calls) {
      // signature: run(sessionId, message, onEvent, opts?)
      const args = call.slice(call.indexOf('(') + 1, -1).split(',').map((s) => s.trim());
      expect(args[2], `sub-agent run must not forward an event handler: ${call}`).toBe('undefined');
    }
  });

  it('emit() is optional-chained, so a loop without onEvent is a no-op', () => {
    expect(loopSrc).toMatch(/onEvent\?\.\(event\)/);
  });

  it('the detector would catch a forwarded handler, and ignores prose', () => {
    const planted = 'loop.run(sessionId, taskDescription, onEvent, { promptProfile: "subagent" })';
    const args = planted.slice(planted.indexOf('(') + 1, -1).split(',').map((s) => s.trim());
    expect(args[2]).not.toBe('undefined'); // the assertion above would fail

    // Regression on the test itself: a comment mentioning loop.run() must not
    // be scanned as a call site. That false positive is what this test's first
    // draft tripped on.
    const withProse = '// does not stop loop.run() here\nloop.run(a, b, undefined, {})';
    const code = withProse.replace(/\/\/[^\n]*/g, '');
    const calls = (code.match(/loop\.run\([^)]*\)/g) ?? []).filter((c) => c !== 'loop.run()');
    expect(calls).toHaveLength(1);
  });
});
