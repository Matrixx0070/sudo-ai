import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheVerdict, loadGoldenSet } from '../../../src/core/eval/sandbox/ladder.js';
import { checkRouteAdmission, validateBrainChainAdmission } from '../../../src/core/eval/sandbox/ladder-gate.js';

const ENFORCE = 'SUDO_EVAL_LADDER_ENFORCE';

describe('ladder admission gate', () => {
  let dir: string;
  const prev = process.env[ENFORCE];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gate-')); delete process.env[ENFORCE]; });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env[ENFORCE]; else process.env[ENFORCE] = prev;
  });
  const db = (): string => join(dir, 'gateway.db');

  const seed = (route: string, admitted: boolean): void => {
    cacheVerdict({
      rung: 1, route, goldenSetVersion: loadGoldenSet(1).version,
      n: 100, passed: admitted ? 100 : 50, failed: admitted ? 0 : 50,
      passRate: admitted ? 1 : 0.5, threshold: 0.99, minN: 100,
      admitted, spentUsd: 0, results: [],
    }, db());
  };

  it('advisory by default: a MISSING verdict warns but still allows', () => {
    const v = checkRouteAdmission('unknown/route', 1, db());
    expect(v.missing).toBe(true);
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain('pnpm eval:ladder');
  });

  it('ENFORCING: a missing verdict is refused — ungraded is not passing', () => {
    process.env[ENFORCE] = '1';
    const v = checkRouteAdmission('unknown/route', 1, db());
    expect(v.missing).toBe(true);
    expect(v.allowed).toBe(false);
  });

  it('ENFORCING: a FAILED cached verdict is refused', () => {
    seed('bad/route', false);
    process.env[ENFORCE] = '1';
    const v = checkRouteAdmission('bad/route', 1, db());
    expect(v.admitted).toBe(false);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('FAILED rung 1');
  });

  it('an ADMITTED verdict allows under either mode', () => {
    seed('good/route', true);
    for (const mode of [undefined, '1']) {
      if (mode === undefined) delete process.env[ENFORCE]; else process.env[ENFORCE] = mode;
      const v = checkRouteAdmission('good/route', 1, db());
      expect(v.admitted).toBe(true);
      expect(v.allowed).toBe(true);
    }
  });

  it('validateBrainChainAdmission reports only problems and never throws', () => {
    seed('good/route', true);
    const problems = validateBrainChainAdmission(['good/route', 'missing/route'], db());
    expect(problems.map((p) => p.route)).toEqual(['missing/route']);
    expect(() => validateBrainChainAdmission([''], db())).not.toThrow();
  });

  it('is inert when the rung has no golden set — never blocks on our own gap', () => {
    const v = checkRouteAdmission('any/route', 9, db());
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain('gate inert');
  });
});
