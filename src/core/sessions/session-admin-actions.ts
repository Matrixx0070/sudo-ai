/**
 * @file sessions/session-admin-actions.ts
 * @description BO9 / scorecard-S8 — pure decision logic for the two admin
 * session actions surfaced by the inline dashboard: FORK and ARCHIVE.
 *
 * These are PURE functions: no DB, no I/O, no clock except an injectable `now`.
 * The admin handler (`src/core/api/admin/system-sessions.handler.ts`) calls
 * these to decide WHAT to do, then applies the result through the read/write
 * store helpers in `sessions.db-utils.ts`.
 *
 * Two beat-OpenClaw guarantees are encoded here as testable invariants:
 *
 *  1. FORK is ADDITIVE. `buildForkedSession` copies the source's message history
 *     into a brand-new session object and NEVER mutates the source. OpenClaw's
 *     Fork was verified to copy history to a new session; we match that and keep
 *     the original intact (HARD RULE: fork is additive).
 *
 *  2. ARCHIVE REQUIRES CONFIRMATION. OpenClaw archives instantly with NO confirm
 *     (one of their 8 catalogued defects). `planArchive` REJECTS any call that
 *     does not carry an explicit confirm flag/token, and archive is modelled as a
 *     reversible state change (state → 'archived'), never a hard delete.
 */

import type { SessionRollupState } from './sessions-rollup.js';

// ---------------------------------------------------------------------------
// Minimal session shapes (decoupled from sessions/types.ts to stay pure)
// ---------------------------------------------------------------------------

/** A single message, copied verbatim on fork. */
export interface ForkableMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
}

/** The source session a fork/archive acts on. */
export interface ForkableSession {
  id: string;
  channel: string;
  peerId: string;
  state: SessionRollupState;
  model?: string;
  messages: ForkableMessage[];
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Archive — confirm gate
// ---------------------------------------------------------------------------

export interface ArchiveRequest {
  /** Explicit confirmation. Only boolean `true` (or the literal string 'true'
   *  / the session id as a typed token) authorizes the archive. */
  confirm?: boolean | string;
  /** The session id the caller intends to archive (used for token-style confirm). */
  id: string;
}

export type ArchivePlan =
  | { ok: true; id: string; nextState: 'archived' }
  | { ok: false; code: 'confirm_required' | 'already_archived' | 'not_found'; message: string };

/**
 * True only when the caller supplied an explicit, unambiguous confirmation:
 *   - boolean `true`
 *   - the string 'true'
 *   - a token string exactly equal to the target session id (type-to-confirm)
 * Everything else (undefined, false, '', 'false', wrong id) is NOT a confirm.
 */
export function isConfirmed(confirm: boolean | string | undefined, id: string): boolean {
  if (confirm === true) return true;
  if (typeof confirm === 'string') {
    const c = confirm.trim();
    return c === 'true' || (c.length > 0 && c === id);
  }
  return false;
}

/**
 * Decide whether an archive may proceed. The confirm gate is the whole point:
 * a request without an explicit confirmation is REJECTED with `confirm_required`
 * so the dashboard must pop its confirm dialog before the mutation runs. An
 * already-archived session is a no-op success signalled distinctly.
 */
export function planArchive(
  req: ArchiveRequest,
  current: { state: SessionRollupState } | null,
): ArchivePlan {
  if (!current) {
    return { ok: false, code: 'not_found', message: `Session not found: ${req.id}` };
  }
  if (!isConfirmed(req.confirm, req.id)) {
    return {
      ok: false,
      code: 'confirm_required',
      message:
        'Archive requires explicit confirmation (confirm=true or type the session id). ' +
        'Unlike OpenClaw, SUDO-AI never archives without a confirm.',
    };
  }
  if (current.state === 'archived') {
    return { ok: false, code: 'already_archived', message: `Session already archived: ${req.id}` };
  }
  return { ok: true, id: req.id, nextState: 'archived' };
}

// ---------------------------------------------------------------------------
// Fork — additive copy of history
// ---------------------------------------------------------------------------

export interface ForkOptions {
  /** Id for the new session (injected so callers control id generation). */
  newId: string;
  /** Reference "now" for the new session's timestamps. */
  now?: Date;
  /**
   * Peer id for the fork. Defaults to a derived, collision-free peer
   * (`${peerId}#fork:${newId}`) so the copy never hijacks the live peer's single
   * active session. Pass an explicit value to override.
   */
  peerId?: string;
  /** Prepend a durable system notice recording the fork lineage. Default true. */
  addNotice?: boolean;
}

/** Deep-copy a message so the fork shares no references with the source. */
function copyMessage(m: ForkableMessage): ForkableMessage {
  const out: ForkableMessage = { role: m.role, content: m.content };
  if (m.toolName !== undefined) out.toolName = m.toolName;
  if (m.toolInput !== undefined) out.toolInput = m.toolInput;
  if (m.toolOutput !== undefined) out.toolOutput = m.toolOutput;
  return out;
}

export interface ForkedSession extends ForkableSession {
  /** The id of the session this was forked from. */
  forkedFrom: string;
}

/**
 * Build a new session that copies the source's full message history. ADDITIVE:
 * the returned object is brand-new and the `source` argument is never mutated
 * (verified in tests). The new session is `active`, carries a derived peer id to
 * avoid colliding with the live peer's active session, and — by default —
 * prepends a durable `[SESSION FORK]` notice recording lineage.
 */
export function buildForkedSession(source: ForkableSession, opts: ForkOptions): ForkedSession {
  const now = opts.now ?? new Date();
  const peerId = opts.peerId ?? `${source.peerId}#fork:${opts.newId}`;
  const addNotice = opts.addNotice !== false;

  const copied = source.messages.map(copyMessage);
  const messages: ForkableMessage[] = addNotice
    ? [
        {
          role: 'system',
          content: `[SESSION FORK — copied from ${source.id}] Full history below was duplicated by an admin fork; the original session is unchanged.`,
        },
        ...copied,
      ]
    : copied;

  return {
    id: opts.newId,
    channel: source.channel,
    peerId,
    state: 'active',
    ...(source.model !== undefined ? { model: source.model } : {}),
    messages,
    createdAt: now,
    updatedAt: now,
    forkedFrom: source.id,
  };
}
