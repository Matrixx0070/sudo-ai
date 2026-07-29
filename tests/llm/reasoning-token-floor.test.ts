/**
 * 2026-07-29 outage. Reasoning models on the OpenAI-compatible wire emit
 * `reasoning` tokens BEFORE `content`. Below a floor, the entire output budget
 * goes to thinking and the reply is `content:'' finish_reason:'length'` — a
 * truncation that downstream cannot tell apart from a dead provider.
 *
 * ollama/glm-5.2:cloud was the ONLY live profile (four claude-oauth profiles
 * 403'd on an org-level OAuth block; gemini 429'd). Measured on the raw wire at
 * max_tokens 64: 5/5 empty content, reasoning 213-252 tokens. Through the app:
 * 8/10 empty. Each empty burned the failover chain and surfaced as "The AI
 * providers are all temporarily unavailable"; the brain-liveness probe hit it
 * every cycle and reported "no provider is answering" — manufacturing the very
 * outage it was reporting.
 */
import { describe, it, expect } from 'vitest';
import { isReasoningModel, REASONING_MIN_OUTPUT_TOKENS } from '../../src/llm/limits.js';

describe('isReasoningModel', () => {
  it('identifies the model that took prod down', () => {
    expect(isReasoningModel('ollama/glm-5.2:cloud')).toBe(true);
  });

  it('covers future point releases, not just the exact id', () => {
    expect(isReasoningModel('ollama/glm-5.3:cloud')).toBe(true);
    expect(isReasoningModel('ollama/glm-6:cloud')).toBe(true);
  });

  it('covers the other reasoning families in the chain', () => {
    expect(isReasoningModel('ollama/kimi-k2.7-code:cloud')).toBe(true);
    expect(isReasoningModel('openai/o4-mini')).toBe(true);
    expect(isReasoningModel('ollama/deepseek-r1:cloud')).toBe(true);
  });

  it('does NOT sweep in ordinary models — the floor must not apply broadly', () => {
    expect(isReasoningModel('anthropic/claude-opus-4-8')).toBe(false);
    expect(isReasoningModel('google/gemini-2.5-flash')).toBe(false);
    expect(isReasoningModel('ollama/llama3.2')).toBe(false);
    expect(isReasoningModel('openai/gpt-4o')).toBe(false);
  });
});

describe('REASONING_MIN_OUTPUT_TOKENS', () => {
  it('clears the observed reasoning length with room for an answer', () => {
    // Raw-wire measurement: reasoning consumed 213-252 tokens before any
    // content. A floor at or below that reproduces the outage.
    expect(REASONING_MIN_OUTPUT_TOKENS).toBeGreaterThan(252);
    expect(REASONING_MIN_OUTPUT_TOKENS).toBe(1024);
  });

  it('the liveness probe budget that failed is below the floor', () => {
    // The probe sent tier:'fast' with no explicit maxTokens and got empty
    // content every cycle. Any budget under the floor is now raised.
    expect(64).toBeLessThan(REASONING_MIN_OUTPUT_TOKENS);
    expect(150).toBeLessThan(REASONING_MIN_OUTPUT_TOKENS);
  });
});
