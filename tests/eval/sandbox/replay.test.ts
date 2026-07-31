/**
 * ADR-0007 Phase 3 — replay substrate:
 *  - replay.db preservation (runner copies the child's gateway.db pre-teardown)
 *  - L2 re-grade from journal + persisted workspace (no agent, no LLM)
 *  - L1 transport interceptor: recorded responses served in order, divergence
 *    is a hard fail, and the seam is provably inert when unset.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runEval, type TurnExecutor } from '../../../src/core/eval/sandbox/eval-runner.js';
import {
  installReplayInterceptor,
  loadRecordedResponses,
  replayL2,
} from '../../../src/core/eval/sandbox/replay.js';
import { setIRInterceptor } from '../../../src/llm/ir-interceptor.js';
import { callIR } from '../../../src/llm/transport.js';
import { __resetPolicyState } from '../../../src/llm/policy.js';
import type { Scenario } from '../../../src/core/eval/sandbox/scenario.js';
import type { IRRequest, IRResponse } from '../../../shared-types/ir/v1.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-replay-'));
  __resetPolicyState();
});
afterEach(() => {
  setIRInterceptor(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'replay-task',
    version: '1',
    title: 'replay fixture',
    taskType: 'coding',
    prompt: 'write DONE to {workspace}/out.txt',
    grading: {
      checks: [
        { type: 'fileExists', path: 'out.txt' },
        { type: 'fileContains', path: 'out.txt', substring: 'DONE' },
        { type: 'outputContains', substring: 'finished' },
      ],
    },
    budgets: { maxUsd: 0.1, maxSteps: 5, maxWallMs: 30_000 },
    ...over,
  };
}

function irResponse(text: string): IRResponse {
  return {
    blocks: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { in: 10, out: 5, cached_in: 0 },
    trace_id: 't',
  };
}

/** Minimal llm_calls ledger a child would have written under its DATA_DIR. */
function writeLedger(
  dbPath: string,
  rows: Array<{ caller: string; alias: string; res: IRResponse }>,
  route = 'stub:route',
): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE llm_calls (trace_id TEXT PRIMARY KEY, ts TEXT, caller TEXT, alias TEXT, route TEXT, ir_response TEXT)`);
  const ins = db.prepare(`INSERT INTO llm_calls (trace_id, ts, caller, alias, route, ir_response) VALUES (?, ?, ?, ?, ?, ?)`);
  rows.forEach((r, i) => ins.run(`tr-${i}`, new Date().toISOString(), r.caller, r.alias, route, JSON.stringify(r.res)));
  db.close();
}

const passingExecutor: TurnExecutor = async (args) => {
  fs.writeFileSync(path.join(args.workspaceDir, 'out.txt'), 'DONE');
  // Simulate the child's gateway.db ledger so the runner has something to preserve.
  writeLedger(path.join(args.dataDir, 'gateway.db'), [
    { caller: 'agent-loop', alias: 'sudo/frontier', res: irResponse('recorded-1') },
  ]);
  return { text: 'finished the task', steps: 2, usd: 0.01 };
};

async function makeRun(over: Partial<Scenario> = {}): Promise<string> {
  const report = await runEval(scenario(over), {
    executor: passingExecutor,
    evalRunsRoot: root,
    benchDbPath: path.join(root, 'bench.db'),
    // Never a live judge call from a test fixture.
    judge: { callJudge: async () => ({ text: '{"score": 10}', usage: { in: 1, out: 1 } }) },
  });
  return path.dirname(report.journalPath);
}

describe('replay.db preservation', () => {
  it('copies the child gateway.db to <runDir>/replay.db before teardown', async () => {
    const runDir = await makeRun();
    const replayDb = path.join(runDir, 'replay.db');
    expect(fs.existsSync(replayDb)).toBe(true);
    // data/ teardown happened, but the ledger survived in the copy.
    expect(fs.existsSync(path.join(runDir, 'data'))).toBe(false);
    const queues = loadRecordedResponses(replayDb);
    expect(queues.get('agent-loop|sudo/frontier')).toHaveLength(1);
  });
});

describe('replayL2 (re-grade from journal)', () => {
  it('re-grades to the same scores from journal + persisted workspace', async () => {
    const runDir = await makeRun();
    const r = await replayL2(runDir);
    expect(r.scenarioId).toBe('replay-task');
    expect(r.workspaceMissing).toBe(false);
    expect(r.scores.success).toBe(true);
    expect(r.scores.checksPassed).toBe(3);
    expect(r.scores.checksTotal).toBe(3);
    expect(r.oldScores?.checksPassed).toBe(3);
  });

  it('a modified grader (scenario override) yields new scores against the same history', async () => {
    const runDir = await makeRun();
    const modified = scenario({
      grading: { checks: [{ type: 'outputContains', substring: 'THIS-WAS-NEVER-SAID' }] },
    });
    const overridePath = path.join(root, 'modified.json');
    fs.writeFileSync(overridePath, JSON.stringify(modified));
    const r = await replayL2(runDir, { scenarioPath: overridePath });
    expect(r.scores.success).toBe(false);
    expect(r.scores.checksPassed).toBe(0);
    expect(r.oldScores?.checksPassed).toBe(3); // history unchanged
  });

  it('missing workspace: file-based checks are SKIPPED, not failed', async () => {
    const runDir = await makeRun();
    fs.rmSync(path.join(runDir, 'workspace'), { recursive: true, force: true });
    const r = await replayL2(runDir);
    expect(r.workspaceMissing).toBe(true);
    const skippedTypes = r.skipped.map((o) => o.check.type).sort();
    expect(skippedTypes).toEqual(['fileContains', 'fileExists']);
    for (const o of r.skipped) {
      expect(o.skipped).toBe(true);
      expect(o.detail).toContain('workspace missing');
    }
    // outputContains still graded from the journal, and skips never fail the run.
    expect(r.scores.success).toBe(true);
    expect(r.scores.checksPassed).toBe(1);
    expect(r.scores.checksTotal).toBe(3);
  });

  it('judge checks are skipped in L2 (no LLM calls, ever)', async () => {
    const runDir = await makeRun({
      grading: {
        checks: [
          { type: 'outputContains', substring: 'finished' },
          { type: 'judge', rubric: 'is it good?', minScore: 5 },
        ],
      },
      // The original run would HOLD the judge (no routes recorded → judge runs
      // but we stub nothing) — grade only the code check for the fixture.
    });
    const r = await replayL2(runDir);
    const judgeOutcome = r.skipped.find((o) => o.check.type === 'judge');
    expect(judgeOutcome?.skipped).toBe(true);
    expect(judgeOutcome?.detail).toContain('judge checks are not re-run');
  });
});

describe('runEval judge integration', () => {
  it('HOLDs the judge check when the judge provider served the turn (replay.db ground truth)', async () => {
    const exec: TurnExecutor = async (args) => {
      writeLedger(
        path.join(args.dataDir, 'gateway.db'),
        [{ caller: 'agent-loop', alias: 'sudo/frontier', res: irResponse('served by oauth') }],
        'claude-oauth:messages', // same provider as the default judge route
      );
      return { text: 'finished the task', steps: 1 };
    };
    let judgeCalled = 0;
    const report = await runEval(
      scenario({ grading: { checks: [{ type: 'judge', rubric: 'good?', minScore: 1 }] } }),
      {
        executor: exec,
        evalRunsRoot: root,
        benchDbPath: path.join(root, 'bench.db'),
        judge: { callJudge: async () => { judgeCalled += 1; return { text: '{"score": 10}', usage: { in: 1, out: 1 } }; } },
      },
    );
    expect(judgeCalled).toBe(0);
    expect(report.passed).toBe(false);
    expect(report.scores.holdReason).toBe('judge-hold: no independent route');
    const judgeOutcome = report.scores.checkOutcomes.find((o) => o.check.type === 'judge');
    expect(judgeOutcome?.held).toBe(true);
  });

  it('grades the judge check normally when the turn was served by an independent route', async () => {
    const report = await runEval(
      scenario({
        grading: {
          checks: [
            { type: 'outputContains', substring: 'finished' },
            { type: 'judge', rubric: 'good?', minScore: 5 },
          ],
        },
      }),
      {
        executor: passingExecutor, // ledger route 'stub:route' — independent
        evalRunsRoot: root,
        benchDbPath: path.join(root, 'bench.db'),
        judge: { callJudge: async () => ({ text: '{"score": 8}', usage: { in: 1, out: 1 } }) },
      },
    );
    expect(report.passed).toBe(true);
    expect(report.scores.checksPassed).toBe(2);
    expect(report.scores.checksTotal).toBe(2);
    expect(report.scores.holdReason).toBeUndefined();
  });
});

describe('L1 IR interceptor', () => {
  const ir = (caller: string, alias: string): IRRequest => ({
    alias,
    caller,
    purpose: 'test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    priority: 'user',
    trace_id: 'trace-1',
  });

  /** fetch spy that must never be reached under an interceptor. */
  function moneyFetch(): { impl: typeof fetch; calls: () => number } {
    let n = 0;
    const impl = (async () => {
      n += 1;
      throw new Error('LIVE CALL ATTEMPTED — replay must never reach the wire');
    }) as unknown as typeof fetch;
    return { impl, calls: () => n };
  }

  it('serves recorded responses in order per (caller|alias), never touching fetch', async () => {
    const dbPath = path.join(root, 'replay.db');
    writeLedger(dbPath, [
      { caller: 'agent-loop', alias: 'sudo/frontier', res: irResponse('first') },
      { caller: 'agent-loop', alias: 'sudo/frontier', res: irResponse('second') },
    ]);
    installReplayInterceptor(dbPath);
    const spy = moneyFetch();

    const r1 = await callIR(ir('agent-loop', 'sudo/frontier'), { fetchImpl: spy.impl });
    const r2 = await callIR(ir('agent-loop', 'sudo/frontier'), { fetchImpl: spy.impl });
    expect((r1.blocks[0] as { text: string }).text).toBe('first');
    expect((r2.blocks[0] as { text: string }).text).toBe('second');
    expect(spy.calls()).toBe(0);
  });

  it('exhaustion / unrecorded key is a hard divergence failure, never a live call', async () => {
    const dbPath = path.join(root, 'replay.db');
    writeLedger(dbPath, [{ caller: 'agent-loop', alias: 'sudo/frontier', res: irResponse('only') }]);
    installReplayInterceptor(dbPath);
    const spy = moneyFetch();

    await callIR(ir('agent-loop', 'sudo/frontier'), { fetchImpl: spy.impl });
    await expect(callIR(ir('agent-loop', 'sudo/frontier'), { fetchImpl: spy.impl }))
      .rejects.toThrow(/replay divergence/);
    await expect(callIR(ir('other-caller', 'sudo/frontier'), { fetchImpl: spy.impl }))
      .rejects.toThrow(/replay divergence/);
    expect(spy.calls()).toBe(0);
  });

  it('unset interceptor: callIR behaves exactly as before (wire path taken)', async () => {
    setIRInterceptor(null);
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return new Response(
        JSON.stringify({
          id: 'x', choices: [{ message: { role: 'assistant', content: 'live-path' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    // ollama is keyless — no auth env needed for the wire-path proof.
    const res = await callIR(ir('agent-loop', 'ollama/test-model'), { fetchImpl });
    expect(fetched).toBe(1);
    expect((res.blocks[0] as { text: string }).text).toBe('live-path');
  });
});
