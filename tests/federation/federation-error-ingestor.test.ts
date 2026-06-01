/**
 * @file tests/federation/federation-error-ingestor.test.ts
 * @description FederationErrorIngestor unit tests — Wave 2.
 *
 * Tests:
 *   FED-ERR-1  Happy path: new report → creates GitHub issue
 *   FED-ERR-2  Dedup within 24h: same signature from same peer → no duplicate issue
 *   FED-ERR-3  Dedup across peers: same signature, different peer → adds comment to existing issue
 *   FED-ERR-4  GitHub not configured: still stores report, no issue created
 *   FED-ERR-5  GitHub search fails: fail-open, still stores report
 *   FED-ERR-6  Query by peerId
 *   FED-ERR-7  Query by signature
 *   FED-ERR-8  Query with limit
 *   FED-ERR-9  Destroy cleanup
 *   FED-ERR-10 Disabled via env var
 *   FED-ERR-11 Called after destroy() → returns early
 *   FED-ERR-12 Meta stored and parsed correctly
 *   FED-ERR-13 Stack trace stored correctly
 *   FED-ERR-14 GitHub create issue fails → report still stored
 *   FED-ERR-15 GitHub add comment fails → deduplicated=false, report stored
 *   FED-ERR-16 Query returns empty array on DB error (fail-open)
 *   FED-ERR-17 Issue title truncated to 80 chars
 *   FED-ERR-18 Labels include severity
 *   FED-ERR-19 Report ID is valid UUID format
 *   FED-ERR-20 Multiple reports from same peer within 24h all deduplicated
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FederationErrorIngestor } from '../../src/core/federation/federation-error-ingestor.js';
import type { FederationErrorReport } from '../../src/core/federation/federation-error-ingestor-types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function createMockDeps(opts?: {
  githubConfigured?: boolean;
  searchResult?: { success: boolean; issues?: Array<{ number: number; title: string; labels: Array<{ name: string }>; body?: string }> };
  createResult?: { success: boolean; number?: number };
  commentResult?: { success: boolean };
  searchThrows?: boolean;
  createThrows?: boolean;
  commentThrows?: boolean;
}) {
  const db = makeInMemoryDb();

  const mockErrorReporter = {
    capture: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    normalizeSignature: vi.fn<(error: Error) => string>().mockImplementation((err) => err.message),
  };

  const githubConfigured = opts?.githubConfigured ?? true;
  const mockGithubIssues = {
    isConfigured: vi.fn<() => boolean>().mockReturnValue(githubConfigured),
    searchIssues: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async () => {
      if (opts?.searchThrows) {
        throw new Error('GitHub search failed');
      }
      return opts?.searchResult ?? { success: true, issues: [] };
    }),
    createIssue: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async () => {
      if (opts?.createThrows) {
        throw new Error('GitHub create failed');
      }
      return opts?.createResult ?? { success: true, number: 123 };
    }),
    addComment: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async () => {
      if (opts?.commentThrows) {
        throw new Error('GitHub comment failed');
      }
      return opts?.commentResult ?? { success: true };
    }),
  };

  return { db, mockErrorReporter, mockGithubIssues };
}

function makeReport(overrides?: Partial<FederationErrorReport>): FederationErrorReport {
  return {
    peerId: 'peer-test-001',
    errorSignature: 'test-error-signature',
    stackTrace: 'Error: test\n    at test.ts:1:1',
    botVersion: '4.0.0',
    severity: 'HIGH',
    toolName: 'test-tool',
    sessionId: 'sesn-001',
    phase: 'tool-execution',
    meta: { extra: 'data' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FED-ERR-1: Happy path
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — happy path', () => {
  it('FED-ERR-1: new report creates GitHub issue and returns reportId + issueNumber', async () => {
    const { db, mockErrorReporter, mockGithubIssues } = createMockDeps({
      searchResult: { success: true, issues: [] }, // No existing issue
      createResult: { success: true, number: 42 },
    });

    const ingestor = new FederationErrorIngestor({
      errorReporter: mockErrorReporter,
      githubIssues: mockGithubIssues,
      db,
    });

    const report = makeReport();
    const result = await ingestor.ingestReport(report);

    expect(result.reportId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.githubIssueNumber).toBe(42);
    expect(result.deduplicated).toBe(false);

    // Verify GitHub calls
    expect(mockGithubIssues.searchIssues).toHaveBeenCalledWith({
      labels: ['auto-bug', 'federation'],
      state: 'open',
    });
    expect(mockGithubIssues.createIssue).toHaveBeenCalledWith({
      title: '[federation] test-error-signature',
      body: expect.stringContaining('peer-test-001'),
      labels: ['auto-bug', 'federation', 'high'],
    });

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-2: Dedup within 24h
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — deduplication within 24h', () => {
  it('FED-ERR-2: same signature from same peer within 24h → deduplicated=true, no GitHub call', async () => {
    const { db, mockGithubIssues } = createMockDeps();

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const report = makeReport();

    // First report
    await ingestor.ingestReport(report);

    // Second report (same peer, same signature)
    const result2 = await ingestor.ingestReport(report);

    expect(result2.deduplicated).toBe(true);
    expect(mockGithubIssues.searchIssues).toHaveBeenCalledTimes(1); // Only called for first report

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-3: Dedup across peers
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — deduplication across peers', () => {
  it('FED-ERR-3: same signature, different peer → adds comment to existing issue', async () => {
    const { db, mockGithubIssues } = createMockDeps({
      searchResult: {
        success: true,
        issues: [{ number: 99, title: '[federation] test-error-signature', labels: [{ name: 'auto-bug' }], body: 'original' }],
      },
    });

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    // First peer report (creates issue)
    await ingestor.ingestReport(makeReport());

    // Second peer report (same signature, different peer)
    const report2 = makeReport({ peerId: 'peer-different' });
    const result2 = await ingestor.ingestReport(report2);

    expect(result2.deduplicated).toBe(true);
    expect(result2.githubIssueNumber).toBe(99);
    expect(mockGithubIssues.addComment).toHaveBeenCalledWith(99, expect.stringContaining('peer-different'));

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-4: GitHub not configured
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — GitHub not configured', () => {
  it('FED-ERR-4: GitHub not configured → stores report, no issue created', async () => {
    const { db, mockGithubIssues } = createMockDeps({ githubConfigured: false });

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const result = await ingestor.ingestReport(makeReport());

    expect(result.githubIssueNumber).toBeUndefined();
    expect(result.deduplicated).toBe(false);
    expect(mockGithubIssues.searchIssues).not.toHaveBeenCalled();
    expect(mockGithubIssues.createIssue).not.toHaveBeenCalled();

    // Verify report is stored
    const reports = ingestor.queryReports({ peerId: 'peer-test-001' });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.errorSignature).toBe('test-error-signature');

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-5: GitHub search fails
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — fail-open behavior', () => {
  it('FED-ERR-5: GitHub search fails → fail-open, report still stored', async () => {
    const { db, mockGithubIssues } = createMockDeps({ searchThrows: true });

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const result = await ingestor.ingestReport(makeReport());

    expect(result.reportId).toMatch(/^[0-9a-f-]+$/i);
    expect(result.deduplicated).toBe(false);

    // Report should still be stored
    const reports = ingestor.queryReports();
    expect(reports.length).toBeGreaterThanOrEqual(1);

    ingestor.destroy();
  });

  it('FED-ERR-14: GitHub create issue fails → report still stored', async () => {
    const { db, mockGithubIssues } = createMockDeps({
      searchResult: { success: true, issues: [] },
      createThrows: true,
    });

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const result = await ingestor.ingestReport(makeReport());

    expect(result.githubIssueNumber).toBeUndefined();
    expect(result.deduplicated).toBe(false);

    const reports = ingestor.queryReports();
    expect(reports.length).toBeGreaterThanOrEqual(1);

    ingestor.destroy();
  });

  it('FED-ERR-15: GitHub add comment fails → deduplicated=false, report stored', async () => {
    const { db, mockGithubIssues } = createMockDeps({
      searchResult: {
        success: true,
        issues: [{ number: 99, title: '[federation] test', labels: [{ name: 'auto-bug' }] }],
      },
      commentThrows: true,
    });

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    // First report creates issue (with different signature to avoid DB dedup)
    await ingestor.ingestReport(makeReport({ errorSignature: 'unique-sig-1' }));

    // Second peer report with same signature finds issue but comment fails
    // Note: We need to make the search return the issue for the SECOND report's signature
    // So we mock search to return an issue for any query
    (mockGithubIssues.searchIssues as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      success: true,
      issues: [{ number: 99, title: '[federation] test', labels: [{ name: 'auto-bug' }] }],
    }));

    const result2 = await ingestor.ingestReport(makeReport({ peerId: 'peer-2', errorSignature: 'test' }));

    // Comment failed, so no issue number attached and not deduplicated
    expect(result2.deduplicated).toBe(false);
    expect(result2.githubIssueNumber).toBeUndefined();

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-6 to 8: Query reports
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — queryReports', () => {
  it('FED-ERR-6: query by peerId returns matching reports', async () => {
    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    // Use different signatures to avoid deduplication
    await ingestor.ingestReport(makeReport({ peerId: 'peer-a', errorSignature: 'sig-a1' }));
    await ingestor.ingestReport(makeReport({ peerId: 'peer-b', errorSignature: 'sig-b1' }));
    await ingestor.ingestReport(makeReport({ peerId: 'peer-a', errorSignature: 'sig-a2' }));

    const peerAReports = ingestor.queryReports({ peerId: 'peer-a' });
    expect(peerAReports).toHaveLength(2);
    expect(peerAReports.every((r) => r.peerId === 'peer-a')).toBe(true);

    ingestor.destroy();
  });

  it('FED-ERR-7: query by signature returns matching reports', async () => {
    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    await ingestor.ingestReport(makeReport({ errorSignature: 'sig-x' }));
    await ingestor.ingestReport(makeReport({ errorSignature: 'sig-y' }));

    const sigXReports = ingestor.queryReports({ signature: 'sig-x' });
    expect(sigXReports).toHaveLength(1);
    expect(sigXReports[0]!.errorSignature).toBe('sig-x');

    ingestor.destroy();
  });

  it('FED-ERR-8: query with limit returns at most N reports', async () => {
    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    for (let i = 0; i < 10; i++) {
      await ingestor.ingestReport(makeReport({ errorSignature: `sig-${i}` }));
    }

    const limited = ingestor.queryReports({ limit: 5 });
    expect(limited).toHaveLength(5);

    ingestor.destroy();
  });

  it('FED-ERR-16: query returns empty array on DB error (fail-open)', () => {
    const mockDb = {
      prepare: vi.fn().mockImplementation(() => ({
        all: vi.fn().mockImplementation(() => {
          throw new Error('DB error');
        }),
      })),
      exec: vi.fn(),
    };

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: { isConfigured: vi.fn().mockReturnValue(false), searchIssues: vi.fn(), createIssue: vi.fn(), addComment: vi.fn() },
      db: mockDb as unknown as FederationErrorIngestor['deps']['db'],
    });

    const reports = ingestor.queryReports();
    expect(reports).toEqual([]);

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-9: Destroy cleanup
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — destroy', () => {
  it('FED-ERR-9: destroy() marks ingestor as destroyed', () => {
    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    ingestor.destroy();

    // Subsequent calls should return early
    expect(() => ingestor.destroy()).not.toThrow();

    ingestor.destroy();
  });

  it('FED-ERR-11: ingestReport called after destroy() returns early', async () => {
    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    ingestor.destroy();

    const result = await ingestor.ingestReport(makeReport());
    expect(result.reportId).toMatch(/^[0-9a-f-]+$/i);
    expect(result.githubIssueNumber).toBeUndefined();
    expect(result.deduplicated).toBe(false);

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-10: Disabled via env var
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — env var disable', () => {
  it('FED-ERR-10: SUDO_FED_ERROR_INGEST_DISABLE=1 → returns early without GitHub calls', async () => {
    process.env['SUDO_FED_ERROR_INGEST_DISABLE'] = '1';

    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const result = await ingestor.ingestReport(makeReport());

    expect(result.githubIssueNumber).toBeUndefined();
    expect(result.deduplicated).toBe(false);
    expect(mockGithubIssues.searchIssues).not.toHaveBeenCalled();
    expect(mockGithubIssues.createIssue).not.toHaveBeenCalled();

    delete process.env['SUDO_FED_ERROR_INGEST_DISABLE'];
    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-12: Meta stored and parsed
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — meta storage', () => {
  it('FED-ERR-12: meta object stored and parsed correctly', async () => {
    const { db, mockGithubIssues } = createMockDeps({ githubConfigured: false });
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const meta = { userId: '123', requestId: 'abc', nested: { key: 'value' } };
    await ingestor.ingestReport(makeReport({ meta }));

    const reports = ingestor.queryReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.meta).toEqual(meta);

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-13: Stack trace stored
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — stack trace', () => {
  it('FED-ERR-13: stack trace stored correctly', async () => {
    const { db, mockGithubIssues } = createMockDeps({ githubConfigured: false });
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const stackTrace = 'Error: test\n  at module.ts:10:5\n  at main.ts:3:1';
    await ingestor.ingestReport(makeReport({ stackTrace }));

    const reports = ingestor.queryReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.stackTrace).toBe(stackTrace);

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-17: Issue title truncated
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — issue title', () => {
  it('FED-ERR-17: issue title truncated to 80 chars', async () => {
    const longSignature = 'a'.repeat(150);
    const { db, mockGithubIssues } = createMockDeps({
      searchResult: { success: true, issues: [] },
    });

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    await ingestor.ingestReport(makeReport({ errorSignature: longSignature }));

    const callArgs = (mockGithubIssues.createIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs?.title).toHaveLength(80 + 13); // [federation]  + 80 chars
    expect(callArgs?.title).toMatch(/^\[federation\] a{80}$/);

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-18: Labels include severity
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — labels', () => {
  it('FED-ERR-18: labels include severity in lowercase', async () => {
    const { db, mockGithubIssues } = createMockDeps({
      searchResult: { success: true, issues: [] },
    });

    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    await ingestor.ingestReport(makeReport({ severity: 'CRITICAL' }));

    const callArgs = (mockGithubIssues.createIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs?.labels).toEqual(['auto-bug', 'federation', 'critical']);

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-19: Report ID is valid UUID
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — report ID format', () => {
  it('FED-ERR-19: report ID is valid UUID format', async () => {
    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const result = await ingestor.ingestReport(makeReport());

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(result.reportId).toMatch(uuidRegex);

    ingestor.destroy();
  });
});

// ---------------------------------------------------------------------------
// FED-ERR-20: Multiple dedup reports
// ---------------------------------------------------------------------------

describe('FederationErrorIngestor — multiple dedup', () => {
  it('FED-ERR-20: multiple reports from same peer within 24h all deduplicated', async () => {
    const { db, mockGithubIssues } = createMockDeps();
    const ingestor = new FederationErrorIngestor({
      errorReporter: { capture: vi.fn(), normalizeSignature: vi.fn() },
      githubIssues: mockGithubIssues,
      db,
    });

    const report = makeReport();

    // First report
    const r1 = await ingestor.ingestReport(report);
    expect(r1.deduplicated).toBe(false);

    // Next 5 reports all deduplicated
    for (let i = 0; i < 5; i++) {
      const r = await ingestor.ingestReport(report);
      expect(r.deduplicated).toBe(true);
    }

    // GitHub search only called once (for first report)
    expect(mockGithubIssues.searchIssues).toHaveBeenCalledTimes(1);

    ingestor.destroy();
  });
});
