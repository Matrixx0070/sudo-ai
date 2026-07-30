/**
 * @file tests/llm/vision-claude-oauth.test.ts
 * @description The Claude OAuth seat leg of visionIR (2026-07-31): tried FIRST
 * (seat-covered), builds an Anthropic messages body with an image block from a
 * data: URL, and falls through to the metered xai leg on failure. The manager
 * module is mocked so no real token/store is touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/llm/claude-oauth-manager.js', () => ({
  getClaudeOAuthManager: () => ({
    getAccessToken: () => 'test-oauth-token',
    refreshToken: async () => true,
  }),
}));

import { visionIR } from '../../src/llm/client.js';

const DATA_URL = 'data:image/png;base64,QUJD'; // "ABC"
const ENV_KEYS = ['XAI_API_KEY', 'OPENAI_API_KEY', 'LLM_BASE_URL', 'SUDO_VISION_CLAUDE_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

function anthropicOk(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => '',
  } as unknown as Response;
}

function openaiOk(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }] }),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.unstubAllGlobals();
});

describe('visionIR — claude-oauth seat leg', () => {
  it('tries the seat first: anthropic wire, oauth bearer, base64 image block from a data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk('a red pixel'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await visionIR({ caller: 't', purpose: 't', imageUrl: DATA_URL, prompt: 'what is it?' });
    expect(res.text).toBe('a red pixel');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('api.anthropic.com/v1/messages');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-oauth-token');
    expect(headers['anthropic-beta']).toContain('oauth');
    const body = JSON.parse(String((init as RequestInit).body));
    const blocks = body.messages[0].content;
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    expect(body.system?.[0]?.text ?? '').not.toBe(''); // OAuth attestation applied
  });

  it('falls through to the xai leg when the seat call fails', async () => {
    process.env['XAI_API_KEY'] = 'xai-test-key';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce(openaiOk('from xai'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await visionIR({ caller: 't', purpose: 't', imageUrl: DATA_URL, prompt: 'what is it?' });
    expect(res.text).toBe('from xai');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('api.x.ai');
  });
});
