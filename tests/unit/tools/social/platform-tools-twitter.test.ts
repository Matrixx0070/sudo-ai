/**
 * Unit tests for platform-tools.ts — Twitter branch (ITEM 7).
 *
 * ITEM 7: When Twitter returns non-JSON (e.g. HTML gateway error on 502),
 * the branch must record { success: false, error: 'Twitter API returned non-JSON (HTTP 502)' }
 * rather than letting a SyntaxError bubble unhandled.
 *
 * fetch is mocked via vi.stubGlobal. No real network calls are made.
 * A minimal in-memory ScheduleDispatcher is initialized to satisfy the
 * module-level import without DB side-effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initializeSchema } from '../../../../src/core/memory/schema.js';
import {
  ScheduleDispatcher,
  setDispatcherInstance,
} from '../../../../src/core/social/schedule-dispatcher.js';
import { multiPostTool } from '../../../../src/core/tools/builtin/social/platform-tools.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'twitter-test-session',
    workingDir: '/tmp',
    config: {} as ToolContext['config'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ToolContext['logger'],
    signal: undefined,
    ...overrides,
  };
}

/** Create a mock Response that returns a non-JSON body with the given status. */
function makeNonJsonResponse(status: number, bodyText: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: vi.fn().mockResolvedValue(bodyText),
    // json() mimics the real fetch behavior: parsing '<html>...' throws SyntaxError
    json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
  } as unknown as Response;
}

/** Create a mock Response returning valid JSON. */
function makeJsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let db: DatabaseType;
let originalToken: string | undefined;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  setDispatcherInstance(new ScheduleDispatcher(db));

  originalToken = process.env['TWITTER_OAUTH2_TOKEN'];
  process.env['TWITTER_OAUTH2_TOKEN'] = 'test-twitter-token-xyz';
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env['TWITTER_OAUTH2_TOKEN'];
  } else {
    process.env['TWITTER_OAUTH2_TOKEN'] = originalToken;
  }
  db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ITEM 7 — Twitter non-JSON response handling
// ---------------------------------------------------------------------------

describe('ITEM 7 — Twitter branch non-JSON response', () => {
  it('records success:false with normalized message on HTML 502, no unhandled SyntaxError', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeNonJsonResponse(502, '<html><body>Bad Gateway</body></html>'),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await multiPostTool.execute(
      { content: 'test post', platforms: ['twitter'] },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    const twitterResult = (result.data as Record<string, unknown>)?.['twitter'] as Record<string, unknown>;
    expect(twitterResult).toBeDefined();
    expect(twitterResult['success']).toBe(false);
    expect(twitterResult['error']).toBe('Twitter API returned non-JSON (HTTP 502)');
  });

  it('records success:false with normalized message on HTML 503', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeNonJsonResponse(503, '<html>Service Unavailable</html>'),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await multiPostTool.execute(
      { content: 'test post 503', platforms: ['twitter'] },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    const twitterResult = (result.data as Record<string, unknown>)?.['twitter'] as Record<string, unknown>;
    expect(twitterResult['success']).toBe(false);
    expect(twitterResult['error']).toBe('Twitter API returned non-JSON (HTTP 503)');
  });

  it('records success:false with normalized message on plain-text 401', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeNonJsonResponse(401, 'Unauthorized'),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await multiPostTool.execute(
      { content: 'auth failure post', platforms: ['twitter'] },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    const twitterResult = (result.data as Record<string, unknown>)?.['twitter'] as Record<string, unknown>;
    expect(twitterResult['success']).toBe(false);
    expect(twitterResult['error']).toBe('Twitter API returned non-JSON (HTTP 401)');
  });

  it('the overall ToolResult output includes the error message string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeNonJsonResponse(502, '<html>502</html>'),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await multiPostTool.execute(
      { content: 'output test', platforms: ['twitter'] },
      makeCtx(),
    );

    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('Errors:');
    expect(result.output).toContain('twitter:');
  });
});

// ---------------------------------------------------------------------------
// Twitter branch — happy path (JSON response)
// ---------------------------------------------------------------------------

describe('Twitter branch — happy path', () => {
  it('returns success:true with tweetId on valid 201 JSON response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(201, { data: { id: 'tweet-id-999' } }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await multiPostTool.execute(
      { content: 'happy tweet', platforms: ['twitter'] },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const twitterResult = (result.data as Record<string, unknown>)?.['twitter'] as Record<string, unknown>;
    expect(twitterResult['success']).toBe(true);
    expect(twitterResult['tweetId']).toBe('tweet-id-999');
  });

  it('records success:false when Twitter JSON contains errors array', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(400, { errors: [{ message: 'Tweet text too long.' }] }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await multiPostTool.execute(
      { content: 'error tweet', platforms: ['twitter'] },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    const twitterResult = (result.data as Record<string, unknown>)?.['twitter'] as Record<string, unknown>;
    expect(twitterResult['success']).toBe(false);
    expect(twitterResult['error']).toBe('Tweet text too long.');
  });

  it('returns success:false with missing TWITTER_OAUTH2_TOKEN', async () => {
    delete process.env['TWITTER_OAUTH2_TOKEN'];
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await multiPostTool.execute(
      { content: 'no token test', platforms: ['twitter'] },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    const twitterResult = (result.data as Record<string, unknown>)?.['twitter'] as Record<string, unknown>;
    expect(twitterResult['success']).toBe(false);
    expect(twitterResult['error']).toContain('TWITTER_OAUTH2_TOKEN');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
