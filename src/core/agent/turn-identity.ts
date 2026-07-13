/**
 * @file turn-identity.ts
 * @description Canonical session→caller-identity registry. The channel dispatch
 * layer (which knows the sender + the Feature 1 access-policy `isOwner`) records
 * identity here keyed by sessionId; the agent loop reads it when building a
 * ToolContext so EVERY tool — on every channel — can gate on `isOwner` without a
 * per-domain side table.
 *
 * Bounded (identities are cheap to relearn on the next turn). Identity is
 * updated per turn, so a session reused by different peers reflects the latest
 * driver.
 */

export interface TurnIdentity {
  isOwner: boolean;
  channel?: string;
  peerId?: string;
}

const MAX = 4000;
const identities = new Map<string, TurnIdentity>();

/** Record the caller identity for a session's current turn. */
export function setTurnIdentity(sessionId: string, id: TurnIdentity): void {
  if (!sessionId) return;
  if (identities.size >= MAX) identities.clear();
  identities.set(sessionId, { isOwner: id.isOwner === true, ...(id.channel ? { channel: id.channel } : {}), ...(id.peerId ? { peerId: id.peerId } : {}) });
}

/** Identity for a session, or undefined when never recorded. */
export function getTurnIdentity(sessionId: string): TurnIdentity | undefined {
  return identities.get(sessionId);
}

export function __resetTurnIdentityForTests(): void { identities.clear(); }
