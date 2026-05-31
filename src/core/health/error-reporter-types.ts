/**
 * @file error-reporter-types.ts
 * @description Type definitions for ErrorReporter module.
 */

export type ErrorSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ErrorContext {
  toolName?: string;
  healthCheck?: string;
  sessionId?: string;
  phase?: string;
  [key: string]: unknown;
}

export interface CapturedError {
  error: Error;
  severity: ErrorSeverity;
  context: ErrorContext;
  timestamp: string;
  signature: string;
}
