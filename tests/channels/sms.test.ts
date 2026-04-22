/**
 * @file sms.test.ts
 * @description Unit tests for SmsAdapter.
 *
 * Tests:
 *  1.  Constructor builds with valid env
 *  2.  Missing TWILIO_ACCOUNT_SID throws ChannelError on start()
 *  3.  Missing TWILIO_AUTH_TOKEN throws ChannelError on start()
 *  4.  Duplicate start() is idempotent
 *  5.  Webhook: valid signature dispatches message
 *  6.  Webhook: invalid signature returns 403 (no dispatch)
 *  7.  Webhook: non-POST method returns 405
 *  8.  Allowlist: SMS from allowed number is in the set
 *  9.  Allowlist: SMS from non-allowed number returns 403
 * 10.  Rate-limit: denied peer returns 429
 * 11.  Inbound dispatch: correct UnifiedMessage shape
 * 12.  Outbound send: messages.create called with correct from/to/body
 * 13.  Outbound send: missing TWILIO_FROM_NUMBER throws ChannelError
 * 14.  Hook emission: message:sent emitted on outbound
 * 15.  stop() closes server cleanly
 * 16.  Security: pino log does NOT include raw auth token on Twilio error
 * 17.  Security: empty webhook secret throws ChannelError on start()
 * 18.  Security: body size limit rejects 70 KB POST with 400
 * 19.  Security: SMS replay — same MessageSid twice returns 200 but not dispatched
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Hoist mock variables so they are initialized before vi.mock factories run
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockMessagesCreate = vi.fn().mockResolvedValue({ sid: 'SM123' });
  const mockTwilioInstance = {
    messages: { create: mockMessagesCreate },
  };
  const mockValidateRequest = vi.fn().mockReturnValue(true);
  const TwilioConstructor = vi.fn().mockImplementation(() => mockTwilioInstance);
  // @ts-expect-error — adding static method to mock constructor
  TwilioConstructor.validateRequest = mockValidateRequest;

  const mockRateLimiterCheck = vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 19,
    burstWarned: false,
  });

  // Logger spy — captures all log.error calls for security assertions.
  const mockLogError = vi.fn();
  const mockLogWarn = vi.fn();
  const mockLogDebug = vi.fn();
  const mockLogInfo = vi.fn();
  const mockLogger = {
    error: mockLogError,
    warn: mockLogWarn,
    debug: mockLogDebug,
    info: mockLogInfo,
  };

  return {
    mockMessagesCreate,
    mockTwilioInstance,
    mockValidateRequest,
    TwilioConstructor,
    mockRateLimiterCheck,
    mockLogError,
    mockLogWarn,
    mockLogDebug,
    mockLogInfo,
    mockLogger,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('twilio', () => ({
  default: mocks.TwilioConstructor,
}));

vi.mock('../../src/core/security/vault.js', () => ({
  vault: {
    get: vi.fn().mockRejectedValue(new Error('key_not_found')),
  },
}));

vi.mock('../../src/core/channels/rate-limit.js', () => ({
  rateLimiter: {
    check: mocks.mockRateLimiterCheck,
    reset: vi.fn(),
  },
}));

// Mock shared/index.js to intercept log calls for security assertions.
vi.mock('../../src/core/shared/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/shared/index.js')>();
  return {
    ...original,
    createLogger: () => mocks.mockLogger,
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { SmsAdapter } from '../../src/core/channels/sms.js';
import { ChannelError } from '../../src/core/shared/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setValidSmsEnv(): void {
  process.env['TWILIO_ACCOUNT_SID'] = 'ACtest1234567890123456789012345678';
  process.env['TWILIO_AUTH_TOKEN'] = 'auth-token-secret';
  process.env['TWILIO_FROM_NUMBER'] = '+15005550006';
  process.env['TWILIO_WEBHOOK_PORT'] = '0'; // OS-assigned port
  process.env['TWILIO_WEBHOOK_SECRET'] = 'webhook-secret';
}

function clearSmsEnv(): void {
  delete process.env['TWILIO_ACCOUNT_SID'];
  delete process.env['TWILIO_AUTH_TOKEN'];
  delete process.env['TWILIO_FROM_NUMBER'];
  delete process.env['TWILIO_WEBHOOK_PORT'];
  delete process.env['TWILIO_WEBHOOK_SECRET'];
  delete process.env['SMS_ALLOWED_NUMBERS'];
}

async function postWebhook(
  adapter: SmsAdapter,
  body: Record<string, string>,
  signature = 'valid-sig',
): Promise<{ status: number; responseBody: string }> {
  const server = (adapter as unknown as { _server: http.Server | null })._server;
  if (!server) throw new Error('Server not started');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const bodyStr = Object.entries(body)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/sms',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyStr),
          'x-twilio-signature': signature,
          'host': `127.0.0.1:${port}`,
          'x-forwarded-proto': 'http',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, responseBody: data }));
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmsAdapter', () => {
  let adapter: SmsAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    clearSmsEnv();
    mocks.mockValidateRequest.mockReturnValue(true);
    mocks.TwilioConstructor.mockImplementation(() => mocks.mockTwilioInstance);
    // @ts-expect-error — re-attach static after clearAllMocks
    mocks.TwilioConstructor.validateRequest = mocks.mockValidateRequest;
    mocks.mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });
    mocks.mockRateLimiterCheck.mockResolvedValue({
      allowed: true,
      remaining: 19,
      burstWarned: false,
    });
    // Re-attach logger methods after clearAllMocks.
    mocks.mockLogger.error = mocks.mockLogError;
    mocks.mockLogger.warn = mocks.mockLogWarn;
    mocks.mockLogger.debug = mocks.mockLogDebug;
    mocks.mockLogger.info = mocks.mockLogInfo;
  });

  afterEach(async () => {
    if (adapter?.isConnected) {
      await adapter.stop();
    }
    clearSmsEnv();
  });

  // 1. Constructor builds
  it('constructs without error', () => {
    expect(() => new SmsAdapter()).not.toThrow();
  });

  // 2. Missing TWILIO_ACCOUNT_SID → ChannelError
  it('throws ChannelError on start() when TWILIO_ACCOUNT_SID is missing', async () => {
    adapter = new SmsAdapter();
    await expect(adapter.start()).rejects.toThrow(ChannelError);
  });

  // 3. Missing TWILIO_AUTH_TOKEN → ChannelError
  it('throws ChannelError on start() when TWILIO_AUTH_TOKEN is missing', async () => {
    process.env['TWILIO_ACCOUNT_SID'] = 'ACtest';
    // vault rejects, no env set
    adapter = new SmsAdapter();
    await expect(adapter.start()).rejects.toThrow(ChannelError);
  });

  // 4. Duplicate start() is idempotent
  it('is idempotent on duplicate start()', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    await adapter.start();
    expect(adapter.isConnected).toBe(true);

    await adapter.start(); // second call — should no-op
    expect(adapter.isConnected).toBe(true);
    expect(mocks.TwilioConstructor).toHaveBeenCalledTimes(1);
  });

  // 5. Valid signature dispatches message
  it('dispatches message when webhook signature is valid', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    await adapter.start();

    mocks.mockValidateRequest.mockReturnValue(true);

    const result = await postWebhook(adapter, {
      From: '+15005550001',
      To: '+15005550006',
      Body: 'Hello!',
      MessageSid: 'SM001',
    });

    await new Promise(setImmediate);

    expect(result.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].peerId).toBe('+15005550001');
    expect(handler.mock.calls[0][0].text).toBe('Hello!');
  });

  // 6. Invalid signature returns 403
  it('returns 403 and does not dispatch when signature is invalid', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    mocks.mockValidateRequest.mockReturnValue(false);

    const result = await postWebhook(adapter, {
      From: '+15005550001',
      Body: 'hack attempt',
    }, 'bad-signature');

    await new Promise(setImmediate);

    expect(result.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  // 7. Non-POST method returns 405
  it('returns 405 for non-POST HTTP methods', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    await adapter.start();

    const server = (adapter as unknown as { _server: http.Server | null })._server!;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/sms', method: 'GET' },
        (res) => {
          resolve({ status: res.statusCode ?? 0 });
          res.resume();
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(result.status).toBe(405);
  });

  // 8. Allowlist: allowed numbers are in the set
  it('includes allowed numbers in the set', () => {
    setValidSmsEnv();
    process.env['SMS_ALLOWED_NUMBERS'] = '+15005550001,+15005550002';
    adapter = new SmsAdapter();
    const set = (adapter as unknown as { _allowedNumbers: Set<string> })._allowedNumbers;
    expect(set.has('+15005550001')).toBe(true);
    expect(set.has('+15005550002')).toBe(true);
  });

  // 9. Allowlist: non-allowed number returns 403
  it('returns 403 for SMS from non-allowed number', async () => {
    setValidSmsEnv();
    process.env['SMS_ALLOWED_NUMBERS'] = '+15005550001';
    adapter = new SmsAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    mocks.mockValidateRequest.mockReturnValue(true);

    const result = await postWebhook(adapter, {
      From: '+19999999999',
      Body: 'hi',
    });

    await new Promise(setImmediate);

    expect(result.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  // 10. Rate-limit: denied peer returns 429
  it('returns 429 when rate limit is exceeded', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    mocks.mockValidateRequest.mockReturnValue(true);
    mocks.mockRateLimiterCheck.mockResolvedValue({
      allowed: false,
      remaining: 0,
      burstWarned: false,
      retryAfterMs: 5000,
    });

    const result = await postWebhook(adapter, {
      From: '+15005550001',
      Body: 'spam',
    });

    await new Promise(setImmediate);

    expect(result.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  // 11. Inbound dispatch: correct UnifiedMessage shape
  it('dispatches correctly shaped UnifiedMessage on inbound SMS', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    await adapter.start();

    mocks.mockValidateRequest.mockReturnValue(true);

    await postWebhook(adapter, {
      From: '+15005550002',
      To: '+15005550006',
      Body: 'Test SMS body',
      MessageSid: 'SM999',
    });

    await new Promise(setImmediate);

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg.channel).toBe('sms');
    expect(msg.chatType).toBe('dm');
    expect(msg.peerId).toBe('+15005550002');
    expect(msg.text).toBe('Test SMS body');
    expect(msg.id).toBe('SM999');
  });

  // 12. Outbound send: messages.create called correctly
  it('calls messages.create with correct from/to/body', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    await adapter.start();

    await adapter.send('+15005550003', 'Hello back!');

    expect(mocks.mockMessagesCreate).toHaveBeenCalledWith({
      from: '+15005550006',
      to: '+15005550003',
      body: 'Hello back!',
    });
  });

  // 13. Missing TWILIO_FROM_NUMBER → ChannelError
  it('throws ChannelError when TWILIO_FROM_NUMBER is missing', async () => {
    setValidSmsEnv();
    delete process.env['TWILIO_FROM_NUMBER'];
    adapter = new SmsAdapter();
    await adapter.start();

    await expect(adapter.send('+15005550003', 'hi')).rejects.toThrow(ChannelError);
  });

  // 14. Hook emission: message:sent on outbound
  it('emits message:sent hook after successful send()', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    await adapter.start();

    const hookEmit = vi.fn().mockResolvedValue(undefined);
    adapter.setHookEmitter({ emit: hookEmit });

    await adapter.send('+15005550003', 'hi');

    await new Promise(setImmediate);
    expect(hookEmit).toHaveBeenCalledWith(
      'message:sent',
      expect.objectContaining({ event: 'message:sent', channel: 'sms' }),
    );
  });

  // 15. stop() closes HTTP server cleanly
  it('closes HTTP server and sets isConnected=false on stop()', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    await adapter.start();
    expect(adapter.isConnected).toBe(true);

    await adapter.stop();
    expect(adapter.isConnected).toBe(false);

    const server = (adapter as unknown as { _server: http.Server | null })._server;
    expect(server).toBeNull();
  });

  // 16. Security: pino log does NOT include raw auth token on Twilio AxiosError
  it('does not log auth token when Twilio send throws with AxiosError-like error', async () => {
    setValidSmsEnv();
    const TOKEN = 'auth-token-secret'; // matches TWILIO_AUTH_TOKEN in setValidSmsEnv

    // Build a fake AxiosError with Authorization header containing base64(SID:TOKEN).
    const fakeAxiosError = new Error('Request failed with status code 401');
    (fakeAxiosError as unknown as Record<string, unknown>).config = {
      headers: {
        Authorization: `Basic ${Buffer.from(`ACtest:${TOKEN}`).toString('base64')}`,
      },
    };
    mocks.mockMessagesCreate.mockRejectedValue(fakeAxiosError);

    adapter = new SmsAdapter();
    await adapter.start();

    await expect(adapter.send('+15005550003', 'hi')).rejects.toBeDefined();

    // Inspect all log.error calls — none should contain the raw token value.
    const allLogCalls = mocks.mockLogError.mock.calls;
    expect(allLogCalls.length).toBeGreaterThan(0);
    for (const callArgs of allLogCalls) {
      const serialized = JSON.stringify(callArgs);
      expect(serialized).not.toContain(TOKEN);
      // The err field should be a string, not a raw object.
      const logObj = callArgs[0] as Record<string, unknown>;
      if ('err' in logObj) {
        expect(typeof logObj['err']).toBe('string');
      }
    }
  });

  // 17. Security: empty webhook secret throws ChannelError on start()
  it('throws ChannelError when TWILIO_WEBHOOK_SECRET resolves to empty string', async () => {
    setValidSmsEnv();
    // Override: set TWILIO_WEBHOOK_SECRET to empty string (not undefined).
    // authToken is also set — but webhookSecret ?? authToken preserves '' since '' is not nullish.
    // Wait: '' ?? authToken = authToken because '' ?? x = x is WRONG.
    // Actually '' ?? 'fallback' = '' (nullish coalescing only falls through on null/undefined).
    // So webhookSecret='' -> this._webhookSecret = '' -> guard fires.
    process.env['TWILIO_WEBHOOK_SECRET'] = '';
    adapter = new SmsAdapter();
    await expect(adapter.start()).rejects.toThrow(ChannelError);
  });

  // 18. Security: body size limit rejects oversized POST with 400
  it('returns 400 when webhook body exceeds 64 KB', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    await adapter.start();

    const server = (adapter as unknown as { _server: http.Server | null })._server!;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    // Send 70 KB body.
    const largeBody = 'x'.repeat(70_000);

    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/sms',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(largeBody),
            'x-twilio-signature': 'valid-sig',
            'host': `127.0.0.1:${port}`,
          },
        },
        (res) => {
          resolve({ status: res.statusCode ?? 0 });
          res.resume();
        },
      );
      // Handle socket destroy (server calls req.destroy() on oversized body)
      req.on('error', () => resolve({ status: 400 }));
      req.write(largeBody);
      req.end();
    });

    expect(result.status).toBe(400);
  });

  // 19. Security: SMS replay — same MessageSid twice is 200 + not dispatched second time
  it('silently 200s a duplicate MessageSid without dispatching to handler', async () => {
    setValidSmsEnv();
    adapter = new SmsAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    await adapter.start();

    mocks.mockValidateRequest.mockReturnValue(true);

    // First delivery — should dispatch.
    const result1 = await postWebhook(adapter, {
      From: '+15005550001',
      To: '+15005550006',
      Body: 'Hello',
      MessageSid: 'SM_REPLAY_TEST',
    });
    await new Promise(setImmediate);
    expect(result1.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    // Second delivery with same MessageSid — should 200 but NOT dispatch.
    const result2 = await postWebhook(adapter, {
      From: '+15005550001',
      To: '+15005550006',
      Body: 'Hello',
      MessageSid: 'SM_REPLAY_TEST',
    });
    await new Promise(setImmediate);
    expect(result2.status).toBe(200);
    // Handler still called only once total.
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
