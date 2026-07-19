/**
 * @file bo3-policy-digest.test.ts
 * @description BO3 / scorecard-S2 — policy-digest truncation, missing-file
 * markers, and deduped in-band truncation warnings.
 *
 * The headline guarantee (the "never-line survives 4× over-budget" test): a hard
 * rule (`NEVER delete production data`) in an over-budget rules file MUST survive
 * heavy truncation because the regex-extracted policy digest preserves it — a
 * blind tail-chop would drop it. Also: an absent rules file must be VISIBLE via a
 * `[missing workspace file: NAME]` marker, and a truncated file must announce
 * itself with a `[truncation warning: NAME cut to N chars]` line.
 *
 * All outputs are pure functions of their inputs (no clock, no ambient env in
 * the pure helpers) so the byte-stable cacheable prefix (BO2b) stays identical
 * turn-over-turn.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  isRuleLine,
  extractPolicyDigest,
  truncatePolicyForInjection,
  prepareRulesFile,
  truncationWarning,
  dedupeWarningLines,
  missingFileMarker,
  isPolicyFile,
  POLICY_DIGEST_HEADER,
} from '../../src/core/workspace/injector.js';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';
import { PATHS } from '../../src/core/shared/constants.js';

const NEVER_LINE = 'NEVER delete production data';

// A rules file: one hard rule at the TOP (a blind tail-chop would drop it),
// followed by a large body of plain prose that carries NO rule markers.
function makeRulesFile(proseChars: number): string {
  const prose =
    'This is ordinary guidance prose that a reader may skim and that can be ' +
    'safely trimmed when the budget is tight. It carries no imperative and no ' +
    'list marker so it is dropped from the policy digest. ';
  let body = '';
  while (body.length < proseChars) body += prose;
  return `${NEVER_LINE}\n${body}`;
}

describe('BO3/S2 — policy digest extractor', () => {
  it('keeps rule lines (bullets, numbered, headers, imperatives), drops prose', () => {
    const doc = [
      'Some intro prose paragraph that is not a rule.',
      '- a bullet rule',
      '1. a numbered rule',
      '## A Section Header',
      'You MUST always double-check.',
      NEVER_LINE,
      'more trailing prose that should be dropped',
    ].join('\n');

    const digest = extractPolicyDigest(doc);
    expect(digest).toContain('- a bullet rule');
    expect(digest).toContain('1. a numbered rule');
    expect(digest).toContain('## A Section Header');
    expect(digest).toContain('You MUST always double-check.');
    expect(digest).toContain(NEVER_LINE);
    expect(digest).not.toContain('intro prose paragraph');
    expect(digest).not.toContain('trailing prose');
  });

  it('isRuleLine classifies markers and uppercase imperatives, not lowercase prose', () => {
    expect(isRuleLine('- bullet')).toBe(true);
    expect(isRuleLine('2) numbered')).toBe(true);
    expect(isRuleLine('### header')).toBe(true);
    expect(isRuleLine(NEVER_LINE)).toBe(true);
    expect(isRuleLine('you must never forget prose')).toBe(false); // lowercase → prose
    expect(isRuleLine('just an ordinary sentence.')).toBe(false);
  });
});

describe('BO3/S2 — never-line survives 4× over budget (pure)', () => {
  it('the hard NEVER rule survives when the file is 4× over the cap', () => {
    const cap = 1200;
    const content = makeRulesFile(cap * 4); // > 4× cap of prose after the rule line
    expect(content.length).toBeGreaterThan(cap * 4);

    const r = truncatePolicyForInjection(content, cap);
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(content.length);
    // The digest preserved the hard rule verbatim even though it sat at the very
    // top (a blind tail-chop would have dropped it).
    expect(r.text).toContain(NEVER_LINE);
    expect(r.text).toContain(POLICY_DIGEST_HEADER);
  });

  it('keeps the full digest even when the digest alone exceeds the cap', () => {
    // Many rule lines, tiny cap → digest > cap. Hard rules are non-negotiable,
    // so the full digest is kept rather than dropping rules to fit.
    const rules = Array.from({ length: 50 }, (_, i) => `- rule number ${i}`).join('\n');
    const content = `${NEVER_LINE}\n${rules}\n${'prose. '.repeat(400)}`;
    const r = truncatePolicyForInjection(content, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain(NEVER_LINE);
    expect(r.text).toContain('- rule number 49');
  });

  it('under-budget content is returned verbatim, untruncated', () => {
    const content = `${NEVER_LINE}\nshort body`;
    const r = truncatePolicyForInjection(content, 10_000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(content);
  });

  it('falls back to plain tail truncation when there are no rule lines', () => {
    const content = 'plain prose sentence. '.repeat(500); // no markers, no imperatives
    const r = truncatePolicyForInjection(content, 500);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[...truncated:');
    expect(r.text).not.toContain(POLICY_DIGEST_HEADER);
  });
});

describe('BO3/S2 — warnings + markers (pure)', () => {
  it('prepareRulesFile emits a deterministic warning only when truncated', () => {
    const under = prepareRulesFile('AGENTS.md', `${NEVER_LINE}\nsmall`, 10_000);
    expect(under.truncated).toBe(false);
    expect(under.warning).toBe('');

    const over = prepareRulesFile('AGENTS.md', makeRulesFile(6_000), 1_000);
    expect(over.truncated).toBe(true);
    expect(over.warning).toContain('[truncation warning: AGENTS.md cut to');
    expect(over.body).toContain(NEVER_LINE);
    // Deterministic: same input → identical warning + body.
    const again = prepareRulesFile('AGENTS.md', makeRulesFile(6_000), 1_000);
    expect(again.warning).toBe(over.warning);
    expect(again.body).toBe(over.body);
  });

  it('prepareRulesFile passes a missing-file marker through untouched', () => {
    const marker = missingFileMarker('SAFETY-RULES.md');
    const p = prepareRulesFile('SAFETY-RULES.md', marker, 10);
    expect(p.body).toBe(marker);
    expect(p.truncated).toBe(false);
    expect(p.warning).toBe('');
  });

  it('truncationWarning + dedupeWarningLines are deterministic and deduped', () => {
    const w1 = truncationWarning('AGENTS.md', 500);
    const w2 = truncationWarning('AGENTS.md', 500);
    expect(w1).toBe(w2);
    const deduped = dedupeWarningLines([w1, w2, truncationWarning('SAFETY-RULES.md', 3), '']);
    expect(deduped).toEqual([w1, truncationWarning('SAFETY-RULES.md', 3)]);
  });

  it('missingFileMarker + isPolicyFile classify the rules/identity set', () => {
    expect(missingFileMarker('SAFETY-RULES.md')).toBe('[missing workspace file: SAFETY-RULES.md]');
    expect(isPolicyFile('AGENTS.md')).toBe(true);
    expect(isPolicyFile('SAFETY-RULES.md')).toBe(true);
    expect(isPolicyFile('GIT-SAFETY.md')).toBe(true);
    expect(isPolicyFile('USER.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The REQUIRED S2 test — assemble the REAL prompt with an over-budget AGENTS.md
// (4× over the cap) and a deleted SAFETY-RULES.md, and prove end-to-end:
//   (a) the never-line survived (policy digest),
//   (b) a truncation warning appears,
//   (c) the deleted rules file yields a missing-file marker.
// ---------------------------------------------------------------------------
describe('BO3/S2 — assembled prompt: never-line survives 4× over-budget + markers', () => {
  const agentsPath = path.join(PATHS.WORKSPACE, 'AGENTS.md');
  const safetyPath = path.join(PATHS.WORKSPACE, 'SAFETY-RULES.md');

  afterEach(() => {
    delete process.env['SUDO_INJECT_RULES_MAX'];
    if (existsSync(agentsPath)) rmSync(agentsPath);
    // SAFETY-RULES.md must stay absent for the missing-marker assertion; never write it.
  });

  it('assembles with the hard rule preserved, a truncation warning, and a missing marker', async () => {
    // Guard: do not clobber a real SAFETY-RULES.md if one somehow exists.
    expect(existsSync(safetyPath)).toBe(false);

    mkdirSync(PATHS.WORKSPACE, { recursive: true });
    const cap = 1_000;
    const content = makeRulesFile(cap * 4); // AGENTS.md is 4× over the inject cap
    expect(content.length).toBeGreaterThan(cap * 4);
    writeFileSync(agentsPath, content);
    process.env['SUDO_INJECT_RULES_MAX'] = String(cap);

    const prompt = await assembleSystemPrompt({});

    // (a) the hard rule survived heavy truncation (policy digest preserved it).
    expect(prompt).toContain(NEVER_LINE);
    expect(prompt).toContain(POLICY_DIGEST_HEADER);
    // (b) a truncation warning announces the cut.
    expect(prompt).toContain('[truncation warning: AGENTS.md cut to');
    // (c) the deleted rules file is visible as a missing-file marker.
    expect(prompt).toContain('[missing workspace file: SAFETY-RULES.md]');
  });
});
