/**
 * @file gdrive/audit.ts
 * @description Audit emitter for Drive background jobs (prime directive 9).
 *
 * Rides the existing tamper-evident AuditTrail (data/audit.db, hash-chained)
 * instead of a new sink. Every job emits: job name, inputs digest, files
 * touched, bytes, outcome, duration. Never logs secrets or decrypted zone-1
 * content — metadata is caller-constructed and this helper only passes
 * through the whitelisted GdriveJobAudit fields.
 */

import { createHash } from 'node:crypto';
import type { AuditTrail } from '../security/audit-trail.js';
import { createLogger } from '../shared/logger.js';
import type { GdriveJobAudit } from './types.js';

const log = createLogger('gdrive:audit');

export const GDRIVE_AUDIT_ACTOR = 'gdrive';

/** sha256 hex digest helper for job-input provenance. */
export function digestInputs(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Emit one audit row for a completed (or failed) Drive job. Fail-open. */
export function emitGdriveAudit(trail: AuditTrail | null, entry: GdriveJobAudit): void {
  try {
    trail?.record({
      actor: GDRIVE_AUDIT_ACTOR,
      action: `gdrive.${entry.job}`,
      resource: (entry.filesTouched ?? []).slice(0, 50).join(',') || 'gdrive',
      outcome: entry.outcome,
      metadata: {
        inputsDigest: entry.inputsDigest,
        filesTouched: entry.filesTouched?.length ?? 0,
        bytes: entry.bytes ?? 0,
        durationMs: entry.durationMs,
        ...entry.detail,
      },
    });
  } catch (err) {
    // Auditing must never take a job down — log and continue.
    log.warn({ err: String(err), job: entry.job }, 'gdrive audit emit failed');
  }
}

/**
 * Wrap a job body with timing + audit emission. Returns the job's value;
 * rethrows its error after auditing the failure.
 */
export async function auditedJob<T>(
  trail: AuditTrail | null,
  job: string,
  fn: () => Promise<{ result: T; filesTouched?: string[]; bytes?: number; inputsDigest?: string }>,
): Promise<T> {
  const start = Date.now();
  try {
    const { result, filesTouched, bytes, inputsDigest } = await fn();
    emitGdriveAudit(trail, {
      job,
      filesTouched,
      bytes,
      inputsDigest,
      outcome: 'success',
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    emitGdriveAudit(trail, {
      job,
      outcome: 'error',
      durationMs: Date.now() - start,
      detail: { error: String(err).slice(0, 500) },
    });
    throw err;
  }
}
