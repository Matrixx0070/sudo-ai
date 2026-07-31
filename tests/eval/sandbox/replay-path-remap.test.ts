import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateEvalGate,
  deactivateEvalGate,
  evalGateBeforeTool,
  remapStringsDeep,
} from '../../../src/core/eval/sandbox/eval-gate.js';
import { RunJournal } from '../../../src/core/eval/sandbox/run-journal.js';
import { runEval } from '../../../src/core/eval/sandbox/eval-runner.js';
import type { Scenario } from '../../../src/core/eval/sandbox/scenario.js';

const FROM = '/orig/run/workspace';
const TO = '/replay/run/workspace';

describe('remapStringsDeep', () => {
  it('replaces all occurrences in nested objects and arrays', () => {
    const input = {
      path: `${FROM}/a.ts`,
      cmd: `cat ${FROM}/a.ts && ls ${FROM}`,
      nested: { list: [`${FROM}/b`, 42, null, { deep: `${FROM}/c` }] },
      untouched: 7,
    };
    const r = remapStringsDeep(input, FROM, TO);
    expect(r.count).toBe(5);
    const v = r.value as typeof input;
    expect(v.path).toBe(`${TO}/a.ts`);
    expect(v.cmd).toBe(`cat ${TO}/a.ts && ls ${TO}`);
    expect(v.nested.list[0]).toBe(`${TO}/b`);
    expect((v.nested.list[3] as { deep: string }).deep).toBe(`${TO}/c`);
    expect(v.untouched).toBe(7);
  });

  it('remaps ledger-REDACTED run ids via the tolerant shape pass', () => {
    const redacted = '/orig/run-[REDACTED]/workspace';
    const r = remapStringsDeep(
      { cmd: `node ${redacted}/add.js`, path: `${redacted}/add.js` },
      '/orig/run-1785500675017-abc/workspace',
      TO,
    );
    expect(r.count).toBe(2);
    expect((r.value as { path: string }).path).toBe(`${TO}/add.js`);
  });

  it('is inert on no match and on empty from', () => {
    expect(remapStringsDeep({ a: '/other/path' }, FROM, TO).count).toBe(0);
    expect(remapStringsDeep({ a: FROM }, '', TO).count).toBe(0);
  });
});

describe('evalGateBeforeTool path remap', () => {
  let dir: string;
  const prevEval = process.env['SUDO_EVAL'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-remap-'));
    process.env['SUDO_EVAL'] = '1';
  });
  afterEach(() => {
    deactivateEvalGate();
    if (prevEval === undefined) delete process.env['SUDO_EVAL'];
    else process.env['SUDO_EVAL'] = prevEval;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns transformed params when a remap is active and matches', async () => {
    activateEvalGate({
      runId: 't',
      policy: {},
      journal: new RunJournal(join(dir, 'journal.jsonl')),
      pathRemap: { from: FROM, to: TO },
    });
    const d = await evalGateBeforeTool('fs.write', { path: `${FROM}/x.txt`, content: 'hi' });
    expect(d.action).toBe('allow');
    expect(d.action === 'allow' && d.params).toEqual({ path: `${TO}/x.txt`, content: 'hi' });
  });

  it('returns no params when the remap does not match or is unset', async () => {
    activateEvalGate({
      runId: 't',
      policy: {},
      journal: new RunJournal(join(dir, 'journal.jsonl')),
      pathRemap: { from: FROM, to: TO },
    });
    const noMatch = await evalGateBeforeTool('fs.write', { path: '/elsewhere' });
    expect(noMatch.action === 'allow' && noMatch.params).toBeUndefined();

    deactivateEvalGate();
    activateEvalGate({ runId: 't', policy: {}, journal: new RunJournal(join(dir, 'j2.jsonl')) });
    const unset = await evalGateBeforeTool('fs.write', { path: `${FROM}/x` });
    expect(unset.action === 'allow' && unset.params).toBeUndefined();
  });
});

describe('runEval replayPathFrom env plumbing', () => {
  it('exports SUDO_EVAL_REPLAY_PATH_FROM/_TO to the child env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-remap-run-'));
    let seenEnv: Record<string, string> = {};
    const scenario: Scenario = {
      id: 'remap-plumbing',
      version: '1',
      title: 't',
      taskType: 'coding',
      prompt: 'p',
      grading: { checks: [{ type: 'outputContains', substring: 'ok' }] },
      budgets: { maxUsd: 0.01, maxSteps: 1, maxWallMs: 1000 },
    } as Scenario;
    const report = await runEval(scenario, {
      evalRunsRoot: root,
      benchDbPath: join(root, 'bench.db'),
      replayPathFrom: FROM,
      executor: async (args) => {
        seenEnv = args.env;
        return { text: 'ok', steps: 1 };
      },
    });
    expect(report.passed).toBe(true);
    expect(seenEnv['SUDO_EVAL_REPLAY_PATH_FROM']).toBe(FROM);
    expect(seenEnv['SUDO_EVAL_REPLAY_PATH_TO']).toBe(report.workspaceDir);
    rmSync(root, { recursive: true, force: true });
  });
});
