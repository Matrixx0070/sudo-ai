import { describe, it, expect, afterEach } from 'vitest';
import { modelGenerationOf, currentModelGeneration } from '../../src/llm/aliases.js';

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe('G-MODELGEN — modelGenerationOf', () => {
  it('derives family + major version, dropping point releases', () => {
    expect(modelGenerationOf('anthropic/claude-opus-4-8')).toBe('anthropic/opus-4');
    expect(modelGenerationOf('anthropic/claude-opus-4-9')).toBe('anthropic/opus-4'); // point bump = same gen
    expect(modelGenerationOf('anthropic/claude-haiku-4-5-20251001')).toBe('anthropic/haiku-4');
    expect(modelGenerationOf('xai/grok-4-fast-reasoning')).toBe('xai/grok-4');
    expect(modelGenerationOf('openai/gpt-4o')).toBe('openai/gpt-4');
    expect(modelGenerationOf('ollama/llama3.2')).toBe('ollama/llama-3');
  });

  it('a MAJOR bump is a different generation (the succession trigger)', () => {
    expect(modelGenerationOf('anthropic/claude-opus-4-8')).not.toBe(modelGenerationOf('anthropic/claude-opus-5'));
    expect(modelGenerationOf('anthropic/claude-opus-5')).toBe('anthropic/opus-5');
  });

  it('handles bare + unknown model strings without throwing', () => {
    expect(modelGenerationOf('mystery-model')).toBe('mystery'); // no family/version → first token
    expect(modelGenerationOf('custom/weird-2-thing')).toBe('custom/weird-2');
  });

  it('currentModelGeneration follows the frontier alias + its env override', () => {
    delete process.env['LLM_ALIAS_FRONTIER'];
    expect(currentModelGeneration()).toBe('anthropic/opus-4'); // default frontier = opus-4-8
    process.env['LLM_ALIAS_FRONTIER'] = 'anthropic/claude-opus-5';
    expect(currentModelGeneration()).toBe('anthropic/opus-5');
  });
});
