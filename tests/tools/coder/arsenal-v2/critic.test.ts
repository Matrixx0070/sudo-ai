/**
 * @file critic.test.ts
 * @description Tests for the slice-4 critic — parser + skip paths + LLM
 * injection. The CriticLlm is stubbed inline so no real provider is touched.
 */

import { describe, it, expect } from 'vitest';
import {
  runCritic,
  parseCriticOutput,
  type CriticLlm,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/critic.js';

const baseOpts = {
  task: 'fix the null pointer in foo',
  mode: 'fix' as const,
  diffSummary: '[✓ applied] str_replace → src/foo.ts',
  tscSummary: 'TypeScript: clean ✓',
  testSummary: 'Tests: 42 passed, 0 failed ✓',
  modelId: 'test/stub',
};

const okLlm =
  (response: string): CriticLlm =>
  async () =>
    response;
const throwLlm =
  (msg: string): CriticLlm =>
  async () => {
    throw new Error(msg);
  };

describe('parseCriticOutput', () => {
  it('parses APPROVE with rationale', () => {
    const r = parseCriticOutput('VERDICT: APPROVE\nLGTM, root cause addressed.');
    expect(r.verdict).toBe('approve');
    expect(r.critique).toMatch(/root cause addressed/);
  });

  it('parses NEEDS_REVISION with critique', () => {
    const r = parseCriticOutput('VERDICT: NEEDS_REVISION\nThe patch hides the symptom; need to fix at the source.');
    expect(r.verdict).toBe('needs_revision');
    expect(r.critique).toMatch(/hides the symptom/);
  });

  it('tolerates leading whitespace and markdown bold around the verdict', () => {
    const r = parseCriticOutput('   **VERDICT: APPROVE**\nLooks correct.');
    expect(r.verdict).toBe('approve');
    expect(r.critique).toBe('Looks correct.');
  });

  it('is case-insensitive on the keyword', () => {
    const r = parseCriticOutput('verdict: needs_revision\nstuff');
    expect(r.verdict).toBe('needs_revision');
  });

  it('returns error when no VERDICT line is present', () => {
    const r = parseCriticOutput('This looks fine to me, ship it.');
    expect(r.verdict).toBe('error');
    expect(r.critique).toMatch(/did not include a VERDICT line/);
  });

  it('does not match VERDICT mentioned mid-sentence', () => {
    const r = parseCriticOutput('I would render my VERDICT: maybe later. Ship now.');
    expect(r.verdict).toBe('error');
  });

  // ---- hardening: prefixes real LLMs actually emit ----

  it('tolerates a markdown heading prefix (## VERDICT: ...)', () => {
    const r = parseCriticOutput('## VERDICT: APPROVE\nFix is targeted.');
    expect(r.verdict).toBe('approve');
    expect(r.critique).toBe('Fix is targeted.');
  });

  it('tolerates a single-hash heading prefix (# VERDICT: ...)', () => {
    const r = parseCriticOutput('# VERDICT: NEEDS_REVISION\nMissed the null check.');
    expect(r.verdict).toBe('needs_revision');
  });

  it('tolerates a dash list-marker prefix', () => {
    const r = parseCriticOutput('- VERDICT: APPROVE\nLGTM');
    expect(r.verdict).toBe('approve');
    expect(r.critique).toBe('LGTM');
  });

  it('tolerates a numbered-list prefix', () => {
    const r = parseCriticOutput('1. VERDICT: NEEDS_REVISION\nfix the root cause');
    expect(r.verdict).toBe('needs_revision');
    expect(r.critique).toBe('fix the root cause');
  });

  it('tolerates a blockquote prefix', () => {
    const r = parseCriticOutput('> VERDICT: APPROVE\nclean.');
    expect(r.verdict).toBe('approve');
  });

  it('captures same-line trailing critique after an em-dash', () => {
    const r = parseCriticOutput('VERDICT: APPROVE — clean refactor, behavior preserved.');
    expect(r.verdict).toBe('approve');
    expect(r.critique).toBe('clean refactor, behavior preserved.');
  });

  it('captures same-line trailing critique after a period', () => {
    const r = parseCriticOutput('VERDICT: NEEDS_REVISION. Tests still red after the patch.');
    expect(r.verdict).toBe('needs_revision');
    expect(r.critique).toBe('Tests still red after the patch.');
  });

  it('joins same-line tail and following lines into one critique', () => {
    const r = parseCriticOutput('VERDICT: APPROVE — looks good.\nNo regressions visible.');
    expect(r.verdict).toBe('approve');
    expect(r.critique).toBe('looks good.\nNo regressions visible.');
  });

  it('rejects keywords that only match by prefix (APPROVED / NEEDS_REVISIONS)', () => {
    expect(parseCriticOutput('VERDICT: APPROVED\nstuff').verdict).toBe('error');
    expect(parseCriticOutput('VERDICT: NEEDS_REVISIONS\nstuff').verdict).toBe('error');
  });

  it('finds the verdict on a later line when the LLM opens with a preamble', () => {
    const r = parseCriticOutput(
      'Reviewed the diff and tsc/test signals.\n\n## VERDICT: APPROVE\nMinimal, targeted change.',
    );
    expect(r.verdict).toBe('approve');
    expect(r.critique).toBe('Minimal, targeted change.');
  });
});

describe('runCritic — happy paths', () => {
  it('returns approve when LLM emits APPROVE', async () => {
    const r = await runCritic({
      ...baseOpts,
      llm: okLlm('VERDICT: APPROVE\nFix is minimal and targeted.'),
      env: {},
    });
    expect(r.ran).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.verdict).toBe('approve');
    expect(r.critique).toMatch(/minimal and targeted/);
  });

  it('returns needs_revision when LLM emits NEEDS_REVISION', async () => {
    const r = await runCritic({
      ...baseOpts,
      llm: okLlm('VERDICT: NEEDS_REVISION\nMissed the upstream null check.'),
      env: {},
    });
    expect(r.verdict).toBe('needs_revision');
    expect(r.critique).toMatch(/upstream null check/);
  });
});

