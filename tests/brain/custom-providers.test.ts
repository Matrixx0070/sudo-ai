/**
 * Tests for pluggable custom providers (gap #27) — wire-config registry.
 * F97: the ai-SDK instance half (getCustomProvider/resolveCustomModel/getModel
 * integration) is retired with legacy providers.ts; the IR transport consumes
 * getCustomProviderWireConfig instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerCustomProvider,
  registerCustomProvidersFromEnv,
  isCustomProvider,
  getCustomProviderWireConfig,
  listCustomProviders,
  clearCustomProviders,
} from '../../src/llm/custom-providers.js';

const RESERVED = new Set<string>([
  'ollama', 'xai', 'openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together',
]);

beforeEach(() => clearCustomProviders());
afterEach(() => {
  clearCustomProviders();
  delete process.env['SUDO_CUSTOM_PROVIDERS'];
});

describe('registerCustomProvider', () => {
  it('registers a valid OpenAI-compatible provider', () => {
    const ok = registerCustomProvider(
      { name: 'myllm', baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' },
      RESERVED,
    );
    expect(ok).toBe(true);
    expect(isCustomProvider('myllm')).toBe(true);
    expect(listCustomProviders()).toEqual(['myllm']);
    expect(getCustomProviderWireConfig('myllm')).toEqual({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test', adapter: 'openai' });
  });

  it('reads the key from apiKeyEnv', () => {
    process.env['MY_LLM_KEY'] = 'sk-env';
    try {
      expect(
        registerCustomProvider(
          { name: 'envllm', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'MY_LLM_KEY' },
          RESERVED,
        ),
      ).toBe(true);
    } finally {
      delete process.env['MY_LLM_KEY'];
    }
  });

  it('rejects a name that collides with a built-in', () => {
    expect(registerCustomProvider({ name: 'openai', baseURL: 'https://x/v1', apiKey: 'k' }, RESERVED)).toBe(false);
    expect(isCustomProvider('openai')).toBe(false);
  });

  it('rejects an invalid name (incl. uppercase, slash, empty)', () => {
    expect(registerCustomProvider({ name: 'bad name!', baseURL: 'https://x/v1', apiKey: 'k' }, RESERVED)).toBe(false);
    expect(registerCustomProvider({ name: '', baseURL: 'https://x/v1', apiKey: 'k' }, RESERVED)).toBe(false);
    // Slash would break "provider/model-id" splitting.
    expect(registerCustomProvider({ name: 'my/provider', baseURL: 'https://x/v1', apiKey: 'k' }, RESERVED)).toBe(false);
    // Uppercase is rejected so it can't slip past the lowercase reserved set
    // and shadow a built-in (e.g. "OpenAI" → "openai").
    expect(registerCustomProvider({ name: 'OpenAI', baseURL: 'https://x/v1', apiKey: 'k' }, RESERVED)).toBe(false);
    expect(isCustomProvider('OpenAI')).toBe(false);
  });

  it('rejects an invalid or non-http(s) baseURL', () => {
    expect(registerCustomProvider({ name: 'a', baseURL: 'not a url', apiKey: 'k' }, RESERVED)).toBe(false);
    expect(registerCustomProvider({ name: 'b', baseURL: 'ftp://host/v1', apiKey: 'k' }, RESERVED)).toBe(false);
  });

  it('rejects when no API key is available', () => {
    expect(registerCustomProvider({ name: 'nokey', baseURL: 'https://x/v1' }, RESERVED)).toBe(false);
    expect(registerCustomProvider({ name: 'nokey2', baseURL: 'https://x/v1', apiKeyEnv: 'DOES_NOT_EXIST_X' }, RESERVED)).toBe(false);
  });

  it('rejects a duplicate name', () => {
    expect(registerCustomProvider({ name: 'dup', baseURL: 'https://x/v1', apiKey: 'k' }, RESERVED)).toBe(true);
    expect(registerCustomProvider({ name: 'dup', baseURL: 'https://y/v1', apiKey: 'k2' }, RESERVED)).toBe(false);
  });

  it('allows plaintext http for localhost', () => {
    expect(registerCustomProvider({ name: 'local', baseURL: 'http://localhost:1234/v1', apiKey: 'k' }, RESERVED)).toBe(true);
  });
});

describe('registerCustomProvidersFromEnv', () => {
  it('registers entries from a JSON array', () => {
    process.env['SUDO_CUSTOM_PROVIDERS'] = JSON.stringify([
      { name: 'p1', baseURL: 'https://a/v1', apiKey: 'k1' },
      { name: 'p2', baseURL: 'https://b/v1', apiKey: 'k2' },
    ]);
    expect(registerCustomProvidersFromEnv(RESERVED)).toBe(2);
    expect(listCustomProviders().sort()).toEqual(['p1', 'p2']);
  });

  it('is a no-op when unset', () => {
    delete process.env['SUDO_CUSTOM_PROVIDERS'];
    expect(registerCustomProvidersFromEnv(RESERVED)).toBe(0);
    expect(listCustomProviders()).toEqual([]);
  });

  it('ignores invalid JSON', () => {
    process.env['SUDO_CUSTOM_PROVIDERS'] = '{not json';
    expect(registerCustomProvidersFromEnv(RESERVED)).toBe(0);
  });

  it('ignores a non-array value', () => {
    process.env['SUDO_CUSTOM_PROVIDERS'] = JSON.stringify({ name: 'x' });
    expect(registerCustomProvidersFromEnv(RESERVED)).toBe(0);
  });

  it('skips bad entries but registers good ones', () => {
    process.env['SUDO_CUSTOM_PROVIDERS'] = JSON.stringify([
      { name: 'good', baseURL: 'https://a/v1', apiKey: 'k' },
      { name: 'openai', baseURL: 'https://b/v1', apiKey: 'k' }, // reserved
      { name: 'nokey', baseURL: 'https://c/v1' }, // no key
    ]);
    expect(registerCustomProvidersFromEnv(RESERVED)).toBe(1);
    expect(listCustomProviders()).toEqual(['good']);
  });
});

describe('custom provider adapters (wire configs)', () => {
  it('defaults to the openai adapter', () => {
    registerCustomProvider({ name: 'defadapter', baseURL: 'https://x/v1', apiKey: 'k' }, RESERVED);
    expect(getCustomProviderWireConfig('defadapter')?.adapter).toBe('openai');
  });

  it('registers an anthropic-shaped endpoint with its wire config', () => {
    const ok = registerCustomProvider(
      { name: 'myanthropic', baseURL: 'https://anthropic-proxy.example/v1', apiKey: 'sk-test', adapter: 'anthropic' },
      RESERVED,
    );
    expect(ok).toBe(true);
    expect(isCustomProvider('myanthropic')).toBe(true);
    expect(getCustomProviderWireConfig('myanthropic')).toEqual({
      baseURL: 'https://anthropic-proxy.example/v1',
      apiKey: 'sk-test',
      adapter: 'anthropic',
    });
  });

  it('accepts a google-shaped endpoint for config compatibility (transport rejects per-call)', () => {
    expect(
      registerCustomProvider(
        { name: 'mygemini', baseURL: 'https://gemini-proxy.example/v1', apiKey: 'sk-test', adapter: 'google' },
        RESERVED,
      ),
    ).toBe(true);
    expect(getCustomProviderWireConfig('mygemini')?.adapter).toBe('google');
  });

  it('rejects an unknown adapter (from env JSON)', () => {
    process.env['SUDO_CUSTOM_PROVIDERS'] = JSON.stringify([
      { name: 'badadapter', baseURL: 'https://x/v1', apiKey: 'k', adapter: 'cohere' },
    ]);
    expect(registerCustomProvidersFromEnv(RESERVED)).toBe(0);
    expect(isCustomProvider('badadapter')).toBe(false);
  });

  it('getCustomProviderWireConfig returns null for an unregistered provider', () => {
    expect(getCustomProviderWireConfig('not-registered')).toBeNull();
  });
});
