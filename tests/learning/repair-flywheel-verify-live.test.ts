/**
 * repair-flywheel-verify-live — the LIVE A/B verifier for guidance repairs.
 * Proves the recovery math, the true-to-prod exec guard predicate, cost/fail-open
 * guarantees, and the adoption gate — all with a DETERMINISTIC fake rewrite (no
 * real LLM, no tokens, no network).
 */
import { describe, it, expect } from 'vitest';
import {
  replayVerifyLive,
  decideLiveAdoption,
  makeExecRepoRepair,
  buildRewritePrompt,
  parseRewriteReply,
  REPAIR_REGISTRY,
  getRepairsForTool,
  registeredRepairTools,
  type LlmRewrite,
} from '../../src/core/learning/repair-flywheel-verify-live.js';

const repair = makeExecRepoRepair();

/** A fake "model": fixes a couple of known refused commands, else declares IMPOSSIBLE. */
const fakeRewrite: LlmRewrite = async ({ original }) => {
  if (original === 'grep foo | cat') return 'rg foo';
  if (original === 'cat package.json') return 'ls package.json';
  return null; // pm2 restart, bash -lc, multi-step — correctly unrewritable
};

describe('REPAIR_REGISTRY', () => {
  it('registers the repo-exec guidance repair for both exec tool names', () => {
    expect(registeredRepairTools().sort()).toEqual(['exec', 'system.exec']);
    expect(getRepairsForTool('system.exec')).toHaveLength(1);
    expect(getRepairsForTool('exec')).toHaveLength(1);
    expect(getRepairsForTool('does.not.exist')).toEqual([]);
  });
  it('every registered repair carries a true-to-prod check + errorPattern (no inert entries)', () => {
    for (const r of REPAIR_REGISTRY) {
      expect(typeof r.check).toBe('function');
      expect(r.errorPattern.length).toBeGreaterThan(0);
    }
  });
  it('the exec-tool variant shares the guard but has a distinct lessonId (independent canary)', () => {
    const alias = makeExecRepoRepair(undefined, 'exec');
    expect(alias.tool).toBe('exec');
    expect(alias.lessonId).not.toBe(makeExecRepoRepair().lessonId);
    expect(alias.check('grep foo | cat').ok).toBe(false); // same true-to-prod guard
    expect(alias.check('rg foo').ok).toBe(true);
  });
});

describe('makeExecRepoRepair — true-to-prod guard predicate', () => {
  it('extracts only repo-targeted exec commands', () => {
    expect(repair.extract({ command: 'rg foo', target: 'repo' })).toBe('rg foo');
    expect(repair.extract({ command: 'rg foo' })).toBeNull();        // no repo target
    expect(repair.extract({ command: 'rg foo', target: 'sandbox' })).toBeNull();
    expect(repair.extract({ notCommand: 1, target: 'repo' })).toBeNull();
  });
  it('check mirrors checkRepoCommand (allowlisted pass, metachar/non-allowlisted fail)', () => {
    expect(repair.check('rg foo').ok).toBe(true);          // allowlisted read
    expect(repair.check('git status').ok).toBe(true);
    expect(repair.check('grep foo | cat').ok).toBe(false); // unquoted pipe
    expect(repair.check('pm2 restart sudo-ai-v5').ok).toBe(false); // restart not allowed
    expect(repair.check('cat package.json').ok).toBe(false);       // cat not allowlisted
  });
});

describe('replayVerifyLive', () => {
  it('measures recovery over genuine refusals; already-ok and out-of-scope excluded', async () => {
    const inputs = [
      { command: 'grep foo | cat', target: 'repo' },        // recoverable → rg foo
      { command: 'cat package.json', target: 'repo' },       // recoverable → ls package.json
      { command: 'pm2 restart sudo-ai-v5', target: 'repo' }, // IMPOSSIBLE
      { command: 'bash -lc "x; y"', target: 'repo' },        // IMPOSSIBLE
      { command: 'rg already-fine', target: 'repo' },        // already ok
      { command: 'rg foo' },                                 // out of scope (no repo target)
    ];
    const r = await replayVerifyLive(inputs, repair, fakeRewrite);
    expect(r.applicable).toBe(5);   // the 5 repo-target rows
    expect(r.alreadyOk).toBe(1);    // rg already-fine
    expect(r.recovered).toBe(2);    // grep|cat, cat→ls
    expect(r.impossible).toBe(2);   // pm2, bash
    expect(r.recoveryPct).toBe(50); // 2 / (5-1) genuine
  });

  it('a rewrite that throws is fail-open (counts as not-recovered, never throws)', async () => {
    const boom: LlmRewrite = async () => { throw new Error('provider down'); };
    const r = await replayVerifyLive([{ command: 'grep x | cat', target: 'repo' }], repair, boom);
    expect(r.recovered).toBe(0);
    expect(r.applicable).toBe(1);
  });

  it('respects the maxEpisodes cost ceiling (does not spend beyond it)', async () => {
    let calls = 0;
    const counting: LlmRewrite = async () => { calls += 1; return null; };
    const inputs = Array.from({ length: 10 }, (_, i) => ({ command: `pm2 restart x${i}`, target: 'repo' }));
    const r = await replayVerifyLive(inputs, repair, counting, { maxEpisodes: 3 });
    expect(calls).toBe(3);        // only 3 rewrites spent
    expect(r.applicable).toBe(10); // but all counted as tried
  });

  it('a lesson that recovers little is not adopted (verifier stops a useless lesson)', async () => {
    // 25 genuinely-unrewritable refusals → 0 recovered → reject.
    const inputs = Array.from({ length: 25 }, (_, i) => ({ command: `pm2 restart x${i}`, target: 'repo' }));
    const r = await replayVerifyLive(inputs, repair, fakeRewrite, { maxEpisodes: 100 });
    expect(r.recovered).toBe(0);
    expect(decideLiveAdoption(r)).toBe('reject');
  });

  it('enough samples + high recovery → adopt', async () => {
    const inputs = Array.from({ length: 22 }, () => ({ command: 'grep foo | cat', target: 'repo' }));
    const r = await replayVerifyLive(inputs, repair, fakeRewrite, { maxEpisodes: 100 });
    expect(r.recovered).toBe(22);
    expect(decideLiveAdoption(r)).toBe('adopt');
  });
});

describe('prompt + reply parsing', () => {
  it('buildRewritePrompt carries the lesson, original, and reason', () => {
    const p = buildRewritePrompt('LESSON-TEXT', 'grep foo | cat', 'shell operators not allowed');
    expect(p).toContain('LESSON-TEXT');
    expect(p).toContain('grep foo | cat');
    expect(p).toContain('shell operators not allowed');
    expect(p).toContain('IMPOSSIBLE');
  });
  it('parseRewriteReply strips fences/backticks and treats IMPOSSIBLE/empty as null', () => {
    expect(parseRewriteReply('rg foo')).toBe('rg foo');
    expect(parseRewriteReply('```sh\nrg foo\n```')).toBe('rg foo');
    expect(parseRewriteReply('`rg foo`')).toBe('rg foo');
    expect(parseRewriteReply('IMPOSSIBLE')).toBeNull();
    expect(parseRewriteReply('  impossible  ')).toBeNull();
    expect(parseRewriteReply('')).toBeNull();
  });
});
