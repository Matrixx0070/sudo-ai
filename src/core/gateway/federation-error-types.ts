/**
 * @file gateway/federation-error-types.ts
 * @description Type definitions for federation error reporting protocol.
 */

// ---------------------------------------------------------------------------
// Error Report — submitted by peer bots
// ---------------------------------------------------------------------------

export interface FederationErrorReport {
  errorSignature: string;      // max 500 chars
  stackTrace?: string;         // capped at 8KB
  botVersion: string;          // semver
  peerId: string;
  timestamp: number;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  toolName?: string;
  sessionId?: string;
  phase?: string;
  meta?: Record<string, unknown>;
}

/**
 * Stored row shape — what `errorIngestor.queryReports()` returns and what
 * `GET /v1/admin/federation/error-reports` emits over the wire. Extends the
 * submission-side {@link FederationErrorReport} with server-set fields the
 * ingestor stamps at persistence time. Declared on the gateway side so this
 * file owns the wire contract without importing ingestor internals.
 *
 * Mirrors the structural shape the live `FederationErrorIngestor` in
 * `core/federation/federation-error-ingestor-types.ts`
 * (`FederationErrorReportStored`) emits — the duplication is intentional:
 * the gateway is the public boundary and should not depend on ingestor types.
 */
export interface FederationErrorReportRow extends FederationErrorReport {
  /** UUID assigned by the ingestor at insert time. */
  id: string;
  /** Linked GitHub issue number, when one was created or commented on. */
  githubIssueNumber?: number;
  /** True when the same peer/signature combination collapsed onto an
   *  existing row within the 24h dedup window. */
  deduplicated: boolean;
}

// ---------------------------------------------------------------------------
// Fix Notify — admin broadcasts fix to peers
// ---------------------------------------------------------------------------

export interface FederationFixNotify {
  fixCommitHash: string;
  affectedErrorSignature: string;
  newVersionTag: string;
  updateCommand?: string;
  releaseNotes?: string;
}

// ---------------------------------------------------------------------------
// Token Contribution — peer contributes API token to shared pool
// ---------------------------------------------------------------------------

export type TokenProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'ollama' | 'sudo-mosaic' | 'cascade';

export interface FederationTokenContribution {
  peerId: string;
  provider: TokenProvider;
  token: string;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Route dependencies interface
// ---------------------------------------------------------------------------

export interface FederationErrorRoutesDeps {
  errorIngestor: {
    ingestReport(report: FederationErrorReport): Promise<{ reportId: string; githubIssueNumber?: number; deduplicated: boolean }>;
    queryReports(opts: { peerId?: string; signature?: string; limit?: number }): FederationErrorReportRow[];
  };
  tokenPool: {
    contributeToken(contribution: FederationTokenContribution): Promise<{ id: string; success: boolean; error?: string }>;
    listTokens(opts: { peerId?: string; activeOnly?: boolean }): Array<{ id: string; peerId: string; provider: string; active: boolean; createdAt: string }>;
  };
  fedAuth: (req: any) => boolean;  // federation bearer validation
}
