/**
 * @file tx19-code.test.ts
 * @description The security-critical gate of nightly CODE self-improvement:
 * parseCodePatch must reject anything malformed/unsafe, and the flag defaults
 * OFF. (Target-path guarding, dry-run tsc, and apply run against the real repo
 * and are exercised in the live proof, not unit tests.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { parseCodePatch, renderCodeDeployCard, codeSelfImproveEnabled, resolveApplyTestPlan } from '../../src/core/self-improvement/tx19-code.js';

describe('resolveApplyTestPlan — scope the apply gate per file', () => {
  it('PLAN-1: runs the mirrored file-specific test when it exists', () => {
    // tests/self-improvement/tx19-code.test.ts (this file) exists.
    expect(resolveApplyTestPlan('src/core/self-improvement/tx19-code.ts'))
      .toEqual({ testTargets: ['tests/self-improvement/tx19-code.test.ts'] });
  });
  it('PLAN-2: else runs the tests that IMPORT the file (real coverage, differently named)', () => {
    // feedback/store.ts has no store.test.ts, but is imported by the feedback tests.
    const plan = resolveApplyTestPlan('src/core/feedback/store.ts');
    expect(plan.skipTests).toBeUndefined();
    expect(plan.testTargets).toContain('tests/feedback/feedback-linkage.test.ts');
    expect(plan.testTargets!.every((t) => t.endsWith('.test.ts'))).toBe(true);
  });
  it('PLAN-3: skips (tsc+build only) when nothing names or imports the file', () => {
    expect(resolveApplyTestPlan('src/core/nonexistent-xyz/never-imported.ts')).toEqual({ skipTests: true });
  });
});

const saved = process.env['SUDO_TX19_CODE'];
afterEach(() => {
  if (saved === undefined) delete process.env['SUDO_TX19_CODE'];
  else process.env['SUDO_TX19_CODE'] = saved;
});

describe('tx19-code — flag defaults OFF', () => {
  it('FLAG-1: disabled unless SUDO_TX19_CODE=1', () => {
    delete process.env['SUDO_TX19_CODE'];
    expect(codeSelfImproveEnabled()).toBe(false);
    process.env['SUDO_TX19_CODE'] = '0';
    expect(codeSelfImproveEnabled()).toBe(false);
    process.env['SUDO_TX19_CODE'] = '1';
    expect(codeSelfImproveEnabled()).toBe(true);
  });
});

describe('parseCodePatch — reject malformed/unsafe drafts', () => {
  const good = JSON.stringify({ path: 'src/core/foo.ts', oldText: 'const a = 1;', newText: 'const a = 2;', rationale: 'bump' });

  it('PARSE-1: accepts a well-formed patch (even wrapped in prose/fences)', () => {
    const p = parseCodePatch('Sure! Here:\n```json\n' + good + '\n```');
    expect(p).not.toBeNull();
    expect(p!.path).toBe('src/core/foo.ts');
    expect(p!.newText).toBe('const a = 2;');
  });

  it('PARSE-2: rejects non-JSON / no object', () => {
    expect(parseCodePatch('I decline')).toBeNull();
    expect(parseCodePatch('')).toBeNull();
  });

  it('PARSE-3: rejects the explicit decline sentinel {"path":""}', () => {
    expect(parseCodePatch('{"path":"","oldText":"x","newText":"y"}')).toBeNull();
  });

  it('PARSE-4: rejects a no-op (oldText === newText)', () => {
    expect(parseCodePatch('{"path":"src/a.ts","oldText":"x","newText":"x"}')).toBeNull();
  });

  it('PARSE-5: rejects non-.ts targets and path traversal', () => {
    expect(parseCodePatch('{"path":"src/a.js","oldText":"x","newText":"y"}')).toBeNull();
    expect(parseCodePatch('{"path":"../etc/passwd.ts","oldText":"x","newText":"y"}')).toBeNull();
  });

  it('PARSE-6: rejects missing fields and oversized text', () => {
    expect(parseCodePatch('{"path":"src/a.ts","newText":"y"}')).toBeNull();
    const huge = 'a'.repeat(5000);
    expect(parseCodePatch(JSON.stringify({ path: 'src/a.ts', oldText: huge, newText: 'y' }))).toBeNull();
  });

  it('PARSE-7: tolerates a missing rationale (defaults empty)', () => {
    const p = parseCodePatch('{"path":"src/a.ts","oldText":"x","newText":"y"}');
    expect(p).not.toBeNull();
    expect(p!.rationale).toBe('');
  });
});

describe('renderCodeDeployCard', () => {
  it('CARD-1: shows file, rationale, and the diff, truncating long text', () => {
    const card = renderCodeDeployCard(
      { path: 'src/core/x.ts', oldText: 'a'.repeat(400), newText: 'b', rationale: 'why' },
      '2026-08-18',
    );
    expect(card).toContain('src/core/x.ts');
    expect(card).toContain('Why: why');
    expect(card).toContain('dry-run typecheck ✓');
    expect(card).toContain('…'); // long oldText truncated
    expect(card).toContain('Deploy = apply now');
  });
});
