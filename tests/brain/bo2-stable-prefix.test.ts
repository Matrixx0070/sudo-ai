/**
 * @file bo2-stable-prefix.test.ts
 * @description BO2 / scorecard-S1 — regression lock for the byte-identical
 * cacheable prefix.
 *
 * OpenClaw's headline was 91.6% cache-read share over 50 turns, driven by a
 * byte-stable cacheable prefix. The BO2 diagnosis (isolated 50-turn Grok bench)
 * proved the stable prefix ABOVE the DYNAMIC_BOUNDARY_MARKER was already
 * byte-identical, but two per-turn-volatile blocks — the fresh Recent Memory
 * daily log and the second-precision date/time — were emitted at the TOP of the
 * dynamic region, so implicit-prefix-cache providers (xAI Grok /responses) that
 * cache only up to the first turn-over-turn byte difference had their cached
 * prefix capped at the boundary. The fix (system-prompt.ts) defers both volatile
 * blocks to the very END of the prompt when SUDO_PROMPT_CACHE=1.
 *
 * These tests lock the invariant that BO2 depends on: two assembled prompts that
 * differ ONLY in per-turn/dynamic fields (Recent Memory content, wall-clock
 * time) must produce a byte-IDENTICAL stable prefix (same stablePrefixSha256),
 * and the volatile content must live below the boundary — never above it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';
import { buildPromptReport } from '../../src/core/brain/prompt-report.js';

const BOUNDARY = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';

afterEach(() => {
  delete process.env['SUDO_PROMPT_CACHE'];
});

describe('BO2/S1 — byte-identical cacheable prefix', () => {
  it('stable prefix is byte-identical across turns that differ only in Recent Memory (SUDO_PROMPT_CACHE=1)', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';

    // Two "turns" of one session: identical static context, different fresh
    // daily-log content — exactly the per-turn churn that used to bust the cache.
    const promptA = await assembleSystemPrompt({
      memoryContext: '## turn 1\n**User:** hi\n**Agent:** hello\n'.repeat(20),
    });
    const promptB = await assembleSystemPrompt({
      memoryContext: '## turn 2\n**User:** ping\n**Agent:** pong\n'.repeat(30),
    });

    const reportA = buildPromptReport(promptA);
    const reportB = buildPromptReport(promptB);

    // The cacheable prefix must be provably byte-stable.
    expect(reportA.hasBoundary).toBe(true);
    expect(reportB.hasBoundary).toBe(true);
    expect(reportA.stablePrefixSha256).toBe(reportB.stablePrefixSha256);
    expect(reportA.stablePrefixChars).toBe(reportB.stablePrefixChars);

    // The differing Recent Memory content must land in the DYNAMIC suffix
    // (below the boundary), never in the cacheable prefix.
    const stableA = promptA.slice(0, promptA.indexOf(BOUNDARY));
    expect(stableA).not.toContain('**Agent:** hello');
    const dynamicA = promptA.slice(promptA.indexOf(BOUNDARY));
    expect(dynamicA).toContain('**Agent:** hello');
  });

  it('stable prefix is byte-identical across two assemblies at different wall-clock times', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';

    // Deterministic clock: two assemblies a full minute apart so the date/time
    // block provably differs, with NO real delay in between (avoids both the
    // same-second flake and cross-singleton drift during a real sleep).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
      const first = await assembleSystemPrompt({});
      vi.setSystemTime(new Date('2026-07-19T00:01:07.000Z'));
      const second = await assembleSystemPrompt({});

      const rFirst = buildPromptReport(first);
      const rSecond = buildPromptReport(second);

      // Sanity: the volatile date/time actually changed (dynamic suffix differs),
      // otherwise this test would pass vacuously.
      expect(rFirst.dynamicSuffixSha256).not.toBe(rSecond.dynamicSuffixSha256);
      // But the cacheable prefix is byte-identical.
      expect(rFirst.stablePrefixSha256).toBe(rSecond.stablePrefixSha256);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers the volatile date/time block below the boundary (SUDO_PROMPT_CACHE=1)', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    const prompt = await assembleSystemPrompt({});
    const idx = prompt.indexOf(BOUNDARY);
    expect(idx).toBeGreaterThan(0);
    const dateIdx = prompt.indexOf('## Current Date & Time');
    expect(dateIdx).toBeGreaterThan(idx); // date is below the boundary
    // And it is the LAST section — nothing volatile trails it in the prefix path.
    const afterDate = prompt.slice(dateIdx + '## Current Date & Time'.length);
    expect(afterDate).not.toContain(BOUNDARY);
  });
});
