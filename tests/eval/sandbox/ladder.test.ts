/** ADR-0002 ladder golden-set loader + runLadderRung stub (ADR-0007 Phase 4). */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadGoldenSet, goldenSetPath, runLadderRung } from '../../../src/core/eval/sandbox/ladder.js';
import { PROJECT_ROOT } from '../../../src/core/shared/paths.js';

describe('golden-set loader', () => {
  it('loads the 5 rung-0 items', () => {
    const items = loadGoldenSet(0);
    expect(items).toHaveLength(5);
    for (const it of items) {
      expect(it.id).toMatch(/^r0-/);
      expect(it.input.length).toBeGreaterThan(0);
      expect(Object.keys(it.expect).length).toBeGreaterThan(0);
    }
  });

  it('loads the 5 rung-1 items (tool-schema shapes)', () => {
    const items = loadGoldenSet(1);
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.id.startsWith('r1-'))).toBe(true);
    expect(items.every((i) => typeof i.expect['toolCalled'] === 'string')).toBe(true);
  });

  it('throws on a missing rung', () => {
    expect(() => loadGoldenSet(9)).toThrow(/no golden set for rung 9/);
  });

  it('resolves paths under evals/ladder/', () => {
    expect(goldenSetPath(0)).toBe(path.join(PROJECT_ROOT, 'evals', 'ladder', 'rung-0', 'golden.json'));
  });
});

describe('golden-set loader rejects malformed sets', () => {
  const dir = path.join(PROJECT_ROOT, 'evals', 'ladder', 'rung-8');
  const file = path.join(dir, 'golden.json');
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeSet(content: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content);
  }

  it.each([
    ['not JSON', 'nope{', /not valid JSON/],
    ['not an array', '{}', /non-empty array/],
    ['empty array', '[]', /non-empty array/],
    ['missing id', '[{"input":"x","expect":{"a":1}}]', /id must be a non-empty string/],
    ['empty input', '[{"id":"a","input":"","expect":{"a":1}}]', /input must be a non-empty string/],
    ['empty expect', '[{"id":"a","input":"x","expect":{}}]', /expect must be a non-empty object/],
    ['array expect', '[{"id":"a","input":"x","expect":[1]}]', /expect must be a non-empty object/],
    ['duplicate ids', '[{"id":"a","input":"x","expect":{"k":1}},{"id":"a","input":"y","expect":{"k":1}}]', /duplicate id 'a'/],
  ])('%s', (_name, content, re) => {
    writeSet(content);
    expect(() => loadGoldenSet(8)).toThrow(re);
  });
});

describe('runLadderRung (documented stub per ADR-0002)', () => {
  it('returns {rung, route, total, results: []}', async () => {
    const report = await runLadderRung(0, 'oauth-haiku');
    expect(report).toEqual({ rung: 0, route: 'oauth-haiku', total: 5, results: [] });
  });

  it('propagates loader failures (missing set)', async () => {
    await expect(runLadderRung(7, 'any')).rejects.toThrow(/no golden set/);
  });
});
