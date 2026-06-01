/**
 * @file gateway/federation-error-types.ts
 * @description Type definitions for federation error reporting protocol.
 *
 * Wave 2 — Federation Error Protocol.
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

export type TokenProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'ollama' | 'cliproxy' | 'sudo-mosaic' | 'cascade';

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
    queryReports(opts: { peerId?: string; signature?: string; limit?: number }): FederationErrorReport[];
  };
  tokenPool: {
    contributeToken(contribution: FederationTokenContribution): Promise<{ id: string; success: boolean; error?: string }>;
    listTokens(opts: { peerId?: string; activeOnly?: boolean }): Array<{ id: string; peerId: string; provider: string; active: boolean; createdAt: string }>;
  };
  fedAuth: (req: any) => boolean;  // federation bearer validation
}
