/**
 * @file tests/llm/aliases.test.ts
 * @description Covers src/llm/aliases.ts: non-alias passthrough, the default
 * mapping for every sudo/* alias, env override precedence (LLM_ALIAS_FRONTIER),
 * and the isSudoAlias type guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveAlias, isSudoAlias, SUDO_ALIASES } from '../../src/llm/aliases.js';

/** Env override keys for every alias — saved/cleared so ambient env cannot skew results. */
const OVERRIDE_KEYS = SUDO_ALIASES.map(
  (a) => `LLM_ALIAS_${a.slice('sudo/'.length).toUpperCase()}`,
);
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of OVERRIDE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of OVERRIDE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('resolveAlias', () => {
  it('passes non-alias model strings through unchanged', () => {
    expect(resolveAlias('xai/grok-4-fast-reasoning')).toBe('xai/grok-4-fast-reasoning');
    expect(resolveAlias('gpt-4o')).toBe('gpt-4o');
    expect(resolveAlias('sudo/not-a-real-tier')).toBe('sudo/not-a-real-tier');
    expect(resolveAlias('')).toBe('');
  });

  it('maps each sudo/* alias to its documented default', () => {
    expect(resolveAlias('sudo/local')).toBe('ollama/llama3.2');
    expect(resolveAlias('sudo/cheap')).toBe('xai/grok-4-fast-non-reasoning');
    expect(resolveAlias('sudo/mid')).toBe('xai/grok-4-fast-reasoning');
    expect(resolveAlias('sudo/frontier')).toBe('anthropic/claude-opus-4-8');
    expect(resolveAlias('sudo/embed')).toBe('openai/text-embedding-3-small');
    expect(resolveAlias('sudo/vision')).toBe('xai/grok-4-fast');
  });

  it('resolves every declared alias to a non-empty provider/model string', () => {
    for (const alias of SUDO_ALIASES) {
      const resolved = resolveAlias(alias);
      expect(resolved).not.toBe(alias);
      expect(resolved).toMatch(/^[a-z0-9-]+\/.+/);
    }
  });

  it('env override (LLM_ALIAS_FRONTIER) wins over the default', () => {
    process.env['LLM_ALIAS_FRONTIER'] = 'openai/gpt-5';
    expect(resolveAlias('sudo/frontier')).toBe('openai/gpt-5');
  });

  it('a blank env override is ignored (falls back to the default)', () => {
    process.env['LLM_ALIAS_FRONTIER'] = '   ';
    expect(resolveAlias('sudo/frontier')).toBe('anthropic/claude-opus-4-8');
  });

  it('env override values are trimmed', () => {
    process.env['LLM_ALIAS_CHEAP'] = '  google/gemini-3-flash  ';
    expect(resolveAlias('sudo/cheap')).toBe('google/gemini-3-flash');
  });
});

describe('isSudoAlias', () => {
  it('returns true for every declared alias', () => {
    for (const alias of SUDO_ALIASES) expect(isSudoAlias(alias)).toBe(true);
  });

  it('returns false for non-aliases', () => {
    expect(isSudoAlias('sudo/unknown')).toBe(false);
    expect(isSudoAlias('xai/grok-4')).toBe(false);
    expect(isSudoAlias('')).toBe(false);
  });
});
