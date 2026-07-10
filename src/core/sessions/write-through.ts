/**
 * @file write-through.ts
 * @description Write-through message persistence — closes the last structural
 * hole in the session-persist design.
 *
 * History (four bug campaigns in one subsystem): #437 a mid-scan throw dropped
 * the rest of a turn; #445-447 stale meta rows lost whole chats; #450/#451
 * ephemeral system spam diluted hydrates; #659 anything appended AFTER the
 * end-of-run save existed only in memory (live casualty: a guard-revised final
 * answer, delivered to the user, permanently lost to a restart). Phase 2a
 * fixed re-scan correctness with per-message `_persisted` markers, but
 * persistence still only HAPPENS at save() call sites — the invariant "what is
 * pushed gets stored" lived in call-site discipline.
 *
 * This module moves the invariant into the data structure: `push` on a
 * session's message array persists each appended message immediately
 * (synchronous better-sqlite3 INSERT, microseconds under WAL), using the SAME
 * skip rules and `_persisted` markers as the save() scan, which remains in
 * place as an idempotent safety net (it catches messages that bypass the
 * wrapper when code REASSIGNS `session.messages` to a fresh array — ~10 such
 * sites in windowing/compaction/fork; save() re-attaches the wrapper).
 *
 * Failure policy (matches the house poison-message rule): a failed immediate
 * write leaves the message UNMARKED so the next save() scan makes the second
 * and final attempt (the scan marks even on failure). Exactly two attempts,
 * never an infinite retry.
 *
 * Kill-switch: SUDO_WRITE_THROUGH_PERSIST=0 reverts to scan-only persistence.
 */

import { createLogger } from '../shared/logger.js';
import { isZDRBlocked } from '../privacy/zdr-mode.js';

const log = createLogger('sessions:write-through');

// ---------------------------------------------------------------------------
// Types (structural — mirror the manager's message shape without coupling)
// ---------------------------------------------------------------------------

export interface PersistableMessage {
  role: string;
  content?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  _persisted?: boolean;
  _ephemeral?: boolean;
  _durable?: boolean;
}

export interface MessageSink {
  storeMessage(
    sessionId: string,
    role: string,
    content: string,
    opts: { tool_name?: string; tool_input?: string; tool_output?: string },
  ): unknown;
}

export interface WriteThroughSession {
  id: string;
  messages: PersistableMessage[];
}

// ---------------------------------------------------------------------------
// Env gate + shared skip rule
// ---------------------------------------------------------------------------

/** Default ON per repo policy; SUDO_WRITE_THROUGH_PERSIST=0 reverts to scan-only. */
export function isWriteThroughEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_WRITE_THROUGH_PERSIST'] !== '0';
}

/**
 * The identity-scan's persistence policy, shared verbatim: ephemeral messages
 * and non-`_durable` system messages are skipped (marked persisted, never
 * written) unless SUDO_PERSIST_EPHEMERAL=1 restores write-all.
 */
export function shouldSkipPersist(msg: PersistableMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['SUDO_PERSIST_EPHEMERAL'] === '1') return false;
  return msg._ephemeral === true || (msg.role === 'system' && msg._durable !== true);
}

// ---------------------------------------------------------------------------
// Immediate persistence of one message
// ---------------------------------------------------------------------------

export type PersistOutcome = 'persisted' | 'skipped' | 'already' | 'zdr' | 'failed';

/** Persist a single just-appended message; never throws. */
export function persistMessageNow(sink: MessageSink, sessionId: string, msg: PersistableMessage): PersistOutcome {
  try {
    if (msg._persisted === true) return 'already';
    if (shouldSkipPersist(msg)) {
      msg._persisted = true; // same bookkeeping as the scan
      return 'skipped';
    }
    if (isZDRBlocked('session_persistence')) return 'zdr'; // unmarked: persists later if ZDR lifts
    sink.storeMessage(sessionId, msg.role, msg.content ?? '', {
      tool_name: msg.toolName ?? undefined,
      tool_input: msg.toolInput ?? undefined,
      tool_output: msg.toolOutput ?? undefined,
    });
    msg._persisted = true;
    return 'persisted';
  } catch (err) {
    // Leave UNMARKED: the save() scan makes the second and final attempt.
    log.warn({ sessionId, role: msg.role, err: String(err) }, 'write-through persist failed — save() scan will retry once');
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

const WT_FLAG = '_writeThroughAttached';

/**
 * Wrap `session.messages.push` so every append persists immediately. Safe to
 * call repeatedly (idempotent per array instance); call again after code
 * reassigns `session.messages` — the manager does so on every save().
 * The override is non-enumerable: JSON serialization, spreads, and iteration
 * of the array are unaffected.
 */
export function attachWriteThrough(session: WriteThroughSession, sink: MessageSink): void {
  if (!isWriteThroughEnabled()) return;
  const arr = session.messages as PersistableMessage[] & { [WT_FLAG]?: boolean };
  if (!Array.isArray(arr) || arr[WT_FLAG] === true) return;
  const origPush = Array.prototype.push;
  try {
    Object.defineProperty(arr, 'push', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: function writeThroughPush(this: PersistableMessage[], ...items: PersistableMessage[]): number {
        const result = origPush.apply(this, items);
        for (const item of items) {
          if (item && typeof item === 'object') persistMessageNow(sink, session.id, item);
        }
        return result;
      },
    });
    Object.defineProperty(arr, WT_FLAG, { enumerable: false, configurable: true, value: true });
  } catch (err) {
    log.warn({ sessionId: session.id, err: String(err) }, 'write-through attach failed — scan-only persistence for this session');
  }
}
