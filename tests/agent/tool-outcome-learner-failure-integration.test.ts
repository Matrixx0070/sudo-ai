/**
 * @file tests/agent/tool-outcome-learner-failure-integration.test.ts
 * @description Integration of ToolOutcomeLearner with the REAL failure-learner
 * module — the exact wiring SUDO_TOOL_OUTCOME_LEARNER=1 enables in cli.ts
 * (the module namespace is passed as the FailureLearnerLike dep). Also covers
 * the hot-path guard: a throwing getPreventionRule must not escape
 * onToolResult.
 *
 * The failure-learner module resolves MIND_DB from paths.ts at load time, so
 * it is freshly imported AFTER pointing SUDO_AI_HOME at a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolOutcomeLearner,
  type FailureLearnerLike,
} from '../../src/core/agent/tool-outcome-learner.js';

type FailureLearnerModule = typeof import('../../src/core/learning/failure-learner.js');

let dir: string;
let savedHome: string | undefined;
let savedKill: string | undefined;
let savedDbFlag: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tol-fl-integration-'));
  savedHome = process.env['SUDO_AI_HOME'];
  savedKill = process.env['SUDO_TOOL_LEARNING_DISABLE'];
  savedDbFlag = process.env['SUDO_FAILURE_LEARNER_DB'];
  process.env['SUDO_AI_HOME'] = dir;
  delete process.env['SUDO_TOOL_LEARNING_DISABLE'];
  delete process.env['SUDO_FAILURE_LEARNER_DB'];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SUDO_AI_HOME'];
  else process.env['SUDO_AI_HOME'] = savedHome;
  if (savedKill === undefined) delete process.env['SUDO_TOOL_LEARNING_DISABLE'];
  else process.env['SUDO_TOOL_LEARNING_DISABLE'] = savedKill;
  if (savedDbFlag === undefined) delete process.env['SUDO_FAILURE_LEARNER_DB'];
  else process.env['SUDO_FAILURE_LEARNER_DB'] = savedDbFlag;
  rmSync(dir, { recursive: true, force: true });
});

async function freshFailureLearner(): Promise<FailureLearnerModule> {
  vi.resetModules();
  return await import('../../src/core/learning/failure-learner.js');
}

describe('ToolOutcomeLearner + real failure-learner module (cli.ts wiring shape)', () => {
  it('INT-1: the module namespace satisfies FailureLearnerLike', async () => {
    const fl = await freshFailureLearner();
    // Compile-time check: assignment fails to typecheck if the API drifts.
    const like: FailureLearnerLike = fl;
    expect(typeof like.recordFailure).toBe('function');
    expect(typeof like.getPreventionRule).toBe('function');
    expect(typeof like.hasSeenBefore).toBe('function');
    expect(typeof like.getSolution).toBe('function');
  });

  it('INT-2: failed tool calls are recorded into the FailureLearner', async () => {
    const fl = await freshFailureLearner();
    const learner = new ToolOutcomeLearner({ failureLearner: fl });

    learner.onToolResult('web.fetch', { url: 'x' }, false, 'ETIMEDOUT connecting to host', 's-1');

    expect(fl.hasSeenBefore('web.fetch', 'ETIMEDOUT connecting to host')).toBe(true);
    expect(fl.getFailureStats()).toEqual({ 'web.fetch': 1 });
  });

  it('INT-3: a recorded solution surfaces as a prevention hint on the next failure', async () => {
    const fl = await freshFailureLearner();
    const learner = new ToolOutcomeLearner({ failureLearner: fl });

    const rec = fl.recordFailure('web.fetch', 'ETIMEDOUT connecting to host', 'ctx');
    fl.recordSolution(rec.id, 'increase timeout to 30s', 'always set timeout >= 30s');

    const hint = learner.checkPreventionRulesForError('web.fetch', 'ETIMEDOUT connecting to host');
    expect(hint).toContain('always set timeout >= 30s');
  });

  it('INT-4: successful calls record nothing', async () => {
    const fl = await freshFailureLearner();
    const learner = new ToolOutcomeLearner({ failureLearner: fl });

    learner.onToolResult('web.fetch', { url: 'x' }, true, undefined, 's-1');

    expect(fl.getFailureStats()).toEqual({});
  });

  it('INT-5: SUDO_TOOL_LEARNING_DISABLE=1 kill-switch still wins over activation', async () => {
    process.env['SUDO_TOOL_LEARNING_DISABLE'] = '1';
    const fl = await freshFailureLearner();
    const learner = new ToolOutcomeLearner({ failureLearner: fl });

    learner.onToolResult('web.fetch', { url: 'x' }, false, 'ETIMEDOUT', 's-1');

    expect(fl.getFailureStats()).toEqual({});
  });

  it('INT-6: a throwing getPreventionRule does not escape onToolResult (hot-path guard)', () => {
    const throwing: FailureLearnerLike = {
      recordFailure: () => ({}),
      getPreventionRule: () => { throw new Error('db gone'); },
      hasSeenBefore: () => false,
      getSolution: () => undefined,
    };
    const learner = new ToolOutcomeLearner({ failureLearner: throwing });

    expect(() =>
      learner.onToolResult('web.fetch', {}, false, 'ETIMEDOUT', 's-1'),
    ).not.toThrow();
  });
});
