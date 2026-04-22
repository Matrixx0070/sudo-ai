/**
 * @file tests/channels/slack-real.test.ts
 * @description Tests for slack-real-connector.ts — vault-based Slack Bot Token.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

// Mock vault-credentials
vi.mock('../../src/core/security/vault-credentials.js', () => ({
  CredentialStore: class {
    constructor(_ns: string) {}
    async getCredential(_url: string) { return null; }
  },
}));

describe('slack-real-connector — no token configured', () => {
  beforeEach(() => {
    delete process.env['SLACK_BOT_TOKEN'];
    delete process.env['SLACK_TOKEN'];
  });

  it('slackPostMessage returns not-configured when no token', async () => {
    const { slackPostMessage } = await import('../../src/core/channels/slack-real-connector.js');
    const result = await slackPostMessage('C01234ABCD', 'hello');
    expect(result.success).toBe(false);
    expect(result.output).toContain('Slack not configured');
  });
});

describe('slack-real-connector — token from env', () => {
  beforeEach(() => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-testtoken';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ts: '1234567890.000001', channel: 'C01234ABCD' }),
    } as unknown as Response);
  });

  afterEach(() => {
    delete process.env['SLACK_BOT_TOKEN'];
    vi.restoreAllMocks();
  });

  it('slackPostMessage returns success=true with ts', async () => {
    const { slackPostMessage } = await import('../../src/core/channels/slack-real-connector.js');
    const result = await slackPostMessage('C01234ABCD', 'Hello World');
    expect(result.success).toBe(true);
    expect(result.ts).toBe('1234567890.000001');
    expect(result.channel).toBe('C01234ABCD');
  });

  it('sends to correct endpoint with Bearer auth', async () => {
    const { slackPostMessage } = await import('../../src/core/channels/slack-real-connector.js');
    await slackPostMessage('C01234ABCD', 'test');

    const fetchArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchArgs![0] as string;
    const opts = fetchArgs![1] as RequestInit;

    expect(url).toContain('chat.postMessage');
    expect((opts.headers as Record<string, string>)['Authorization']).toContain('xoxb-testtoken');
  });

  it('handles Slack API error gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    } as unknown as Response);

    const { slackPostMessage } = await import('../../src/core/channels/slack-real-connector.js');
    const result = await slackPostMessage('INVALID', 'msg');
    expect(result.success).toBe(false);
    expect(result.output).toContain('channel_not_found');
  });

  it('handles HTTP error gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as unknown as Response);

    const { slackPostMessage } = await import('../../src/core/channels/slack-real-connector.js');
    const result = await slackPostMessage('C01234ABCD', 'test');
    expect(result.success).toBe(false);
    expect(result.output).toContain('503');
  });
});

describe('slack-real-connector — validation', () => {
  beforeEach(() => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
  });
  afterEach(() => {
    delete process.env['SLACK_BOT_TOKEN'];
  });

  it('returns error when channelId is empty', async () => {
    const { slackPostMessage } = await import('../../src/core/channels/slack-real-connector.js');
    const result = await slackPostMessage('', 'test message');
    expect(result.success).toBe(false);
    expect(result.output).toContain('channelId');
  });

  it('returns error when text is empty', async () => {
    const { slackPostMessage } = await import('../../src/core/channels/slack-real-connector.js');
    const result = await slackPostMessage('C01234', '');
    expect(result.success).toBe(false);
    expect(result.output).toContain('text');
  });
});

describe('comms.slack-rt tool', () => {
  beforeEach(() => {
    delete process.env['SLACK_BOT_TOKEN'];
  });

  it('requires channel_id', async () => {
    const { slackRtTool } = await import('../../src/core/tools/builtin/comms/slack-rt.js');
    const result = await slackRtTool.execute(
      { text: 'hello' }, // missing channel_id
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof slackRtTool.execute>[1],
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('channel_id');
  });

  it('requires text', async () => {
    const { slackRtTool } = await import('../../src/core/tools/builtin/comms/slack-rt.js');
    const result = await slackRtTool.execute(
      { channel_id: 'C01234' }, // missing text
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof slackRtTool.execute>[1],
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('text');
  });
});
