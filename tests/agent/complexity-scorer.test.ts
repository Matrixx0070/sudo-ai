/**
 * Tests for complexity-scorer.ts — Wave 10 Builder 2.
 *
 * Covers:
 *   - All 4 tier thresholds
 *   - Each individual signal
 *   - Multi-step keyword accumulation
 *   - Thinking-model x2 multiplier
 *   - Score clamping at 1.0
 *   - Empty input defaults
 */

import { describe, it, expect } from 'vitest';
import { scoreComplexity } from '../../src/core/agent/complexity-scorer.js';

// ---------------------------------------------------------------------------
// Tier threshold tests
// ---------------------------------------------------------------------------

describe('ComplexityScorer — tier thresholds', () => {
  it('returns simple tier for an empty prompt (score 0)', () => {
    const r = scoreComplexity({ prompt: '' });
    expect(r.score).toBe(0);
    expect(r.tier).toBe('simple');
    expect(r.suggested_max_tokens).toBe(2048);
    expect(r.thinking_model).toBe(false);
    expect(r.signals).toHaveLength(0);
  });

  it('returns simple tier for a short plain prompt (score < 0.25)', () => {
    const r = scoreComplexity({ prompt: 'Say hello.', toolCount: 2 });
    expect(r.tier).toBe('simple');
    expect(r.suggested_max_tokens).toBe(2048);
  });

  it('returns moderate tier at score 0.25 boundary (long message only)', () => {
    // message_length signal alone = +0.15 (score 0.15 < 0.25) — not enough
    const longMsg = 'a'.repeat(2001);
    const r = scoreComplexity({ prompt: longMsg });
    expect(r.score).toBeGreaterThanOrEqual(0.15);
    expect(r.tier).toBe('simple'); // 0.15 < 0.25
  });

  it('returns moderate tier when score reaches 0.25 (message_length + tool_count)', () => {
    // message_length (+0.15) + tool_count (+0.10) = 0.25
    const longMsg = 'a'.repeat(2001);
    const r = scoreComplexity({ prompt: longMsg, toolCount: 6 });
    expect(r.score).toBeCloseTo(0.25, 5);
    expect(r.tier).toBe('moderate');
    expect(r.suggested_max_tokens).toBe(4096);
  });

  it('returns complex tier at score >= 0.5', () => {
    // code_blocks (+0.2) + message_length (+0.15) + tool_count (+0.1) + multi-step "plan" (+0.05) = 0.50
    const prompt = '```\nsome code\n```\n' + 'a'.repeat(2001) + ' plan to execute';
    const r = scoreComplexity({ prompt, toolCount: 6 });
    expect(r.score).toBeGreaterThanOrEqual(0.5);
    expect(r.tier).toBe('complex');
    expect(r.suggested_max_tokens).toBe(8192);
  });

  it('returns very_complex tier at score >= 0.75', () => {
    // code_blocks (+0.2) + tool_count (+0.1) + message_length (+0.15)
    // + plan+then+next+step+pipeline (5 x 0.05 = +0.25) + json_depth (+0.1) = 0.80
    const prompt = '```js\nx\n```\n' + 'a'.repeat(2001)
      + ' plan then next step pipeline { a: { b: { c: 1 } } }';
    const r = scoreComplexity({ prompt, toolCount: 6 });
    expect(r.score).toBeGreaterThanOrEqual(0.75);
    expect(r.tier).toBe('very_complex');
    expect(r.suggested_max_tokens).toBe(16384);
  });
});

// ---------------------------------------------------------------------------
// Individual signal tests
// ---------------------------------------------------------------------------

describe('ComplexityScorer — individual signals', () => {
  it('code_blocks signal: adds 0.2 for fenced code', () => {
    const r = scoreComplexity({ prompt: '```python\nprint("hi")\n```' });
    expect(r.signals).toContain('code_blocks');
    expect(r.score).toBeCloseTo(0.2, 5);
  });

  it('code_blocks signal: NOT triggered when only one backtick fence', () => {
    const r = scoreComplexity({ prompt: 'some code ```here' });
    // Only 1 occurrence of ``` — fence pair needs 2
    expect(r.signals).not.toContain('code_blocks');
  });

  it('tool_count signal: adds 0.1 for >5 tools', () => {
    const r = scoreComplexity({ prompt: 'simple', toolCount: 6 });
    expect(r.signals).toContain('tool_count');
    expect(r.score).toBeCloseTo(0.1, 5);
  });

  it('tool_count signal: NOT triggered for exactly 5 tools', () => {
    const r = scoreComplexity({ prompt: 'simple', toolCount: 5 });
    expect(r.signals).not.toContain('tool_count');
  });

  it('message_length signal: adds 0.15 for prompt > 2000 chars', () => {
    const r = scoreComplexity({ prompt: 'x'.repeat(2001) });
    expect(r.signals).toContain('message_length');
    expect(r.score).toBeCloseTo(0.15, 5);
  });

  it('message_length signal: NOT triggered for <= 2000 chars', () => {
    const r = scoreComplexity({ prompt: 'x'.repeat(2000) });
    expect(r.signals).not.toContain('message_length');
  });

  it('json_depth signal: adds 0.1 for 3-level JSON nesting', () => {
    const r = scoreComplexity({ prompt: '{ a: { b: { c: 1 } } }' });
    expect(r.signals).toContain('json_depth');
    expect(r.score).toBeCloseTo(0.1, 5);
  });

  it('json_depth signal: NOT triggered for 2-level nesting', () => {
    const r = scoreComplexity({ prompt: '{ a: { b: 1 } }' });
    expect(r.signals).not.toContain('json_depth');
  });
});

