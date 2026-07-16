/**
 * @file gdrive/errors.ts
 * @description Typed error mapping for Drive/Sheets API failures.
 *
 * Classifies gaxios/googleapis errors into GdriveErrorKind so the backoff
 * layer can decide retryability without string-matching at call sites.
 * 403 is ambiguous in the Drive API: rate-limit reasons (userRateLimitExceeded,
 * rateLimitExceeded) are retryable; permission 403s are auth failures and are
 * not.
 */

import type { GdriveErrorKind } from './types.js';

const RATE_REASONS = new Set([
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
]);

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

export class GdriveApiError extends Error {
  readonly kind: GdriveErrorKind;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(kind: GdriveErrorKind, message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = 'GdriveApiError';
    this.kind = kind;
    this.status = status;
    this.cause = cause;
  }

  get retryable(): boolean {
    return this.kind === 'rate' || this.kind === 'server' || this.kind === 'network';
  }
}

interface GaxiosLikeError {
  message?: string;
  code?: string | number;
  response?: {
    status?: number;
    data?: { error?: { errors?: Array<{ reason?: string }>; message?: string; status?: string } };
  };
}

/** Map any thrown value from googleapis into a GdriveApiError. Idempotent. */
export function mapGdriveError(err: unknown): GdriveApiError {
  if (err instanceof GdriveApiError) return err;
  const e = (err ?? {}) as GaxiosLikeError;
  const status =
    e.response?.status ?? (typeof e.code === 'number' ? e.code : Number(e.code) || undefined);
  const reasons = (e.response?.data?.error?.errors ?? [])
    .map((x) => x.reason)
    .filter((r): r is string => typeof r === 'string');
  const message = e.response?.data?.error?.message ?? e.message ?? String(err);

  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) {
    return new GdriveApiError('network', message, undefined, err);
  }
  if (status === 429) return new GdriveApiError('rate', message, status, err);
  if (status === 403) {
    const kind = reasons.some((r) => RATE_REASONS.has(r)) ? 'rate' : 'auth';
    return new GdriveApiError(kind, message, status, err);
  }
  if (status === 401) return new GdriveApiError('auth', message, status, err);
  if (status === 404) return new GdriveApiError('not_found', message, status, err);
  if (typeof status === 'number' && status >= 500) {
    return new GdriveApiError('server', message, status, err);
  }
  if (typeof status === 'number' && status >= 400) {
    return new GdriveApiError('invalid', message, status, err);
  }
  // No status at all — treat as network-ish (fetch/socket failures often
  // surface as plain Errors) so transient blips retry rather than hard-fail.
  return new GdriveApiError('network', message, undefined, err);
}
