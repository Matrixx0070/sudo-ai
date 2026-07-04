/**
 * repair-flywheel-verify — the verify → adopt half (the moat). Proves the
 * verification engine + adoption gate deterministically, on both a synthetic
 * repair and the real read-file path repair, plus the shadow-decision pass.
 */
import { describe, it, expect } from 'vitest';
import {
  replayVerify,
  decideAdoption,
  makeReadFilePathRepair,
  runShadowVerification,
  type DeterministicRepair,
} from '../../src/core/learning/repair-flywheel-verify.js';

// A synthetic repair: "value must be lowercase"; transform lowercases it.
const lowercaseRepair: DeterministicRepair = {
  lessonId: 'lowercase',
  tool: 'x',
  verify: (i) => typeof i['v'] === 'string' && (i['v'] as string) === (i['v'] as string).toLowerCase(),
  transform: (i) => ({ ...i, v: String(i['v']).toLowerCase() }),
};

describe('replayVerify + decideAdoption', () => {
  it('measures recovery over GENUINE failures (already-ok inputs excluded)', () => {
    const inputs = [{ v: 'ABC' }, { v: 'DeF' }, { v: 'already-ok' }, { v: 'XYZ' }];
    const r = replayVerify(inputs, lowercaseRepair);
    expect(r.tried).toBe(4);
    expect(r.alreadyOk).toBe(1);       // 'already-ok'
    expect(r.recovered).toBe(3);       // ABC, DeF, XYZ → lowercased pass
    expect(r.recoveryPct).toBe(100);   // 3/3 genuine failures recovered
  });

  it('adopts only with enough samples AND recovery over the bar', () => {
    const strong = { tried: 30, alreadyOk: 0, recovered: 27, recoveryPct: 90 };
    const weak = { tried: 30, alreadyOk: 0, recovered: 15, recoveryPct: 50 };
    const thin = { tried: 5, alreadyOk: 0, recovered: 5, recoveryPct: 100 };
    expect(decideAdoption(strong)).toBe('adopt');
    expect(decideAdoption(weak)).toBe('reject');           // recovery below bar
    expect(decideAdoption(thin)).toBe('insufficient-data'); // too few samples
  });

  it('a repair that recovers nothing is rejected, never adopted', () => {
    const noop: DeterministicRepair = { lessonId: 'noop', tool: 'x', verify: () => false, transform: (i) => i };
    const r = replayVerify(Array(25).fill({ v: 'ABC' }), noop);
    expect(r.recovered).toBe(0);
    expect(decideAdoption(r)).toBe('reject');
  });
});

describe('makeReadFilePathRepair', () => {
  const repair = makeReadFilePathRepair('/repo');
  it('accepts an in-repo path and rewrites an absolute one to relative', () => {
    expect(repair.verify({ path: 'src/x.ts' })).toBe(true);          // relative → within
    expect(repair.verify({ path: '/repo/src/x.ts' })).toBe(true);    // in-repo absolute → within
    expect(repair.verify({ path: '/etc/passwd' })).toBe(false);      // escape
    expect(repair.transform({ path: '/repo/src/x.ts' })).toEqual({ path: 'src/x.ts' });
  });
  it('leaves an out-of-repo path unrepairable', () => {
    expect(repair.transform({ path: '/etc/passwd' })).toEqual({ path: '/etc/passwd' });
  });
});

describe('runShadowVerification', () => {
  it('parses captured args, verifies per tool, and returns a decision (never applies)', () => {
    const rows = [
      { tool_name: 'coder.read-file', args_raw: '{"path":"/etc/passwd"}' }, // escape → unrepairable
      { tool_name: 'coder.read-file', args_raw: 'not json' },                // skipped
      { tool_name: 'other.tool', args_raw: '{"path":"x"}' },                 // wrong tool → skipped
    ];
    const decisions = runShadowVerification(rows, [makeReadFilePathRepair('/repo')]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.tool).toBe('coder.read-file');
    // 1 genuine failure, unrepairable → insufficient-data (below sample floor) — and NEVER 'adopt' on no recovery.
    expect(decisions[0]!.decision).not.toBe('adopt');
  });
});