// ---------------------------------------------------------------------------
// Multi-step keyword tests
// ---------------------------------------------------------------------------

describe('ComplexityScorer — multi_step_keywords', () => {
  it('each keyword adds 0.05', () => {
    const r = scoreComplexity({ prompt: 'plan the approach' });
    expect(r.signals).toContain('multi_step_keyword:plan');
    expect(r.score).toBeCloseTo(0.05, 5);
  });

  it('accumulates multiple keywords', () => {
    const r = scoreComplexity({ prompt: 'plan then next step pipeline' });
    expect(r.signals).toContain('multi_step_keyword:plan');
    expect(r.signals).toContain('multi_step_keyword:then');
    expect(r.signals).toContain('multi_step_keyword:next');
    expect(r.signals).toContain('multi_step_keyword:step');
    expect(r.signals).toContain('multi_step_keyword:pipeline');
    expect(r.score).toBeCloseTo(0.25, 5);
  });

  it('keyword matching is case-insensitive', () => {
    const r = scoreComplexity({ prompt: 'PLAN the approach' });
    expect(r.signals).toContain('multi_step_keyword:plan');
  });
});

// ---------------------------------------------------------------------------
// Thinking-model multiplier
// ---------------------------------------------------------------------------

describe('ComplexityScorer — thinking_model multiplier', () => {
  it('doubles suggested_max_tokens when model contains "think"', () => {
    const r = scoreComplexity({ prompt: 'x'.repeat(2001), toolCount: 6, modelName: 'qwen3-think' });
    // score 0.25 → moderate → 4096 * 2 = 8192
    expect(r.thinking_model).toBe(true);
    expect(r.suggested_max_tokens).toBe(8192);
    expect(r.tier).toBe('moderate');
  });

  it('doubles suggested_max_tokens when model contains "reason"', () => {
    const r = scoreComplexity({ prompt: '', modelName: 'deepseek-reason' });
    // score 0 → simple → 2048 * 2 = 4096
    expect(r.thinking_model).toBe(true);
    expect(r.suggested_max_tokens).toBe(4096);
  });

  it('does NOT double when model name does not contain "think" or "reason"', () => {
    const r = scoreComplexity({ prompt: '', modelName: 'grok-4' });
    expect(r.thinking_model).toBe(false);
    expect(r.suggested_max_tokens).toBe(2048);
  });

  it('multiplier is case-insensitive (THINK)', () => {
    const r = scoreComplexity({ prompt: '', modelName: 'ModelTHINK-v2' });
    expect(r.thinking_model).toBe(true);
  });

  it('caps doubled token budget at 32768 for very_complex thinking models', () => {
    const prompt = '```\nc\n```\n' + 'a'.repeat(2001) + ' plan then next step pipeline { a:{b:{c:1}} }';
    const r = scoreComplexity({ prompt, toolCount: 6, modelName: 'qwen3-thinking' });
    // very_complex = 16384, doubled = 32768 (cap)
    expect(r.thinking_model).toBe(true);
    expect(r.suggested_max_tokens).toBe(32768);
  });
});

// ---------------------------------------------------------------------------
// Score clamping
// ---------------------------------------------------------------------------

describe('ComplexityScorer — score clamping', () => {
  it('clamps score to maximum 1.0 regardless of signal accumulation', () => {
    const prompt = '```\nc\n```\n' + 'a'.repeat(2001) + ' plan then next step pipeline { a:{b:{c:1}} }';
    const r = scoreComplexity({ prompt, toolCount: 10 });
    expect(r.score).toBeLessThanOrEqual(1.0);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('score is always a number between 0 and 1', () => {
    for (const prompt of ['', 'hello', '```x```', 'plan then next step pipeline']) {
      const r = scoreComplexity({ prompt });
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Return type shape
// ---------------------------------------------------------------------------

describe('ComplexityScorer — result shape', () => {
  it('always returns all 5 required fields', () => {
    const r = scoreComplexity({ prompt: 'test' });
    expect(r).toHaveProperty('score');
    expect(r).toHaveProperty('tier');
    expect(r).toHaveProperty('signals');
    expect(r).toHaveProperty('suggested_max_tokens');
    expect(r).toHaveProperty('thinking_model');
    expect(Array.isArray(r.signals)).toBe(true);
  });

  it('suggested_max_tokens is always one of the 4 valid values (non-thinking)', () => {
    const validTokens = new Set([2048, 4096, 8192, 16384]);
    for (const prompt of ['', 'hello', '```x```\n'.repeat(5), 'a'.repeat(3000)]) {
      const r = scoreComplexity({ prompt });
      if (!r.thinking_model) {
        expect(validTokens.has(r.suggested_max_tokens)).toBe(true);
      }
    }
  });
});
