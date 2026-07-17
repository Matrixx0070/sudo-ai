import { describe, it, expect, afterEach } from 'vitest';
import { providerOf, isIndependentJudge, resolveJudgeModel, judgeFor } from '../../src/llm/judge.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('G-JUDGE — judge route independence', () => {
  it('providerOf extracts the provider prefix', () => {
    expect(providerOf('anthropic/claude-haiku-4-5')).toBe('anthropic');
    expect(providerOf('xai/grok-4-fast')).toBe('xai');
    expect(providerOf('bareModel')).toBe('baremodel');
  });

  it('a judge is independent iff different provider AND different model', () => {
    expect(isIndependentJudge('anthropic/claude-haiku', 'xai/grok-4')).toBe(true);
    expect(isIndependentJudge('xai/grok-4-fast', 'xai/grok-4-fast-reasoning')).toBe(false); // same provider
    expect(isIndependentJudge('xai/grok-4', 'xai/grok-4')).toBe(false); // identical
  });

  it('the default judge is anthropic (distinct from the xai cheap/mid tier)', () => {
    delete process.env['LLM_ALIAS_JUDGE'];
    expect(providerOf(resolveJudgeModel())).toBe('anthropic');
  });

  it('LLM_ALIAS_JUDGE overrides the judge model', () => {
    process.env['LLM_ALIAS_JUDGE'] = 'openai/gpt-judge';
    expect(resolveJudgeModel()).toBe('openai/gpt-judge');
  });

  it('judgeFor returns the judge when independent of all routes under test', () => {
    delete process.env['LLM_ALIAS_JUDGE']; // anthropic default
    const v = judgeFor(['sudo/cheap', 'sudo/mid']); // both xai
    expect(v.available).toBe(true);
    if (v.available) expect(providerOf(v.judgeModel)).toBe('anthropic');
  });

  it('judgeFor HOLDS for human review when the judge shares a provider with a route under test', () => {
    delete process.env['LLM_ALIAS_JUDGE']; // anthropic default
    // sudo/frontier is anthropic — same provider as the judge → not independent.
    const v = judgeFor(['sudo/cheap', 'sudo/frontier']);
    expect(v.available).toBe(false);
    if (!v.available) expect(v.reason).toMatch(/not independent|human review/);
  });

  it('single-provider fleet (judge == tier provider) holds', () => {
    process.env['LLM_ALIAS_JUDGE'] = 'xai/grok-4-fast-non-reasoning'; // same as cheap tier
    const v = judgeFor(['sudo/cheap']);
    expect(v.available).toBe(false);
  });
});
