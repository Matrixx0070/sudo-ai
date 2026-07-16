/**
 * @file gdrive/trust.ts
 * @description F16 — ACL-enforced trust zones.
 *
 * Provenance is derived from Drive's ACTUAL permission state
 * (permissions.list on the file and its parent folder), never from metadata
 * claims. Trust tier multiplies retrieval ranking (epistemic-ranking rider,
 * Phase 5).
 *
 * Tier semantics:
 * - principal:     writable by the owner (Frank) — possibly also the SA.
 * - agent:         writable ONLY by the service account.
 * - self_acquired: curiosity-pipeline outputs (assigned by the pipeline, F38 —
 *                  never derived from ACLs here).
 * - external:      any other writer (shared links, unknown accounts).
 */

export type TrustTier = 'principal' | 'agent' | 'self_acquired' | 'external';

/** Retrieval ranking multipliers (spec defaults; configurable later). */
export const TRUST_WEIGHTS: Record<TrustTier, number> = {
  principal: 1.0,
  agent: 0.9,
  self_acquired: 0.7,
  external: 0.5,
};

/** The permission fields deriveTrustTier consumes (subset of Drive's schema). */
export interface PermissionLike {
  type?: string | null; // user | group | domain | anyone
  role?: string | null; // owner | organizer | fileOrganizer | writer | commenter | reader
  emailAddress?: string | null;
}

const WRITER_ROLES = new Set(['owner', 'organizer', 'fileOrganizer', 'writer']);

export interface TrustContext {
  /** The service account's email (writers matching this are "the agent"). */
  serviceAccountEmail: string;
  /** The principal's (owner's) email addresses. */
  principalEmails: string[];
}

/**
 * Derive the trust tier from the writable set across the file AND its parent
 * folder (a writable parent means the file can be swapped out from under us,
 * so parent writers count as file writers).
 *
 * Unknown/anyone-writable => external, regardless of who else can write —
 * the tier reflects the WEAKEST writer, not the strongest.
 */
export function deriveTrustTier(
  filePermissions: PermissionLike[],
  parentPermissions: PermissionLike[],
  ctx: TrustContext,
): TrustTier {
  const principal = new Set(ctx.principalEmails.map((e) => e.toLowerCase()));
  const sa = ctx.serviceAccountEmail.toLowerCase();

  let sawPrincipal = false;
  let sawSa = false;

  for (const p of [...filePermissions, ...parentPermissions]) {
    if (!WRITER_ROLES.has(p.role ?? '')) continue;
    const email = p.emailAddress?.toLowerCase();
    if (p.type === 'anyone' || p.type === 'domain' || p.type === 'group') return 'external';
    if (!email) return 'external'; // writer we cannot identify
    if (email === sa) {
      sawSa = true;
    } else if (principal.has(email)) {
      sawPrincipal = true;
    } else {
      return 'external';
    }
  }

  if (sawPrincipal) return 'principal';
  if (sawSa) return 'agent';
  // No identifiable writers at all — treat as external (fail-closed).
  return 'external';
}

/** Provenance record attached to every ingested memory (spec shape). */
export interface ProvenanceRecord {
  sourceFileId: string;
  sourceName: string;
  sourceRevisionId?: string;
  trustTier: TrustTier;
  zone: 0 | 1 | 2;
  ingestedAt: string;
  contentSha256: string;
  quarantineVerdict?: 'clean' | 'approved';
  citations?: string[]; // "fileId@revisionId"
}
