/**
 * @file sandbox/trust-tier.ts
 * @description Trust-tier classification for exec isolation (Feature 8).
 *
 * Isolation by trust tier, not one global sandbox for everyone: an untrusted
 * turn (a hook/email/community peer, `caller.isOwner === false`) is routed to a
 * throwaway container backend, while the owner's own turns keep the host
 * bwrap/local backend. The trust signal already rides on the per-turn caller
 * (Feature 1 `isOwner`, bound to AgentState at run() start), so classification
 * is pure and cheap — no new plumbing.
 *
 * DEFAULT-ON: acceptance requires that owner stays host and untrusted routes to
 * the container out of the box. Kill-switch SUDO_SANDBOX_TIER_ROUTING=0 disables
 * the routing (every session keeps whatever backend the policy/env already set).
 */

/**
 * Egress opt-in riding on the caller: the channel boundary (e.g. a hook's
 * webhooks.json5 entry) may grant an untrusted turn the ENFORCED
 * network:'allowlist' mode instead of the pinned 'none'. 'allowlist' is the
 * only expressible mode — a caller can never ask for 'host'.
 */
export interface CallerEgress {
  mode: 'allowlist';
  /** Hostnames to admit; omitted → DEFAULT_EGRESS_ALLOWLIST. */
  hosts?: string[];
}

/** Minimal caller shape — mirrors AgentState.caller / ToolContext caller fields. */
export interface CallerLike {
  isOwner?: boolean;
  channel?: string;
  peerId?: string;
  egress?: CallerEgress;
}

/** The two isolation tiers we route between today. */
export type TrustTier = 'owner' | 'untrusted';

/** The exec backend an untrusted tier is routed to. */
export const UNTRUSTED_EXEC_BACKEND = 'docker' as const;

/** Trust-tier routing is on by default; kill-switch SUDO_SANDBOX_TIER_ROUTING=0. */
export function isTierRoutingEnabled(): boolean {
  return process.env['SUDO_SANDBOX_TIER_ROUTING'] !== '0';
}

/**
 * Classify a turn's caller into a trust tier.
 *
 * UNTRUSTED **only** when a caller is explicitly present AND not the owner —
 * i.e. a real external non-owner peer (hook `caller:{isOwner:false,channel:'hook'}`,
 * an admitted non-owner channel peer, community). Everything else is host-tier:
 *  - `caller` undefined  → an internal / autonomous / scheduled turn (no channel
 *    boundary decided ownership). These MUST stay on the host backend — forcing
 *    them into a container would break background automation and needlessly
 *    require the sandbox image for the daemon's own work.
 *  - `caller.isOwner === true` → the owner. Host backend (full power).
 *
 * Deliberately conservative: an absent/undefined `isOwner` is treated as
 * host-tier (fail-OPEN for internal work), NOT untrusted — untrusted is an
 * explicit `isOwner === false` decided at the channel boundary.
 */
export function classifyTrustTier(caller?: CallerLike): TrustTier {
  if (caller && caller.isOwner === false) return 'untrusted';
  return 'owner';
}

/**
 * Network mode for an UNTRUSTED turn. Default 'none'; a caller-carried
 * `egress: { mode: 'allowlist' }` (set only by the channel boundary from
 * operator config, never by the peer) upgrades to the ENFORCED allowlist —
 * still strictly narrower than 'host', still docker-only, still fail-closed
 * (backends that cannot enforce it run with no network, see egress-proxy.ts).
 * Any other/malformed egress value stays 'none'.
 */
export function resolveUntrustedNetwork(
  caller?: CallerLike,
): { network: 'none' } | { network: 'allowlist'; hosts?: string[] } {
  const egress = caller?.egress;
  if (egress && egress.mode === 'allowlist') {
    const hosts = Array.isArray(egress.hosts)
      ? egress.hosts.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      : [];
    return hosts.length > 0 ? { network: 'allowlist', hosts } : { network: 'allowlist' };
  }
  return { network: 'none' };
}
