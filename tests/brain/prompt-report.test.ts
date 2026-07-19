import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DYNAMIC_BOUNDARY_MARKER } from '../../src/core/brain/prompt-cache-discipline.js';
import {
  buildPromptReport,
  parseSections,
  detectPrefixChurn,
  sha256,
} from '../../src/core/brain/prompt-report.js';
import {
  PromptReportStore,
  isPromptReportEnabled,
} from '../../src/core/brain/prompt-report-store.js';

// A realistic-shaped assembled prompt: header-less preamble (SOUL/IDENTITY/USER),
// two stable header sections, the boundary marker, then a dynamic section.
function samplePrompt(dynamicExtra = ''): string {
  return [
    'You are SUDO.',
    'IDENTITY: test agent.',
    'USER: frank.',
    '',
    '## Operating Principles',
    '',
    'Work like a pro.',
    '',
    '## Playbooks',
    '',
    'Do the thing.',
    '',
    DYNAMIC_BOUNDARY_MARKER,
    '',
    '## Current Date & Time',
    '',
    'Current date: 2026-07-18' + dynamicExtra,
  ].join('\n');
}

describe('buildPromptReport — section accounting', () => {
  it('splits stable prefix vs dynamic suffix at the boundary marker', () => {
    const p = samplePrompt();
    const r = buildPromptReport(p);
    expect(r.hasBoundary).toBe(true);
    expect(r.totalChars).toBe(p.length);
    // prefix + suffix reconstruct the whole prompt exactly.
    expect(r.stablePrefixChars + r.dynamicSuffixChars).toBe(p.length);
    const idx = p.indexOf(DYNAMIC_BOUNDARY_MARKER);
    expect(r.stablePrefixSha256).toBe(sha256(p.slice(0, idx)));
    expect(r.dynamicSuffixSha256).toBe(sha256(p.slice(idx)));
    expect(r.fullSha256).toBe(sha256(p));
  });

  it('accounts every named section and tags its region', () => {
    const r = buildPromptReport(samplePrompt());
    const names = r.sections.map((s) => s.name);
    expect(names).toContain('Preamble (SOUL/IDENTITY/USER)');
    expect(names).toContain('Operating Principles');
    expect(names).toContain('Playbooks');
    expect(names).toContain('Current Date & Time');

    const byName = Object.fromEntries(r.sections.map((s) => [s.name, s]));
    expect(byName['Operating Principles']!.region).toBe('stable');
    expect(byName['Playbooks']!.region).toBe('stable');
    expect(byName['Preamble (SOUL/IDENTITY/USER)']!.region).toBe('stable');
    expect(byName['Current Date & Time']!.region).toBe('dynamic');
  });

  it('marks hasBoundary false and treats the whole prompt as stable when no marker', () => {
    const r = buildPromptReport('## Only\n\nno boundary here');
    expect(r.hasBoundary).toBe(false);
    expect(r.dynamicSuffixChars).toBe(0);
    expect(r.stablePrefixChars).toBe(r.totalChars);
    expect(r.sections.every((s) => s.region === 'stable')).toBe(true);
  });

  it('NO-RAW-TEXT invariant: report carries only counts + hex hashes, never prompt content', () => {
    const secret = 'TOPSECRET-PROMPT-BODY-XYZ';
    const p = samplePrompt(secret);
    const r = buildPromptReport(p);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Work like a pro');
    expect(serialized).not.toContain('You are SUDO');
    // Every section exposes exactly the accounting fields, nothing else.
    for (const s of r.sections) {
      expect(Object.keys(s).sort()).toEqual(['chars', 'name', 'region', 'sha256']);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('sha256 stability + churn detection', () => {
  it('stable-prefix hash is byte-stable when only the dynamic suffix changes', () => {
    const a = buildPromptReport(samplePrompt(''));
    const b = buildPromptReport(samplePrompt(' 12:00:01Z')); // dynamic-only change
    expect(a.stablePrefixSha256).toBe(b.stablePrefixSha256);
    expect(a.dynamicSuffixSha256).not.toBe(b.dynamicSuffixSha256);
  });

  it('detectPrefixChurn: false on first turn / unchanged, true on mutated prefix', () => {
    expect(detectPrefixChurn(null, 'abc')).toBe(false);
    expect(detectPrefixChurn(undefined, 'abc')).toBe(false);
    expect(detectPrefixChurn('abc', 'abc')).toBe(false);
    expect(detectPrefixChurn('abc', 'def')).toBe(true);
  });

  it('flags churn when a stable section mutates', () => {
    const base = buildPromptReport(samplePrompt());
    // Mutate a stable section (Operating Principles body).
    const mutated = buildPromptReport(samplePrompt().replace('Work like a pro.', 'Work differently.'));
    expect(detectPrefixChurn(base.stablePrefixSha256, mutated.stablePrefixSha256)).toBe(true);
  });
});

describe('parseSections', () => {
  it('returns a single preamble section for header-less text', () => {
    const secs = parseSections('just some text', 'stable', 'Preamble');
    expect(secs).toHaveLength(1);
    expect(secs[0]!.name).toBe('Preamble');
    expect(secs[0]!.region).toBe('stable');
  });

  it('skips whitespace-only content', () => {
    expect(parseSections('   \n\n  ', 'dynamic', 'X')).toHaveLength(0);
  });
});

describe('isPromptReportEnabled flag gate', () => {
  const prev = process.env['SUDO_PROMPT_REPORT'];
  afterEach(() => {
    if (prev === undefined) delete process.env['SUDO_PROMPT_REPORT'];
    else process.env['SUDO_PROMPT_REPORT'] = prev;
  });
  it('defaults OFF, on only for 1/true', () => {
    delete process.env['SUDO_PROMPT_REPORT'];
    expect(isPromptReportEnabled()).toBe(false);
    process.env['SUDO_PROMPT_REPORT'] = '0';
    expect(isPromptReportEnabled()).toBe(false);
    process.env['SUDO_PROMPT_REPORT'] = '1';
    expect(isPromptReportEnabled()).toBe(true);
    process.env['SUDO_PROMPT_REPORT'] = 'true';
    expect(isPromptReportEnabled()).toBe(true);
  });
});

describe('PromptReportStore — persistence + churn', () => {
  let store: PromptReportStore;
  beforeEach(() => {
    store = new PromptReportStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('persists a report and reports no churn on the first turn', () => {
    const r = buildPromptReport(samplePrompt());
    const res = store.record(r, { sessionKey: 's1', route: 'xai/grok-4.3' });
    expect(res.id).not.toBeNull();
    expect(res.churned).toBe(false);
    expect(res.previousStableSha256).toBeNull();
    expect(store.count()).toBe(1);
  });

  it('does not churn across turns when the stable prefix is byte-identical', () => {
    store.record(buildPromptReport(samplePrompt('')), { sessionKey: 's2' });
    const res = store.record(buildPromptReport(samplePrompt(' later')), { sessionKey: 's2' });
    expect(res.churned).toBe(false);
    expect(store.count()).toBe(2);
  });

  it('flags churn and stamps prefix_churned=1 when the stable prefix mutates', () => {
    store.record(buildPromptReport(samplePrompt()), { sessionKey: 's3' });
    const mutated = buildPromptReport(samplePrompt().replace('Work like a pro.', 'MUTATED.'));
    const res = store.record(mutated, { sessionKey: 's3', route: 'r' });
    expect(res.churned).toBe(true);
    expect(res.previousStableSha256).not.toBeNull();
  });

  it('tracks churn per session key independently', () => {
    store.record(buildPromptReport(samplePrompt()), { sessionKey: 'A' });
    // Different session, mutated prefix — no churn (first turn for B).
    const res = store.record(
      buildPromptReport(samplePrompt().replace('Work like a pro.', 'X.')),
      { sessionKey: 'B' },
    );
    expect(res.churned).toBe(false);
  });

  it('lastStableSha256 returns null for unknown session', () => {
    expect(store.lastStableSha256('nope')).toBeNull();
  });
});
