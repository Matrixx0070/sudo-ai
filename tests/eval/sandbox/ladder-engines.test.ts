import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gradeRung0, gradeRung1, gradeRung2, extractNumber } from '../../../src/core/eval/sandbox/ladder-graders.js';
import {
  RUNG_THRESHOLDS,
  cacheVerdict,
  loadGoldenSet,
  readCachedVerdict,
  runLadderRung,
  type GoldenItem,
  type LadderCallResult,
} from '../../../src/core/eval/sandbox/ladder.js';

const okText = (text: string): LadderCallResult => ({
  blocks: [{ type: 'text', text }],
  usage: { in: 1, out: 1 },
  stopReason: 'end_turn',
});

const okTool = (name: string, input: Record<string, unknown>): LadderCallResult => ({
  blocks: [{ type: 'tool_use', id: 't1', name, input }],
  usage: { in: 1, out: 1 },
  stopReason: 'tool_use',
});

describe('rung-0 grader', () => {
  it('grades each expect kind', () => {
    expect(gradeRung0({ nonEmpty: true }, 'hi').passed).toBe(true);
    expect(gradeRung0({ nonEmpty: true }, '   ').passed).toBe(false);
    expect(gradeRung0({ outputContains: 'pong' }, 'PONG!').passed).toBe(true);
    expect(gradeRung0({ outputContains: 'pong' }, 'nope').passed).toBe(false);
    expect(gradeRung0({ outputMatches: '\\b4\\b' }, 'it is 4').passed).toBe(true);
    expect(gradeRung0({ outputMatches: '\\b4\\b' }, 'it is five').passed).toBe(false);
    expect(gradeRung0({ jsonParses: true }, '{"status":"ok"}').passed).toBe(true);
    expect(gradeRung0({ jsonParses: true }, '```json\n{"a":1}\n```').passed).toBe(true);
    expect(gradeRung0({ jsonParses: true }, 'not json').passed).toBe(false);
  });

  it('FAILS an unknown expect key rather than silently passing', () => {
    const r = gradeRung0({ someNewCheck: true }, 'anything');
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('unknown rung-0 expect key');
  });
});

describe('rung-1 grader', () => {
  it('passes a well-formed call and tolerates provider name-mangling', () => {
    expect(gradeRung1({ toolCalled: 'echo_marker', paramsInclude: { text: 'X' } }, okTool('echo_marker', { text: 'X' }).blocks).passed).toBe(true);
    // Grok mangles dots to underscores — must still match.
    expect(gradeRung1({ toolCalled: 'system.exec' }, okTool('system_exec', { a: 1 }).blocks).passed).toBe(true);
  });

  it('fails on no tool call, wrong name, missing param, wrong type', () => {
    expect(gradeRung1({ toolCalled: 'x' }, okText('prose instead').blocks).passed).toBe(false);
    expect(gradeRung1({ toolCalled: 'create_note' }, okTool('other_tool', {}).blocks).passed).toBe(false);
    const missing = gradeRung1({ toolCalled: 'create_note', paramsInclude: { title: 'L' } }, okTool('create_note', {}).blocks);
    expect(missing.passed).toBe(false);
    expect(missing.detail).toContain('missing required param');
    const wrongType = gradeRung1({ toolCalled: 'set_timeout_ms', paramTypes: { ms: 'number' } }, okTool('set_timeout_ms', { ms: '1500' }).blocks);
    expect(wrongType.passed).toBe(false);
    expect(wrongType.detail).toContain('expected number');
  });
});

describe('golden sets', () => {
  it('loads rung-0 (bare array, implied v1) and rung-1 (versioned + tools)', () => {
    const r0 = loadGoldenSet(0);
    expect(r0.items.length).toBeGreaterThanOrEqual(5);
    expect(r0.version).toBe('1');
    const r1 = loadGoldenSet(1);
    expect(r1.version).toBe('2');
    expect(r1.items.every((i) => Array.isArray(i.tools) && i.tools.length > 0)).toBe(true);
  });
});