describe('runCritic — skip + error paths', () => {
  it('skips with disabled_env when SUDO_ARSENAL_V2_SKIP_CRITIC=1', async () => {
    let called = false;
    const r = await runCritic({
      ...baseOpts,
      llm: async () => {
        called = true;
        return 'VERDICT: APPROVE\n';
      },
      env: { SUDO_ARSENAL_V2_SKIP_CRITIC: '1' },
    });
    expect(called).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('disabled_env');
    // Implicit approve when disabled — don't block tool success.
    expect(r.verdict).toBe('approve');
  });

  it('returns error verdict when LLM throws', async () => {
    const r = await runCritic({
      ...baseOpts,
      llm: throwLlm('connection refused'),
      env: {},
    });
    expect(r.ran).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('critic_error');
    expect(r.verdict).toBe('error');
    expect(r.critique).toMatch(/connection refused/);
  });

  it('returns error verdict when LLM output is malformed', async () => {
    const r = await runCritic({
      ...baseOpts,
      llm: okLlm('I think this is fine, ship it.'),
      env: {},
    });
    expect(r.ran).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.verdict).toBe('error');
    expect(r.critique).toMatch(/did not include a VERDICT line/);
  });

  it('passes task, mode, diff, tsc, and tests into the user prompt', async () => {
    let captured = '';
    await runCritic({
      ...baseOpts,
      llm: async ({ user }) => {
        captured = user;
        return 'VERDICT: APPROVE\nok';
      },
      env: {},
    });
    expect(captured).toMatch(/TASK: fix the null pointer in foo/);
    expect(captured).toMatch(/MODE: fix/);
    expect(captured).toMatch(/DIFF SUMMARY:\n\[✓ applied\]/);
    expect(captured).toMatch(/TYPECHECK:\nTypeScript: clean ✓/);
    expect(captured).toMatch(/TESTS:\nTests: 42 passed/);
  });
});
