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
  /**
   * Milliseconds-since-epoch. Required so this type structurally matches the
   * wire-side `FederationErrorReport` in `gateway/federation-error-types.ts`
   * — the gateway's `FederationErrorRoutesDeps` declares `queryReports(): ...[]`
   * to return rows that carry a `timestamp`, and the response handler returns
   * those rows straight to HTTP clients. The ingestor currently overrides
   * the wire-supplied value on read with the server-receipt time
   * (`new Date(created_at).getTime()`) — the wire value is peer-clock-derived and
   * untrusted; server-receipt time is what an admin viewer actually wants.
   */
  timestamp: number;
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
