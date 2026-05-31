/**
 * @file tests/channels/github-issues.test.ts
 * @description Tests for github-issues.ts — GitHub Issues REST API wrapper.
 *
 * Tests:
 *   1. isConfigured returns false when no token/repo configured
 *   2. isConfigured returns true when GITHUB_TOKEN and owner/repo set
 *   3. createIssue sends correct POST request with auth header
 *   4. createIssue returns structured result with issue data
 *   5. searchIssues builds correct query with labels filter
 *   6. searchIssues handles open/closed/all state filter
 *   7. addComment sends POST to correct endpoint
 *   8. closeIssue sends PATCH with state: closed
 *   9. addLabel sends POST to labels endpoint
 *   10. Rate limit 429 response handled correctly
 *   11. GitHub API error response handled correctly
 *   12. getRateLimitStatus fetches rate limit info
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

// Mock vault-credentials to avoid disk access in tests
vi.mock('../../src/core/security/vault-credentials.js', () => ({
  CredentialStore: class {
    constructor(_ns: string) {}
    async getCredential(_url: string) { return null; }
  },
}));

// Mock child_process for git remote resolution
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers(headers),
    json: async () => data,
    text: async () => JSON.stringify(data),
    url: 'https://api.github.com/test',
    redirected: false,
    type: 'basic' as ResponseType,
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    clone: () => makeFetchResponse(data, status, headers),
  } as Response;
}

function makeRateLimitHeaders(remaining: number): Record<string, string> {
  return {
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-limit': '5000',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubIssuesConnector', () => {
  let originalToken: string | undefined;
  let originalOwner: string | undefined;
  let originalRepo: string | undefined;

  beforeEach(() => {
    originalToken = process.env['GITHUB_TOKEN'];
    originalOwner = process.env['GITHUB_OWNER'];
    originalRepo = process.env['GITHUB_REPO'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore env vars
    if (originalToken === undefined) {
      delete process.env['GITHUB_TOKEN'];
    } else {
      process.env['GITHUB_TOKEN'] = originalToken;
    }

    if (originalOwner === undefined) {
      delete process.env['GITHUB_OWNER'];
    } else {
      process.env['GITHUB_OWNER'] = originalOwner;
    }

    if (originalRepo === undefined) {
      delete process.env['GITHUB_REPO'];
    } else {
      process.env['GITHUB_REPO'] = originalRepo;
    }

    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Test 1: isConfigured returns false when no token/repo configured
  // -------------------------------------------------------------------------
  it('Test 1: isConfigured returns false when no token/repo configured', async () => {
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_OWNER'];
    delete process.env['GITHUB_REPO'];

    const { exec } = await import('child_process');
    (exec as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('no git remote');
    });

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();
    await connector.initialize();

    expect(connector.isConfigured()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2: isConfigured returns true when GITHUB_TOKEN and owner/repo set
  // -------------------------------------------------------------------------
  it('Test 2: isConfigured returns true when GITHUB_TOKEN and owner/repo set', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();
    await connector.initialize();

    expect(connector.isConfigured()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: createIssue sends correct POST request with auth header
  // -------------------------------------------------------------------------
  it('Test 3: createIssue sends correct POST request with auth header', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    const mockIssue = {
      number: 42,
      title: 'Test Issue',
      body: 'Test body',
      state: 'open',
      labels: [],
      assignees: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      html_url: 'https://github.com/testowner/testrepo/issues/42',
    };

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(mockIssue, 201, makeRateLimitHeaders(4999)),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.createIssue({
      title: 'Test Issue',
      body: 'Test body',
      labels: ['bug'],
      assignees: ['testuser'],
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/testowner/testrepo/issues',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_test_token_123',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = callArgs![1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      title: 'Test Issue',
      body: 'Test body',
      labels: ['bug'],
      assignees: ['testuser'],
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: createIssue returns structured result with issue data
  // -------------------------------------------------------------------------
  it('Test 4: createIssue returns structured result with issue data', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    const mockIssue = {
      number: 42,
      title: 'Test Issue',
      body: 'Test body',
      state: 'open',
      labels: [{ name: 'bug' }],
      assignees: [{ login: 'testuser' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      html_url: 'https://github.com/testowner/testrepo/issues/42',
    };

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(mockIssue, 201, makeRateLimitHeaders(4999)),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.createIssue({
      title: 'Test Issue',
      body: 'Test body',
    });

    expect(result.success).toBe(true);
    expect(result.issue?.number).toBe(42);
    expect(result.issue?.title).toBe('Test Issue');
    expect(result.rateLimitRemaining).toBe(4999);
  });

  // -------------------------------------------------------------------------
  // Test 5: searchIssues builds correct query with labels filter
  // -------------------------------------------------------------------------
  it('Test 5: searchIssues builds correct query with labels filter', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    const mockSearchResult = {
      total_count: 2,
      items: [
        {
          number: 42,
          title: 'Bug 1',
          body: 'Description',
          state: 'open',
          labels: [{ name: 'bug' }],
          assignees: [],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          html_url: 'https://github.com/testowner/testrepo/issues/42',
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(mockSearchResult, 200, makeRateLimitHeaders(4998)),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.searchIssues({
      labels: ['bug', 'critical'],
    });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.issues?.length).toBe(1);

    // Verify query construction
    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = callArgs![0] as string;
    expect(url).toContain('q=repo%3Atestowner%2Ftestrepo');
    expect(url).toContain('label%3A%22bug%22');
    expect(url).toContain('label%3A%22critical%22');
  });

  // -------------------------------------------------------------------------
  // Test 6: searchIssues handles open/closed/all state filter
  // -------------------------------------------------------------------------
  it('Test 6: searchIssues handles state filter correctly', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    const mockSearchResult = { total_count: 0, items: [] };

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(mockSearchResult, 200, makeRateLimitHeaders(4997)),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    await connector.searchIssues({ state: 'closed' });

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = callArgs![0] as string;
    expect(url).toContain('is%3Aclosed');
  });

  // -------------------------------------------------------------------------
  // Test 7: addComment sends POST to correct endpoint
  // -------------------------------------------------------------------------
  it('Test 7: addComment sends POST to correct endpoint', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    const mockComment = {
      id: 12345,
      url: 'https://api.github.com/repos/testowner/testrepo/issues/comments/12345',
    };

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(mockComment, 201, makeRateLimitHeaders(4996)),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.addComment(42, 'Test comment body');

    expect(result.success).toBe(true);
    expect(result.comment?.id).toBe(12345);

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = callArgs![0] as string;
    expect(url).toBe('https://api.github.com/repos/testowner/testrepo/issues/42/comments');

    const options = callArgs![1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ body: 'Test comment body' });
  });

  // -------------------------------------------------------------------------
  // Test 8: closeIssue sends PATCH with state: closed
  // -------------------------------------------------------------------------
  it('Test 8: closeIssue sends PATCH with state: closed', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    const mockIssue = {
      number: 42,
      title: 'Fixed Issue',
      body: 'Fixed',
      state: 'closed',
      labels: [],
      assignees: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      html_url: 'https://github.com/testowner/testrepo/issues/42',
    };

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(mockIssue, 200, makeRateLimitHeaders(4995)),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.closeIssue(42);

    expect(result.success).toBe(true);
    expect(result.issue?.state).toBe('closed');

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = callArgs![0] as string;
    expect(url).toBe('https://api.github.com/repos/testowner/testrepo/issues/42');

    const options = callArgs![1] as RequestInit;
    expect(options.method).toBe('PATCH');

    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ state: 'closed' });
  });

  // -------------------------------------------------------------------------
  // Test 9: addLabel sends POST to labels endpoint
  // -------------------------------------------------------------------------
  it('Test 9: addLabel sends POST to labels endpoint', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse([], 200, makeRateLimitHeaders(4994)),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.addLabel(42, 'auto-fix');

    expect(result.success).toBe(true);

    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = callArgs![0] as string;
    expect(url).toBe('https://api.github.com/repos/testowner/testrepo/issues/42/labels');

    const options = callArgs![1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ labels: ['auto-fix'] });
  });

  // -------------------------------------------------------------------------
  // Test 10: Rate limit 429 response handled correctly
  // -------------------------------------------------------------------------
  it('Test 10: Rate limit 429 response handled correctly', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(
        { message: 'API rate limit exceeded' },
        429,
        {
          'x-ratelimit-remaining': '0',
          'retry-after': '60',
        },
      ),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.createIssue({
      title: 'Test',
      body: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('rate limit exceeded');
    expect(result.rateLimitRemaining).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 11: GitHub API error response handled correctly
  // -------------------------------------------------------------------------
  it('Test 11: GitHub API error response handled correctly', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';
    process.env['GITHUB_OWNER'] = 'testowner';
    process.env['GITHUB_REPO'] = 'testrepo';

    global.fetch = vi.fn().mockResolvedValueOnce(
      makeFetchResponse(
        { message: 'Validation Failed', errors: [{ field: 'title', code: 'missing_field' }] },
        422,
        makeRateLimitHeaders(4993),
      ),
    );

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const result = await connector.createIssue({
      title: '', // Invalid: empty title
      body: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('422');
  });

  // -------------------------------------------------------------------------
  // Test 12: getRateLimitStatus fetches rate limit info
  // -------------------------------------------------------------------------
  it('Test 12: getRateLimitStatus fetches rate limit info', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_test_token_123';

    const mockRateLimit = {
      resources: {
        core: {
          limit: 5000,
          remaining: 4950,
          reset: Math.floor(Date.now() / 1000) + 3600,
          used: 50,
        },
      },
    };

    global.fetch = vi.fn().mockResolvedValueOnce(makeFetchResponse(mockRateLimit, 200));

    const { GitHubIssuesConnector } = await import('../../src/core/channels/github-issues.js');
    const connector = new GitHubIssuesConnector();

    const status = await connector.getRateLimitStatus();

    expect(status).toBeDefined();
    expect(status?.limit).toBe(5000);
    expect(status?.remaining).toBe(4950);
    expect(status?.used).toBe(50);
  });
});

describe('GitHubApiError', () => {
  it('creates error with status property', async () => {
    const { GitHubApiError } = await import('../../src/core/channels/github-issues.js');
    const err = new GitHubApiError(404, 'Not Found');
    expect(err.status).toBe(404);
    expect(err.message).toContain('404');
    expect(err.name).toBe('GitHubApiError');
  });
});

describe('RateLimitError', () => {
  it('creates error with rate limit details', async () => {
    const { RateLimitError } = await import('../../src/core/channels/github-issues.js');
    const err = new RateLimitError('Rate limited', 0, 60);
    expect(err.status).toBe(429);
    expect(err.remaining).toBe(0);
    expect(err.retryAfterSeconds).toBe(60);
    expect(err.name).toBe('RateLimitError');
  });
});
