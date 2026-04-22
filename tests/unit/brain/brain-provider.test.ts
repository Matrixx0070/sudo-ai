/**
 * Unit tests for the brain providers layer and ModelFailover.
 * Real LLM APIs are NEVER called — all external SDKs are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all AI SDK providers so no real network calls happen
// ---------------------------------------------------------------------------

vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, provider: 'xai' }));
    return provider;
  }),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, provider: 'openai' }));
    return provider;
  }),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, provider: 'anthropic' }));
    return provider;
  }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => {
    const provider = vi.fn((modelId: string) => ({ modelId, provider: 'google' }));
    return provider;
  }),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({
    text: 'mocked response',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  })),
  streamText: vi.fn(() => ({
    textStream: (async function* () { yield 'mock stream'; })(),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
  })),
  tool: vi.fn((opts: unknown) => opts),
  jsonSchema: vi.fn((s: unknown) => s),
}));

// Import LLMError and ModelFailover AFTER mocks are set up
import { LLMError } from '../../../src/core/shared/errors.js';
import { ModelFailover } from '../../../src/core/brain/failover.js';

// ---------------------------------------------------------------------------
// ModelFailover tests
// ---------------------------------------------------------------------------

describe('ModelFailover', () => {
  it('constructs with a list of valid model strings', () => {
    const failover = new ModelFailover(['xai/grok-3-fast', 'openai/gpt-4o']);
    expect(failover).toBeDefined();
  });

  it('throws LLMError when constructed with empty array', () => {
    expect(() => new ModelFailover([])).toThrow(LLMError);
  });

  it('throws LLMError when constructed with empty array — checks message', () => {
    expect(() => new ModelFailover([])).toThrow('at least one model string');
  });

  it('throws LLMError when model string does not contain /', () => {
    expect(() => new ModelFailover(['no-slash-here'])).toThrow(LLMError);
  });

  it('throws when model string has no slash — checks message', () => {
    expect(() => new ModelFailover(['no-slash-here'])).toThrow('Invalid model string');
  });

  it('getNextProfile returns the highest priority model', () => {
    const failover = new ModelFailover(['xai/grok-3-fast', 'openai/gpt-4o']);
    const profile = failover.getNextProfile();
    expect(profile).not.toBeNull();
    expect(profile?.id).toBe('xai/grok-3-fast');
  });

  it('recordSuccess resets consecutive errors to 0', () => {
    const failover = new ModelFailover(['xai/grok-3-fast']);
    failover.recordError('xai/grok-3-fast', 'rate_limit');
    failover.recordSuccess('xai/grok-3-fast');

    const status = failover.getStatus();
    const modelStatus = status.find((s) => s.id === 'xai/grok-3-fast');
    expect(modelStatus?.consecutiveErrors).toBe(0);
  });

  it('recordError puts model in cooldown', () => {
    const failover = new ModelFailover(['xai/grok-3-fast', 'openai/gpt-4o-mini']);
    failover.recordError('xai/grok-3-fast', 'rate_limit');

    const status = failover.getStatus();
    const xaiStatus = status.find((s) => s.id === 'xai/grok-3-fast');
    expect(xaiStatus?.cooldownUntil).toBeGreaterThan(Date.now() - 1);
  });

  it('getStatus returns all registered profiles', () => {
    const failover = new ModelFailover(['xai/grok-3-fast', 'openai/gpt-4o']);
    const status = failover.getStatus();
    expect(status).toHaveLength(2);
  });

  it('disables model permanently on auth_permanent error', () => {
    const failover = new ModelFailover(['xai/grok-3-fast', 'openai/gpt-4o-mini']);
    failover.recordError('xai/grok-3-fast', 'auth_permanent');

    const status = failover.getStatus();
    const xaiStatus = status.find((s) => s.id === 'xai/grok-3-fast');
    expect(xaiStatus?.disabled).toBe(true);
  });

  it('categorizeError maps 429 to rate_limit', () => {
    const failover = new ModelFailover(['xai/grok-3-fast']);
    expect(failover.categorizeError(429, undefined)).toBe('rate_limit');
  });

  it('categorizeError maps 503 to overloaded', () => {
    const failover = new ModelFailover(['xai/grok-3-fast']);
    expect(failover.categorizeError(503, undefined)).toBe('overloaded');
  });

  it('categorizeError maps 402 to billing', () => {
    const failover = new ModelFailover(['xai/grok-3-fast']);
    expect(failover.categorizeError(402, undefined)).toBe('billing');
  });

  it('categorizeError maps 401 to auth', () => {
    const failover = new ModelFailover(['xai/grok-3-fast']);
    expect(failover.categorizeError(401, undefined)).toBe('auth');
  });
});

// ---------------------------------------------------------------------------
// Provider utility functions
// ---------------------------------------------------------------------------

describe('Brain providers — getModel / getEnvKeyForProvider', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['XAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  it('getEnvKeyForProvider returns correct env key for xai', async () => {
    const { getEnvKeyForProvider } = await import('../../../src/core/brain/providers.js');
    expect(getEnvKeyForProvider('xai')).toBe('XAI_API_KEY');
  });

  it('getEnvKeyForProvider returns correct env key for openai', async () => {
    const { getEnvKeyForProvider } = await import('../../../src/core/brain/providers.js');
    expect(getEnvKeyForProvider('openai')).toBe('OPENAI_API_KEY');
  });

  it('getEnvKeyForProvider returns correct env key for anthropic', async () => {
    const { getEnvKeyForProvider } = await import('../../../src/core/brain/providers.js');
    expect(getEnvKeyForProvider('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('getModel throws LLMError for model string without slash', async () => {
    process.env['XAI_API_KEY'] = 'test-key';
    const { initProviders, getModel } = await import('../../../src/core/brain/providers.js');
    await initProviders();
    expect(() => getModel('no-slash')).toThrow(LLMError);
  });

  it('getModel throws for model string without slash — checks message', async () => {
    const { getModel } = await import('../../../src/core/brain/providers.js');
    expect(() => getModel('no-slash')).toThrow('Invalid model string');
  });

  it('getModel throws LLMError for empty model string', async () => {
    const { getModel } = await import('../../../src/core/brain/providers.js');
    expect(() => getModel('')).toThrow(LLMError);
  });

  it('getModel throws LLMError for unknown provider', async () => {
    const { getModel } = await import('../../../src/core/brain/providers.js');
    expect(() => getModel('unknownprovider/some-model')).toThrow(LLMError);
  });

  it('getModel throws for unknown provider — checks message', async () => {
    const { getModel } = await import('../../../src/core/brain/providers.js');
    expect(() => getModel('unknownprovider/some-model')).toThrow('Unknown provider');
  });

  it('listAvailableProviders returns array', async () => {
    process.env['XAI_API_KEY'] = 'test-key';
    const { initProviders, listAvailableProviders } = await import('../../../src/core/brain/providers.js');
    await initProviders();
    const available = listAvailableProviders();
    expect(Array.isArray(available)).toBe(true);
  });

  it('initProviders succeeds even with no env keys set', async () => {
    const keys = ['XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY'];
    for (const k of keys) delete process.env[k];

    const { initProviders } = await import('../../../src/core/brain/providers.js');
    await expect(initProviders()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Brain class — construction and non-LLM methods
// ---------------------------------------------------------------------------

describe('Brain class — construction and persona/mood', () => {
  beforeEach(() => {
    process.env['XAI_API_KEY'] = 'test-api-key';
  });

  afterEach(() => {
    delete process.env['XAI_API_KEY'];
    vi.clearAllMocks();
  });

  it('constructs without throwing when given a valid config', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    const { validConfig } = await import('../../helpers/fixtures.js');
    expect(() => new Brain(validConfig)).not.toThrow();
  });

  it('constructs without throwing when config is null (env-only mode)', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    expect(() => new Brain(null)).not.toThrow();
  });

  it('setPersona() does not throw for valid persona types', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    const brain = new Brain(null);
    expect(() => brain.setPersona('coder')).not.toThrow();
    expect(() => brain.setPersona('researcher')).not.toThrow();
    expect(() => brain.setPersona('assistant')).not.toThrow();
  });

  it('setMood() does not throw for valid mood types', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    const brain = new Brain(null);
    expect(() => brain.setMood('focused')).not.toThrow();
    expect(() => brain.setMood('analytical')).not.toThrow();
  });

  it('getSystemPrompt() returns a non-empty string', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    const brain = new Brain(null);
    const prompt = await brain.getSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('getFailoverStatus() returns an array', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    const brain = new Brain(null);
    const status = brain.getFailoverStatus();
    expect(Array.isArray(status)).toBe(true);
  });

  it('call() throws LLMError when messages is empty', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    const brain = new Brain(null);
    await expect(brain.call({ messages: [] })).rejects.toThrow(LLMError);
  });

  it('call() rejects with an error containing "non-empty" for empty messages', async () => {
    const { Brain } = await import('../../../src/core/brain/brain.js');
    const brain = new Brain(null);
    await expect(brain.call({ messages: [] })).rejects.toThrow('non-empty');
  });
});
