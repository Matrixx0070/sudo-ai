/** Eval runner integration with a stubbed agent turn (no real LLMs). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEval, type TurnExecutor } from '../../../src/core/eval/sandbox/eval-runner.js';
import { readJournal } from '../../../src/core/eval/sandbox/run-journal.js';
import { BenchStore } from '../../../src/core/eval/bench-store.js';
import type { Scenario } from '../../../src/core/eval/sandbox/scenario.js';

let root: string;
let benchDb: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runner-'));
  benchDb = path.join(root, 'bench.db');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'stub-task',
    version: '1',
    title: 'stubbed',
    taskType: 'coding',
    prompt: 'write DONE to {workspace}/out.txt',
    fixtures: [{ path: 'seed.txt', content: 'seed-content' }],
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

/** Stub turn: writes the graded file and returns a final reply. */
const passingExecutor: TurnExecutor = async (args) => {
  fs.writeFileSync(path.join(args.workspaceDir, 'out.txt'), 'DONE');
  return { text: 'finished the task', steps: 3, usd: 0.01 };
};

describe('runEval', () => {
  it('passing run: fixtures written, journal complete, bench row persisted', async () => {
    const report = await runEval(scenario(), {
      executor: passingExecutor,
      evalRunsRoot: root,
      benchDbPath: benchDb,
    });

    expect(report.passed).toBe(true);
    expect(report.scores.checksPassed).toBe(3);
    expect(report.scores.efficiency.steps).toBe(3);

    // fixtures landed in the workspace
    expect(fs.readFileSync(path.join(report.workspaceDir, 'seed.txt'), 'utf-8')).toBe('seed-content');

    // prompt placeholder substituted
    const events = readJournal(report.journalPath);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['run.start', 'prompt', 'run.end', 'scores']);
    expect(String(events[1]!['text'])).toContain(report.workspaceDir);
    expect(String(events[1]!['text'])).not.toContain('{workspace}');

    // scores in bench.db under the eval-sandbox suite
    const store = new BenchStore(benchDb);
    try {
      const rows = store.listResults({ runId: report.runId });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.agentId).toBe('eval-sandbox');
      expect(rows[0]!.taskId).toBe('stub-task');
      expect(rows[0]!.success).toBe(true);
      expect(rows[0]!.verifierType).toBe('eval-sandbox');
    } finally {
      store.close();
    }

    // clean state: run data/ deleted, journal + workspace stay
    expect(fs.existsSync(path.join(path.dirname(report.journalPath), 'data'))).toBe(false);
    expect(fs.existsSync(report.journalPath)).toBe(true);
    expect(fs.existsSync(report.workspaceDir)).toBe(true);
  });

  it('failing checks → passed=false, bench row success=0', async () => {
    const report = await runEval(scenario(), {
      executor: async () => ({ text: 'gave up', steps: 1 }),
      evalRunsRoot: root,
      benchDbPath: benchDb,
    });
    expect(report.passed).toBe(false);
    expect(report.scores.checksPassed).toBe(0);
  });

  it('turn error → never a pass even if checks would pass', async () => {
    const report = await runEval(scenario(), {
      executor: async (args) => {
        fs.writeFileSync(path.join(args.workspaceDir, 'out.txt'), 'DONE');
        return { text: 'finished', steps: 1, error: 'child crashed' };
      },
      evalRunsRoot: root,
      benchDbPath: benchDb,
    });
    expect(report.passed).toBe(false);
    const end = readJournal(report.journalPath).find((e) => e.type === 'run.end')!;
    expect(end['ok']).toBe(false);
    expect(end['error']).toBe('child crashed');
  });

  it('keepData=true keeps the run data dir', async () => {
    const report = await runEval(scenario(), {
      executor: passingExecutor,
      evalRunsRoot: root,
      benchDbPath: benchDb,
      keepData: true,
    });
    expect(fs.existsSync(path.join(path.dirname(report.journalPath), 'data'))).toBe(true);
  });

  it('mockService scenario: URL injected into the prompt, server torn down', async () => {
    let seenUrl = '';
    const report = await runEval(
      scenario({
        prompt: 'fetch {mockServiceUrl} and finish',
        mockService: { failuresBeforeSuccess: 1, successBody: 'BODY-9' },
        grading: { checks: [{ type: 'outputContains', substring: 'BODY-9' }] },
      }),
      {
        executor: async (args) => {
          seenUrl = args.env['MOCK_SERVICE_URL'] ?? '';
          expect((await fetch(seenUrl)).status).toBe(500);
          const r = await fetch(seenUrl);
          return { text: `got ${await r.text()}`, steps: 2 };
        },
        evalRunsRoot: root,
        benchDbPath: benchDb,
      },
    );
    expect(report.passed).toBe(true);
    expect(seenUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    // prompt got the real URL
    const promptEv = readJournal(report.journalPath).find((e) => e.type === 'prompt')!;
    expect(String(promptEv['text'])).toContain(seenUrl);
    // server no longer reachable after the run
    await expect(fetch(seenUrl)).rejects.toThrow();
  });

  it('executor env is the scrubbed env (DATA_DIR = run-private)', async () => {
    let seenEnv: Record<string, string> = {};
    process.env['EVAL_RUNNER_SECRET_PROBE'] = 'leakme';
    try {
      const report = await runEval(scenario({ grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }), {
        executor: async (args) => { seenEnv = args.env; return { text: 'x', steps: 0 }; },
        evalRunsRoot: root,
        benchDbPath: benchDb,
      });
      expect(seenEnv['DATA_DIR']).toBe(path.join(path.dirname(report.journalPath), 'data'));
      expect(seenEnv['SUDO_EVAL']).toBe('1');
      expect(seenEnv['EVAL_RUNNER_SECRET_PROBE']).toBeUndefined();
      expect(seenEnv['SUDO_EVAL_MAX_STEPS']).toBe('5');
    } finally {
      delete process.env['EVAL_RUNNER_SECRET_PROBE'];
    }
  });
});

