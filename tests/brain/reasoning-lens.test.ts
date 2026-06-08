/**
 * @file tests/brain/reasoning-lens.test.ts
 * @description Theme 3 — curated reasoning-lens library + system-prompt injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectLenses } from '../../src/core/brain/reasoning-lens.js';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

describe('Theme 3: selectLenses', () => {
  const ENV = 'SUDO_REASONING_LENS_DISABLE';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

  it('LENS-1: a debugging task fires the root-cause lens', () => {
    const r = selectLenses('why is this function failing with an error?');
    expect(r).not.toBeNull();
    expect(r!.ids).toContain('root-cause');
    expect(r!.text).toContain('Root-Cause');
  });

  it('LENS-2: a competitive-strategy task fires strategic lenses', () => {
    const r = selectLenses('what strategy should we use to beat our competitor?');
    expect(r).not.toBeNull();
    // actor-decode (competitor) + four-dimensions (strategy/beat), priority-ranked
    expect(r!.ids).toContain('actor-decode');
    expect(r!.kinds).toContain('strategic');
  });

  it('LENS-3: forecasting fires the epistemic-stance lens', () => {
    const r = selectLenses('predict what will happen to the market next quarter');
    expect(r!.ids).toContain('epistemic-stance');
    expect(r!.text).toContain('Speculation, not prophecy');
  });

  it('LENS-4: lenses are capped (priority-ranked) by max', () => {
    const r = selectLenses('review and audit this security design and decide the best option', { max: 1 });
    expect(r!.ids).toHaveLength(1);
    // adversarial (priority 16) wins over cost-benefit (11)
    expect(r!.ids[0]).toBe('adversarial');
  });

  it('LENS-5: no match → null', () => {
    expect(selectLenses('hello, good morning!')).toBeNull();
  });

  it('LENS-6: kill-switch disables all lenses', () => {
    process.env[ENV] = '1';
    expect(selectLenses('why is this failing?')).toBeNull();
  });

  it('LENS-7: output carries the "lens not fact" safety framing', () => {
    const r = selectLenses('analyze the root cause of this regression');
    expect(r!.text).toMatch(/lenses|hypotheses/i);
    expect(r!.text).toContain('NOT facts');
  });
});

describe('Theme 3: system-prompt injection', () => {
  it('ASP-1: assembleSystemPrompt renders the Reasoning Lens section', async () => {
    const prompt = await assembleSystemPrompt({ reasoningLens: 'UNIQUE_LENS_MARKER_123' });
    expect(prompt).toContain('Reasoning Lens');
    expect(prompt).toContain('UNIQUE_LENS_MARKER_123');
  });

  it('ASP-2: no reasoning-lens section when none provided', async () => {
    const prompt = await assembleSystemPrompt({});
    expect(prompt).not.toContain('UNIQUE_LENS_MARKER_123');
  });
});