describe('runLadderRung admission', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ladder-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const cacheDbPath = (): string => join(dir, 'gateway.db');

  it('refuses admission on a thin sample even at 100%', async () => {
    const rep = await runLadderRung(0, 'test/route', {
      repeats: 1,
      cacheDbPath: cacheDbPath(),
      callRoute: async (_r, item: GoldenItem) =>
        okText(item.id === 'r0-json-object' ? '{"status":"ok"}' : 'pong SUDO-LADDER-R0 4'),
    });
    expect(rep.passRate).toBe(1);
    expect(rep.admitted).toBe(false);
    expect(rep.reason).toContain('insufficientSample');
    expect(rep.minN).toBe(RUNG_THRESHOLDS[0]!.minN);
  });

  it('admits at/above threshold once the sample is large enough', async () => {
    const rep = await runLadderRung(0, 'test/route', {
      repeats: 10, // 5 items x 10 = 50 = ADR minN for rung 0
      cacheDbPath: cacheDbPath(),
      callRoute: async (_r, item: GoldenItem) =>
        okText(item.id === 'r0-json-object' ? '{"status":"ok"}' : 'pong SUDO-LADDER-R0 4'),
    });
    expect(rep.n).toBe(50);
    expect(rep.admitted).toBe(true);
  });

  it('refuses admission below the pass-rate threshold', async () => {
    let calls = 0;
    const rep = await runLadderRung(0, 'test/route', {
      repeats: 10,
      cacheDbPath: cacheDbPath(),
      callRoute: async (_r, item: GoldenItem) => {
        calls += 1;
        if (calls === 3) return okText(''); // one empty reply = the #751 class
        return okText(item.id === 'r0-json-object' ? '{"status":"ok"}' : 'pong SUDO-LADDER-R0 4');
      },
    });
    expect(rep.admitted).toBe(false);
    expect(rep.failed).toBeGreaterThan(0);
    expect(rep.reason).toContain('passRate');
  });

  it('counts a throwing route as failed items, never a crashed run', async () => {
    const rep = await runLadderRung(0, 'test/route', {
      repeats: 1,
      cacheDbPath: cacheDbPath(),
      callRoute: async () => { throw new Error('route unreachable'); },
    });
    expect(rep.passed).toBe(0);
    expect(rep.admitted).toBe(false);
    expect(rep.results[0]!.detail).toContain('call failed');
  });

  it('halts gracefully on budget exhaustion', async () => {
    const prev = process.env['SUDO_EVAL_LADDER_MAX_USD'];
    process.env['SUDO_EVAL_LADDER_MAX_USD'] = '0';
    try {
      const rep = await runLadderRung(0, 'test/route', {
        repeats: 10,
        cacheDbPath: cacheDbPath(),
        callRoute: async () => okText('pong'),
      });
      expect(rep.haltedOnBudget).toBe(true);
      expect(rep.admitted).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['SUDO_EVAL_LADDER_MAX_USD'];
      else process.env['SUDO_EVAL_LADDER_MAX_USD'] = prev;
    }
  });

  it('returns notImplemented for rungs 3-5 instead of faking a verdict', async () => {
    for (const rung of [3, 4, 5]) {
      const rep = await runLadderRung(rung, 'test/route', { cacheDbPath: cacheDbPath() });
      expect(rep.notImplemented).toBe(true);
      expect(rep.admitted).toBe(false);
    }
  });

  it('caches and reads back a verdict keyed by rung + golden set version', async () => {
    const db = cacheDbPath();
    const rep = await runLadderRung(0, 'cache/route', {
      repeats: 1,
      cacheDbPath: db,
      callRoute: async (_r, item: GoldenItem) =>
        okText(item.id === 'r0-json-object' ? '{"status":"ok"}' : 'pong SUDO-LADDER-R0 4'),
    });
    const cached = readCachedVerdict('cache/route', 0, rep.goldenSetVersion, db);
    expect(cached).not.toBeNull();
    expect(cached!.passRate).toBe(rep.passRate);
    expect(readCachedVerdict('cache/route', 0, 'different-version', db)).toBeNull();
  });

  it('cacheVerdict never throws on an unusable db path', () => {
    expect(() =>
      cacheVerdict(
        { rung: 0, route: 'r', goldenSetVersion: '1', n: 1, passed: 1, failed: 0, passRate: 1,
          threshold: 1, minN: 50, admitted: false, spentUsd: 0, results: [] },
        '/nonexistent-dir-xyz/gateway.db',
      ),
    ).not.toThrow();
  });
});

describe('rung-2 grader (math / numeric)', () => {
  it('extracts numbers from the shapes models actually emit', () => {
    expect(extractNumber('42')).toBe(42);
    expect(extractNumber('The answer is 42.')).toBe(42);
    expect(extractNumber('$1,234.50')).toBe(1234.5);
    expect(extractNumber('-73')).toBe(-73);
    expect(extractNumber('**0.875**')).toBe(0.875);
    // Shows work → take the LAST standalone number (the result).
    expect(extractNumber('17 * 23 = 391, minus 91 gives 300')).toBe(300);
    expect(extractNumber('no digits here')).toBeNull();
  });

  it('grades exact and tolerance comparisons', () => {
    expect(gradeRung2({ answer: 300, tolerance: 0 }, '300').passed).toBe(true);
    expect(gradeRung2({ answer: 300, tolerance: 0 }, '301').passed).toBe(false);
    expect(gradeRung2({ answer: 1.4142, tolerance: 0.0002 }, '1.41421356').passed).toBe(true);
    expect(gradeRung2({ answer: 1.4142, tolerance: 0.0002 }, '1.4200').passed).toBe(false);
    expect(gradeRung2({ answer: -73, tolerance: 0 }, 'The result is -73').passed).toBe(true);
  });

  it('fails on a missing number and on unknown expect keys', () => {
    expect(gradeRung2({ answer: 1 }, 'I cannot compute that').passed).toBe(false);
    const unknown = gradeRung2({ answer: 1, somethingElse: true }, '1');
    expect(unknown.passed).toBe(false);
    expect(unknown.detail).toContain('unknown rung-2 expect key');
  });

  it('runs rung 2 end-to-end with a stubbed route and gates on minN', async () => {
    const rep = await runLadderRung(2, 'test/route', {
      repeats: 1,
      noCache: true,
      callRoute: async (_r, item) => okText(String((item.expect as { answer: number }).answer)),
    });
    expect(rep.n).toBe(8);
    expect(rep.passRate).toBe(1);
    expect(rep.admitted).toBe(false); // n=8 < ADR minN 30
    expect(rep.reason).toContain('insufficientSample');
  });
});