describe('runEval — Phase 2 (budgets, runsc, metering)', () => {
  it('plumbs budgets.maxUsd into SUDO_AGENT_RUN_MAX_USD in the child env', async () => {
    let seenEnv: Record<string, string> = {};
    await runEval(
      scenario({ budgets: { maxUsd: 0.25, maxSteps: 5, maxWallMs: 30_000 }, grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }),
      {
        executor: async (args) => { seenEnv = args.env; return { text: 'x', steps: 0 }; },
        evalRunsRoot: root,
        benchDbPath: benchDb,
      },
    );
    expect(seenEnv['SUDO_AGENT_RUN_MAX_USD']).toBe('0.25');
  });

  it('spendCapBreached → budget.exhausted journalled + never a pass', async () => {
    const report = await runEval(
      scenario({ grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }),
      {
        executor: async () => ({ text: 'x', steps: 2, usd: 0.11, spendCapBreached: true }),
        evalRunsRoot: root,
        benchDbPath: benchDb,
      },
    );
    expect(report.passed).toBe(false);
    const ev = readJournal(report.journalPath).find((e) => e.type === 'budget.exhausted')!;
    expect(ev['budget']).toBe('maxUsd');
    expect(ev['maxUsd']).toBe(0.1);
  });

  it('no breach → no budget.exhausted event', async () => {
    const report = await runEval(
      scenario({ grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }),
      {
        executor: async () => ({ text: 'x', steps: 1, usd: 0.01 }),
        evalRunsRoot: root,
        benchDbPath: benchDb,
      },
    );
    expect(report.passed).toBe(true);
    expect(readJournal(report.journalPath).some((e) => e.type === 'budget.exhausted')).toBe(false);
  });

  it('actual spend read from the run-local gateway.db llm_calls overrides turn.usd', async () => {
    const report = await runEval(
      scenario({ grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }),
      {
        executor: async (args) => {
          // simulate the child writing its own gateway.db under DATA_DIR
          const Database = (await import('better-sqlite3')).default;
          const db = new Database(path.join(args.dataDir, 'gateway.db'));
          db.exec('CREATE TABLE llm_calls (id INTEGER PRIMARY KEY, cost_usd REAL)');
          db.prepare('INSERT INTO llm_calls (cost_usd) VALUES (?), (?), (NULL)').run(0.03, 0.02);
          db.close();
          return { text: 'x', steps: 1, usd: 0.5 };
        },
        evalRunsRoot: root,
        benchDbPath: benchDb,
      },
    );
    expect(report.turn.usd).toBeCloseTo(0.05, 10);
    expect(report.scores.efficiency.usd).toBeCloseTo(0.05, 10);
  });

  it("isolation runsc: aborts fail-closed when the runtime is missing", async () => {
    await expect(
      runEval(scenario({ isolation: 'runsc' }), {
        executor: async () => { throw new Error('executor must never run'); },
        evalRunsRoot: root,
        benchDbPath: benchDb,
        runtimeProbe: async () => false,
      }),
    ).rejects.toThrow(/runsc.*unavailable|unavailable.*runsc/);
  });

  it('isolation runsc: available runtime → SUDO_SANDBOX_DOCKER_RUNTIME=runsc in child env', async () => {
    let seenEnv: Record<string, string> = {};
    await runEval(
      scenario({ isolation: 'runsc', grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }),
      {
        executor: async (args) => { seenEnv = args.env; return { text: 'x', steps: 0 }; },
        evalRunsRoot: root,
        benchDbPath: benchDb,
        runtimeProbe: async (rt) => rt === 'runsc',
      },
    );
    expect(seenEnv['SUDO_SANDBOX_DOCKER_RUNTIME']).toBe('runsc');
  });

  it('runc scenarios never set the runtime override and never probe', async () => {
    let probed = false;
    let seenEnv: Record<string, string> = {};
    await runEval(
      scenario({ isolation: 'runc', grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }),
      {
        executor: async (args) => { seenEnv = args.env; return { text: 'x', steps: 0 }; },
        evalRunsRoot: root,
        benchDbPath: benchDb,
        runtimeProbe: async () => { probed = true; return true; },
      },
    );
    expect(probed).toBe(false);
    expect(seenEnv['SUDO_SANDBOX_DOCKER_RUNTIME']).toBeUndefined();
  });

  it('turn resource metrics land in scores.efficiency', async () => {
    const report = await runEval(
      scenario({ grading: { checks: [{ type: 'outputContains', substring: 'x' }] } }),
      {
        executor: async () => ({ text: 'x', steps: 1, peakRssMb: 42.5, cpuSecs: 1.2 }),
        evalRunsRoot: root,
        benchDbPath: benchDb,
      },
    );
    expect(report.scores.efficiency.peakRssMb).toBe(42.5);
    expect(report.scores.efficiency.cpuSecs).toBe(1.2);
  });
});
