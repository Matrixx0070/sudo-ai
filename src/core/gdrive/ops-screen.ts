/**
 * @file gdrive/ops-screen.ts
 * @description P1 egress screening for the OPS upload lanes (audit item 3,
 * docs/DRIVE_SECURITY_AUDIT_2026-07-28.md).
 *
 * The NotebookLM export lane already screens every doc (`assertZone2`); the
 * ~15 ops-surface upload paths (second-opinion packets, nightly report,
 * blackboard, case-law, heartbeat, skill-registry, dream agenda, dead-ends,
 * curiosity, fork policy notes) uploaded plaintext with no screen at all.
 * `screenOpsUpload` closes that gap with REDACT-AND-CONTINUE semantics:
 * secrets are redacted in place (ops jobs degrade instead of dying),
 * redactions are counted and logged, and the post-redaction zone
 * classification is surfaced so callers/audit rows can record it.
 *
 * SECRETS_PATTERNS + redactSecrets moved here FROM notebooklm/zone-screen.ts
 * (which re-exports them) so the ops lane can reuse the exact same net without
 * gdrive importing notebooklm (layering: notebooklm -> gdrive only).
 *
 * NOT screened (deliberate, documented): HMAC-signed manifest bodies
 * (blob-store push, forks fork/adopt, releases byte-exact copies). Redaction
 * would break the signature, and manifests are machine-generated
 * (logicalPaths + sha256 hex — the hex_secret_64 pattern would false-positive
 * on every blob hash). Manifest content never contains free text besides
 * logicalPath names; the fork `policyNote` free-text field IS screened.
 */

import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import { emitGdriveAudit } from './audit.js';
import { classifyZone, type Zone } from './zones.js';

const log = createLogger('gdrive:ops-screen');

// ---------------------------------------------------------------------------
// Audit seam (audit item 8): ops modules don't all carry an AuditTrail, so
// the runtime injects its trail here once; every FLAGGED screen then lands a
// tamper-evident `gdrive.ops-screen` row (context + redactions + zone).
// Fail-open by design — a missing trail never blocks an ops job.
// ---------------------------------------------------------------------------

let opsScreenAudit: AuditTrail | null = null;

export function setOpsScreenAudit(trail: AuditTrail | null): void {
  opsScreenAudit = trail;
}

/**
 * Independent secrets patterns. Deliberately overlaps ZONE1_PATTERNS in
 * zones.ts (that's the point — a second, separately-maintained net). Leans
 * broad: a false positive costs one redacted span, a false negative leaks.
 */
export const SECRETS_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private_key_block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'gcp_oauth_secret', re: /\bGOCSPX-[\w-]{10,}\b/ },
  { name: 'bearer_token', re: /\b(?:bearer|authorization)\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/i },
  { name: 'api_key_kv', re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9._\/+-]{12,}/i },
  { name: 'password_kv', re: /\b(?:password|passphrase|passwd)\b\s*[:=]\s*\S{6,}/i },
  { name: 'hex_secret_64', re: /\b[0-9a-f]{64}\b/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'credit_card', re: /\b(?:\d[ -]?){13,16}\b/ },
];

/**
 * Redact any secret span in place. Used by the F43 declassification screen
 * (via the notebooklm/zone-screen re-export) and by screenOpsUpload below.
 * Returns redacted text + hit count.
 */
export function redactSecrets(text: string): { redacted: string; hits: number } {
  let redacted = text;
  let hits = 0;
  for (const p of SECRETS_PATTERNS) {
    redacted = redacted.replace(new RegExp(p.re, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g'), () => {
      hits++;
      return `[REDACTED:${p.name}]`;
    });
  }
  return { redacted, hits };
}

export interface OpsScreenResult {
  /** The text that may actually leave the process (secrets redacted). */
  text: string;
  /** Number of redacted secret spans (0 = clean). */
  redactions: number;
  /** classifyZone of the POST-redaction text (2 = clean plaintext). */
  zone: Zone;
  /** True when anything was redacted or the text is still zone-sensitive. */
  flagged: boolean;
}

/**
 * The ONE screening gate for ops-surface plaintext uploads (audit item 3).
 * Redact-and-continue: never throws, so background jobs degrade instead of
 * dying — but every redaction is counted and logged, and residual zone-1
 * classification (keyword-level sensitivity that isn't a redactable secret
 * value) is logged loudly for the audit trail.
 */
export function screenOpsUpload(text: string, context: string): OpsScreenResult {
  const { redacted, hits } = redactSecrets(text);
  const zone = classifyZone(redacted);
  const flagged = hits > 0 || zone !== 2;
  if (hits > 0) {
    log.warn({ context, redactions: hits }, 'ops upload: secrets REDACTED before Drive egress (audit item 3)');
  }
  if (zone !== 2) {
    log.warn({ context, zone }, 'ops upload: content still classifies zone-sensitive after redaction — uploading redacted text; review the source job');
  }
  if (flagged) {
    emitGdriveAudit(opsScreenAudit, {
      job: 'ops-screen',
      outcome: 'success',
      durationMs: 0,
      detail: { context, redactions: hits, zone },
    });
  }
  return { text: redacted, redactions: hits, zone, flagged };
}
