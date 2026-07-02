/**
 * @file directive-authorizer.ts
 * @description Shared authorization for channel slash-directives (used by
 * tryDispatchDirective). Read-only directives are open to anyone on an enabled
 * channel; state-mutating / turn-control directives (e.g. /stop discards a
 * peer's in-flight reply, /reset archives their session, /steer aborts a
 * running turn once its command is registered) require the sender to be an
 * owner, so a non-owner in a shared/group session can't disrupt another peer.
 *
 * Owner source, in order:
 *   1. SUDO_DIRECTIVE_OWNERS — comma-separated, uniform across channels. Each
 *      entry is a bare peerId or a "channel:peerId" pair. PREFER "channel:peerId":
 *      a bare peerId is trusted on EVERY enabled channel, an identity-confusion
 *      risk if two channels ever share a peerId space.
 *   2. The channel's own allowlist (telegram allowedUsers / whatsapp allowedJids).
 * When neither is available for a channel, the directive is allowed (the host
 * can't know the owner) — set SUDO_DIRECTIVE_OWNERS to lock that down.
 *
 * Note: the Telegram adapter gates messages with its own allowlist before the
 * command intercept, so it never routes through this path.
 */

import type { DirectiveMessage } from './dispatch.js';

/** Directives that only READ state — safe for anyone on an enabled channel. */
export const READ_ONLY_DIRECTIVES = new Set([
  'help', 'status', 'tools', 'health', 'budget', 'queue',
]);

/** Minimal shape of the per-channel allowlists the authorizer consults. */
export interface DirectiveAuthConfig {
  channels?: {
    telegram?: { allowedUsers?: string[] };
    whatsapp?: { allowedJids?: string[] };
  };
}

function explicitOwners(): string[] {
  return (process.env['SUDO_DIRECTIVE_OWNERS'] ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** Per-channel owner allowlist, or null when the channel has no per-user model. */
function channelOwners(channel: string, config: DirectiveAuthConfig): string[] | null {
  switch (channel) {
    case 'telegram': return config.channels?.telegram?.allowedUsers ?? [];
    case 'whatsapp': return config.channels?.whatsapp?.allowedJids ?? [];
    default: return null;
  }
}

/**
 * Build the directive authorizer for `tryDispatchDirective`'s `authorize` hook.
 * Returns `true` (allow) / `false` (deny). Deterministic and side-effect free.
 */
export function makeDirectiveAuthorizer(
  config: DirectiveAuthConfig,
): (msg: DirectiveMessage, command: string) => boolean {
  return (msg, command) => {
    if (READ_ONLY_DIRECTIVES.has(command)) return true;

    const explicit = explicitOwners();
    if (explicit.length > 0) {
      return explicit.includes(msg.peerId) || explicit.includes(`${msg.channel}:${msg.peerId}`);
    }

    const owners = channelOwners(msg.channel, config);
    if (owners === null || owners.length === 0) return true; // no owner model configured
    return owners.includes(msg.peerId);
  };
}
