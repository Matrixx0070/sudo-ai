/**
 * @file federation-error-ingestor-types.ts
 * @description Type definitions for FederationErrorIngestor module.
 */

export interface FederationErrorReport {
  peerId: string;
  errorSignature: string;
  stackTrace?: string;
  botVersion: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  toolName?: string;
  sessionId?: string;
  phase?: string;
  meta?: Record<string, unknown>;
}

export interface FederationErrorIngestResult {
  reportId: string;
  githubIssueNumber?: number;
  deduplicated: boolean;
}

export interface FederationErrorQueryOptions {
  peerId?: string;
  signature?: string;
  limit?: number;
}

export interface FederationErrorReportStored extends FederationErrorReport {
  id: string;
  githubIssueNumber?: number;
  deduplicated: boolean;
}
