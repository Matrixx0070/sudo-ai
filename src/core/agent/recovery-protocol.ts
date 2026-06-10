/**
 * @file agent/recovery-protocol.ts
 * @description Forward-constraint injection for SUDO-AI recovery protocol.
 *
 * Persists (mistake, learned, commitment) triples into the audit trail and
 * loads active commitments to inject as system-context messages, ensuring
 * the agent remains aware of prior failure modes throughout its session.
 *
 * No external dependencies beyond audit-trail types.
 */

import { createLogger } from '../shared/logger.js';
import type { CommitmentTriple, AuditFilter, AuditEntry } from '../security/audit-trail.js';

const log = createLogger('agent:recovery-protocol');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecoveryRecord {
  mistake: string;
  learned: string;
  commitment: string;
  ttl_days: number;
  resource?: string;
}

export interface ActiveCommitment {
  hash: string;
  commitment: string;
  expiresAt: number; // Unix ms
  createdAt: string; // ISO date YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// recordRecovery
// ---------------------------------------------------------------------------

/**
 * Persist a recovery record as a commitment triple in the audit trail.
 *
 * @param auditTrail - Audit trail instance (duck-typed for testability).
 * @param record     - The mistake, lesson learned, and forward commitment.
 * @returns The generated audit entry ID.
 */
export function recordRecovery(
  auditTrail: { recordTriple(triple: CommitmentTriple): string },
  record: RecoveryRecord,
): string {
  const triple: CommitmentTriple = {
    mistake: record.mistake,
    learned: record.learned,
    commitment: record.commitment,
    ttl_days: record.ttl_days,
    resource: record.resource,
  };

  const id = auditTrail.recordTriple(triple);
  log.debug({ id, learned: record.learned }, 'Recovery record persisted');
  return id;
}

// ---------------------------------------------------------------------------
// loadActiveCommitments
// ---------------------------------------------------------------------------

/**
 * Query the audit trail for all commitment entries and return those that
 * have not yet expired relative to `now`.
 *
 * Malformed entries (missing timestamp, bad metadata, zero ttl_days) are
 * silently skipped — never allowed to throw.
 *
 * @param auditTrail - Audit trail instance (duck-typed for testability).
 * @param now        - Reference time in Unix ms (default: Date.now()).
 * @returns Array of active (non-expired) commitments.
 */
export function loadActiveCommitments(
  auditTrail: { query(filter: AuditFilter): AuditEntry[] },
  now: number = Date.now(),
): ActiveCommitment[] {
  let entries: AuditEntry[];

  try {
    entries = auditTrail.query({ action: 'commitment', limit: 200 });
  } catch (err) {
    log.warn({ err: String(err) }, 'loadActiveCommitments: query failed — returning empty');
    return [];
  }

  const active: ActiveCommitment[] = [];

  for (const entry of entries) {
    try {
      // Guard: timestamp must be present and parseable.
      if (!entry.timestamp) {
        log.debug('loadActiveCommitments: skipping entry with missing timestamp');
        continue;
      }

      // metadata is already parsed by AuditTrail.query() — access fields defensively.
      const meta = entry.metadata as { mistake?: unknown; learned?: unknown; commitment?: unknown; ttl_days?: unknown } | undefined;
      if (!meta) {
        log.debug('loadActiveCommitments: skipping entry with missing metadata');
        continue;
      }

      const ttl_days = meta.ttl_days;
      if (typeof ttl_days !== 'number' || !Number.isFinite(ttl_days) || ttl_days <= 0) {
        log.debug({ ttl_days }, 'loadActiveCommitments: skipping entry with invalid ttl_days');
        continue;
      }

      const commitment = meta.commitment;
      if (typeof commitment !== 'string' || !commitment) {
        log.debug('loadActiveCommitments: skipping entry with missing commitment string');
        continue;
      }

      const entryTs = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(entryTs)) {
        log.debug({ timestamp: entry.timestamp }, 'loadActiveCommitments: skipping entry with unparseable timestamp');
        continue;
      }

      const expiresAt = entryTs + ttl_days * 86_400_000;

      if (expiresAt <= now) {
        // Already expired — skip silently.
        continue;
      }

      active.push({
        hash: entry.id ?? '',
        commitment,
        expiresAt,
        createdAt: new Date(entryTs).toISOString().slice(0, 10),
      });
    } catch (err) {
      // Never let a single malformed entry break the whole load.
      log.debug({ err: String(err) }, 'loadActiveCommitments: skipping malformed entry');
    }
  }

  return active;
}

// ---------------------------------------------------------------------------
// sanitizeCommitmentText (private helper)
// ---------------------------------------------------------------------------

/**
 * Sanitize LLM-generated text before injecting it into a system prompt.
 *
 * Mitigates stored prompt-injection vectors by:
 * - Capping length at 500 characters (truncates with ellipsis)
 * - Replacing whitespace control characters with a single space
 * - Stripping XML-like tokens
 * - Stripping role markers used by various LLM formatting conventions
 * - Collapsing multiple spaces and trimming
 */
function sanitizeCommitmentText(text: string): string {
  // 1. Replace newlines, carriage returns, tabs, and other control chars (0x00–0x1F except space 0x20)
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\r\n\t\x00-\x1F]/g, ' ');

  // 2. Strip XML-like tokens (angle-bracket tags up to 200 chars)
  sanitized = sanitized.replace(/<[^>]{1,200}>/g, '');

  // 3. Strip role markers (case-insensitive)
  sanitized = sanitized.replace(
    /\[SYSTEM\]|\[USER\]|\[ASSISTANT\]|<\|im_start\|>|<\|im_end\|>|<\/s>|<\/system>/gi,
    '',
  );

  // 4. Collapse multiple spaces and trim
  sanitized = sanitized.replace(/ {2,}/g, ' ').trim();

  // 5. Cap at 500 characters
  if (sanitized.length > 500) {
    sanitized = sanitized.slice(0, 500) + '\u2026';
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// formatCommitmentSystemMessage
// ---------------------------------------------------------------------------

/**
 * Format an array of active commitments into a system message string.
 *
 * @param commits - Active commitments to format.
 * @returns Formatted string, or '' if no commits.
 */
export function formatCommitmentSystemMessage(commits: ActiveCommitment[]): string {
  if (commits.length === 0) {
    return '';
  }

  const lines: string[] = ['[ACTIVE COMMITMENTS]'];

  for (const commit of commits) {
    const expiryDateStr = new Date(commit.expiresAt).toISOString().slice(0, 10);
    const createdDateStr = commit.createdAt;
    const safeCommitment = sanitizeCommitmentText(commit.commitment);
    lines.push(`- ${commit.hash.slice(0, 8)}: ${safeCommitment} (committed ${createdDateStr}, active until ${expiryDateStr})`);
  }

  return lines.join('\n');
}
