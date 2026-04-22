/**
 * Shared types for the exec approval gate system.
 *
 * These types describe the shape of approval records written to disk and
 * the decision values returned by waitForDecision().
 */

// ---------------------------------------------------------------------------
// Approval record (persisted to disk as JSON)
// ---------------------------------------------------------------------------

/** Possible decision states for an approval request. */
export type ApprovalDecision = 'approved' | 'denied' | 'pending' | 'expired';

/**
 * Full approval record persisted to workspace/approvals/pending/<uuid>.json
 * and moved to workspace/approvals/decided/<uuid>.json when decided.
 */
export interface ApprovalRecord {
  /** UUID v4 identifier for this approval request. */
  id: string;
  /** The exact shell command string that requires approval. */
  command: string;
  /** Optional human-readable reason from the agent explaining why it needs this command. */
  reason: string;
  /** ISO 8601 timestamp when the request was created. */
  requestedAt: string;
  /** ISO 8601 timestamp when a decision was made. Absent on pending records. */
  decidedAt?: string;
  /** Current decision state. */
  decision: ApprovalDecision;
}

// ---------------------------------------------------------------------------
// Approval mode (controlled via EXEC_APPROVAL_MODE env var)
// ---------------------------------------------------------------------------

/**
 * Controls how the exec gate behaves:
 * - `off`        — No gate. All commands run immediately (logs a startup warning).
 * - `allowlist`  — Allowlisted commands run immediately; others require approval.
 * - `strict`     — All commands require explicit approval regardless of allowlist.
 */
export type ApprovalMode = 'off' | 'allowlist' | 'strict';

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/** Strict UUID v4 format check (lowercase hex, no curly braces). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true only if id is a well-formed UUID. Used to prevent path traversal. */
export function isValidUuid(id: string): boolean {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** Parse and validate an ApprovalMode string. Returns 'allowlist' for unrecognised values. */
export function parseApprovalMode(raw: string | undefined): ApprovalMode {
  if (raw === 'off' || raw === 'allowlist' || raw === 'strict') return raw;
  return 'allowlist';
}
