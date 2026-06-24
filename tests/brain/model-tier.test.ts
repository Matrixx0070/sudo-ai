/**
 * @file model-tier.test.ts
 * @description Locks in the model-tier classifier — the foundation of adaptive
 * amplification ("Mythos with any LLM"). Contract: recognized small/local/cheap
 * models classify 'weak'; top models 'frontier'; everything unknown 'strong'
 * (the safe, no-amplification default). An env override wins; weak markers beat
 * frontier markers so a "-mini" variant is treated as weak.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  classifyModelTier,
  getAmplificationProfile,
  isAdaptiveAmplifyEnabled,
} from '../../src/core/brain/model-tier.js';

afterEach(() => {
  delete process.env['SUDO_MODEL_TIER_OVERRIDE'];
  delete process.env['SUDO_ADAPTIVE_AMPLIFY'];
});

describe('classifyModelTier', () => {
  const frontier = [
    'claude-oauth/opus',
    'anthropic/claude-opus-4-8',
    'openai/gpt-5',
    'anthropic/claude-fable-5',
    'google/gemini-2.5-pro',
    'xai/grok-4',
  ];
  for (const m of frontier) {
    it(`frontier: ${m}`, () => expect(classifyModelTier(m)).toBe('frontier'));
  }

  const weak = [
    'ollama/llama3.2',
    'anthropic/claude-haiku-4-5',
    'ollama/qwen2.5:7b',
    'ollama/gemma2:9b',
    'openrouter/glm-4-flash',
    'groq/llama-3.1-8b',
    'openai/gpt-5-mini', // weak marker beats frontier marker
  ];
  for (const m of weak) {
    it(`weak: ${m}`, () => expect(classifyModelTier(m)).toBe('weak'));
  }

  const strong = [
    'anthropic/claude-sonnet-4-6',
    'ollama/kimi-k2',
    'openrouter/z-ai/glm-4.6',
    'xai/grok-3',
    'deepseek/deepseek-v3',
    'openai/gpt-4o',
  ];
  for (const m of strong) {
    it(`strong: ${m}`, () => expect(classifyModelTier(m)).toBe('strong'));
  }

  it('unknown / empty / null → strong (safe default)', () => {
    expect(classifyModelTier(undefined)).toBe('strong');
    expect(classifyModelTier(null)).toBe('strong');
    expect(classifyModelTier('')).toBe('strong');
    expect(classifyModelTier('some-unrecognized-model')).toBe('strong');
  });

  it('SUDO_MODEL_TIER_OVERRIDE wins over detection', () => {
    process.env['SUDO_MODEL_TIER_OVERRIDE'] = 'weak';
    expect(classifyModelTier('claude-oauth/opus')).toBe('weak');
    process.env['SUDO_MODEL_TIER_OVERRIDE'] = 'frontier';
    expect(classifyModelTier('ollama/llama3.2')).toBe('frontier');
  });

  it('an invalid override is ignored (falls back to detection)', () => {
    process.env['SUDO_MODEL_TIER_OVERRIDE'] = 'banana';
    expect(classifyModelTier('claude-oauth/opus')).toBe('frontier');
  });
});

describe('getAmplificationProfile', () => {
  it('weak → all amplifiers on', () => {
    const p = getAmplificationProfile('ollama/llama3.2');
    expect(p).toEqual({
      tier: 'weak',
      promptScaffolding: true,
      forceVerifyGate: true,
      preferDebateOnHighStakes: true,
    });
  });
  it('frontier → no amplifiers', () => {
    const p = getAmplificationProfile('claude-oauth/opus');
    expect(p.tier).toBe('frontier');
    expect(p.promptScaffolding).toBe(false);
    expect(p.forceVerifyGate).toBe(false);
    expect(p.preferDebateOnHighStakes).toBe(false);
  });
  it('strong (default) → no amplifiers', () => {
    expect(getAmplificationProfile('anthropic/claude-sonnet-4-6').promptScaffolding).toBe(false);
  });
});

describe('isAdaptiveAmplifyEnabled — default on, kill-switch off', () => {
  it('on by default', () => expect(isAdaptiveAmplifyEnabled()).toBe(true));
  it('off when SUDO_ADAPTIVE_AMPLIFY=0', () => {
    process.env['SUDO_ADAPTIVE_AMPLIFY'] = '0';
    expect(isAdaptiveAmplifyEnabled()).toBe(false);
  });
});
