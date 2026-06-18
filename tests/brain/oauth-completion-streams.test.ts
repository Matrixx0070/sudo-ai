/**
 * @file tests/brain/oauth-completion-streams.test.ts
 * @description brain.call() must STREAM claude-oauth completions.
 *
 * A non-streaming generateText holds claude-oauth response headers until the
 * whole completion finishes, tripping the provider's fast-fail headers timer
 * (providers.ts, default 45s) on long Opus turns — a false stall. This is the
 * same trap PRs #277-#279 fixed in the coder tools; the central brain.call()
 * path (highest-frequency caller: consciousness) had the same defect. The fix
 * routes claude-oauth completions through streamText so headers land in ~1-2s
 * and the body-idle guard bounds a mid-stream stall.
 *
 * Every other provider keeps the buffered generateText path unchanged, so the
 * existing rotation / prompt-cache tests (xai/anthropic profiles) are untouched.
 *
 * These exercise the private `_completeOnce` routing directly so they don't need
 * live OAuth credentials or a real getModel handle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock, streamText: streamTextMock };
});

// Provider SDK mocks so brain.ts loads without real network/provider setup.
vi.mock('@ai-sdk/xai', () => ({ createXai: vi.fn(() => vi.fn((id: string) => ({ modelId: id }))) }));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const p = vi.fn((id: string) => ({ modelId: id }));
    (p as unknown as { chat: unknown }).chat = vi.fn((id: string) => ({ modelId: id }));
    return p;
  }),
}));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: vi.fn(() => vi.fn((id: string) => ({ modelId: id }))) }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn(() => vi.fn((id: string) => ({ modelId: id }))) }));

import { Brain } from '../../src/core/brain/brain.js';

interface StreamShape {
  text?: string;
  toolCalls?: unknown[];
  usage?: unknown;
  finishReason?: string;
  reasoning?: unknown;
  reasoningText?: string;
  providerMetadata?: unknown;
}

/** A streamText-shaped result whose aggregate accessors are resolved promises. */
function streamOk(s: StreamShape = {}) {
  return {
    text: Promise.resolve(s.text ?? ''),
    toolCalls: Promise.resolve(s.toolCalls ?? []),
    usage: Promise.resolve(s.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
    finishReason: Promise.resolve(s.finishReason ?? 'stop'),
    reasoning: Promise.resolve(s.reasoning),
    reasoningText: Promise.resolve(s.reasoningText),
    providerMetadata: Promise.resolve(s.providerMetadata),
  };
}

const CALL_PARAMS = { model: { modelId: 'm' }, messages: [], temperature: 0.5, maxOutputTokens: 100 };

describe('Brain: claude-oauth completions stream (PR #277-#279 trap on brain.call())', () => {
  const FLAG = 'SUDO_BRAIN_OAUTH_STREAM_DISABLE';
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    delete process.env[FLAG];
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  it('OAUTH-1: claude-oauth routes through streamText, never generateText', async () => {
    streamTextMock.mockReturnValueOnce(streamOk({ text: 'opus streamed', finishReason: 'stop' }));
    const brain = new Brain(null);

    const res = await (brain as any)._completeOnce('claude-oauth', { ...CALL_PARAMS });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(res.text).toBe('opus streamed');
    expect(res.finishReason).toBe('stop');
  });

  it('OAUTH-2: non-oauth providers keep the buffered generateText path', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'buffered', toolCalls: [], usage: {}, finishReason: 'stop' });
    const brain = new Brain(null);

    const res = await (brain as any)._completeOnce('xai', { ...CALL_PARAMS });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(res.text).toBe('buffered');
  });

  it('OAUTH-3: kill-switch forces claude-oauth back onto generateText', async () => {
    process.env[FLAG] = '1';
    generateTextMock.mockResolvedValueOnce({ text: 'legacy', toolCalls: [], usage: {}, finishReason: 'stop' });
    const brain = new Brain(null);

    const res = await (brain as any)._completeOnce('claude-oauth', { ...CALL_PARAMS });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(res.text).toBe('legacy');
  });

  it('OAUTH-4: a post-completion providerMetadata rejection does not fail a served call', async () => {
    const rejected = Promise.reject(new Error('metadata unavailable'));
    rejected.catch(() => { /* avoid unhandled-rejection noise */ });
    streamTextMock.mockReturnValueOnce({ ...streamOk({ text: 'served' }), providerMetadata: rejected });
    const brain = new Brain(null);

    const res = await (brain as any)._completeOnce('claude-oauth', { ...CALL_PARAMS });

    expect(res.text).toBe('served');
    expect(res.providerMetadata).toBeUndefined();
  });

  it('OAUTH-5: an essential-aggregate rejection propagates (real call failure)', async () => {
    const boom = Promise.reject(new Error('stream broke'));
    boom.catch(() => { /* asserted via rejects below */ });
    streamTextMock.mockReturnValueOnce({ ...streamOk({ text: 'x' }), text: boom });
    const brain = new Brain(null);

    await expect((brain as any)._completeOnce('claude-oauth', { ...CALL_PARAMS })).rejects.toThrow('stream broke');
  });
});
