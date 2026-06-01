/**
 * @file self-build/deployment-hook-types.ts
 * @description Types for DeploymentHook module.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubPRStatus {
  number: number;
  merged: boolean;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
}

export interface CIResult {
  passed: boolean;
  output: string;
}

export interface DeployResult {
  success: boolean;
  action: 'deployed' | 'rolled-back' | 'skipped' | 'failed';
  output?: string;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// ---------------------------------------------------------------------------
// Dependencies interface (subset needed from connectors)
// ---------------------------------------------------------------------------

export interface GitHubIssuesConnector {
  addComment(issueNumber: number, body: string): Promise<{ success: boolean }>;
}

export interface MetricsCollector {
  recordEvent(event: string, metadata?: Record<string, unknown>): void;
}
