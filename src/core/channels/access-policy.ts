/**
 * @file access-policy.ts
 * @description Centralized per-channel owner allowlist for the gateway
 * (Multi-Channel Gateway, Feature 1 — Step 2 "resolve isOwner from allowlist
 * BEFORE the message reaches the agent loop; non-allowlisted senders silently
 * dropped + audit-logged").
 *
 * Today admission is decided ad-hoc inside each adapter with three different
 * default postures (Telegram deny-by-default, Discord/WhatsApp allow-all,
 * Signal/Matrix/IRC ungated — anyone can talk to them). This makes one policy
 * the gateway consults for every channel it routes.
 *
 * Design:
 *  - A channel with an explicit policy block is deny-by-default WITHIN that
 *    channel: the sender must be an owner, an allowed peer, or the block must be
 *    `open`. This is how you lock a channel to yourself.
 *  - A channel with NO block falls to the global `defaultDeny` (default false),
 *    so adding a policy for one channel never silently locks out another that
 *    still relies on its own adapter-level gate. Set `defaultDeny: true` to lock
 *    everything not explicitly allowed.
 *  - `'*'` wildcard in owners/allowedPeers is an explicit escape hatch.
 *
 * resolve() is pure and synchronous so it can run in the router's hot path.
 */

import type { ChannelType } from './types.js';

export interface ChannelPolicy {
  /** Sender IDs treated as the owner (full trust; isOwner=true). '*' = everyone. */
  owners?: string[];
  /** Sender IDs admitted but NOT owner. '*' = everyone admitted. */
  allowedPeers?: string[];
  /** Admit everyone on this channel (isOwner still only true for `owners`). */
  open?: boolean;
}

export interface ChannelAccessConfig {
  /** Posture for channels with no explicit block. Default false (admit). */
  defaultDeny?: boolean;
  /** Per-channel policy blocks. */
  channels?: Partial<Record<ChannelType, ChannelPolicy>>;
}

export interface AccessDecision {
  admit: boolean;
  isOwner: boolean;
  reason: string;
}

const has = (list: string[] | undefined, id: string): boolean =>
  Array.isArray(list) && (list.includes(id) || list.includes('*'));

export class ChannelAccessPolicy {
  private readonly defaultDeny: boolean;
  private readonly channels: Partial<Record<ChannelType, ChannelPolicy>>;

  constructor(config: ChannelAccessConfig = {}) {
    this.defaultDeny = config.defaultDeny === true;
    this.channels = config.channels ?? {};
  }

  /** A no-op policy that admits everyone (used when no config is loaded). */
  static permissive(): ChannelAccessPolicy {
    return new ChannelAccessPolicy({ defaultDeny: false });
  }

  /** True when at least one channel is gated — lets callers skip the gate cheaply. */
  get active(): boolean {
    return this.defaultDeny || Object.keys(this.channels).length > 0;
  }

  /**
   * Decide whether a sender on a channel may reach the agent, and whether they
   * are the owner. Pure + synchronous.
   */
  resolve(channel: ChannelType, senderId: string): AccessDecision {
    const id = String(senderId ?? '');
    const policy = this.channels[channel];

    if (!policy) {
      return this.defaultDeny
        ? { admit: false, isOwner: false, reason: 'no-policy + defaultDeny' }
        : { admit: true, isOwner: false, reason: 'no-policy (default admit)' };
    }

    const isOwner = has(policy.owners, id);
    if (isOwner) return { admit: true, isOwner: true, reason: 'owner' };
    if (policy.open) return { admit: true, isOwner: false, reason: 'channel open' };
    if (has(policy.allowedPeers, id)) return { admit: true, isOwner: false, reason: 'allowed peer' };

    // Explicit block present but sender not listed → deny-by-default within it.
    return { admit: false, isOwner: false, reason: 'not in channel allowlist' };
  }
}
