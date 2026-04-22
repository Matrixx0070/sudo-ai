/**
 * @file state-machine.ts
 * @description Wave 5 — Session state machine for SUDO-AI v4.
 *
 * States:
 *   idle        — session created, waiting for input
 *   running     — actively processing a message
 *   rescheduling — transient, will return to idle
 *   terminated  — terminal (no further transitions)
 *   archived    — terminal-preserving (history kept)
 *
 * Valid transitions (source → targets):
 *   idle         → running, rescheduling, terminated, archived
 *   running      → idle, terminated, archived
 *   rescheduling → idle, terminated, archived
 *   terminated   → (none)
 *   archived     → (none)
 *
 * Error: SessionStateError (extends SudoError, code 'session_state_*')
 *   Maps to HTTP 409 Conflict.
 *
 * Hook emitted after each successful transition:
 *   session:status:<newState>  with payload { sessionId, from, to }
 */

import { EventEmitter } from 'node:events';
import type { Database } from 'better-sqlite3';
import { SudoError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sessions:state-machine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All valid session status values. */
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'rescheduling'
  | 'terminated'
  | 'archived';

/** Terminal states — no further transitions are allowed from these. */
const TERMINAL_STATES = new Set<SessionStatus>(['terminated', 'archived']);

/** Valid transition table: from state → allowed destination states */
const VALID_TRANSITIONS = new Map<SessionStatus, ReadonlySet<SessionStatus>>([
  ['idle',         new Set<SessionStatus>(['running', 'rescheduling', 'terminated', 'archived'])],
  ['running',      new Set<SessionStatus>(['idle', 'terminated', 'archived'])],
  ['rescheduling', new Set<SessionStatus>(['idle', 'terminated', 'archived'])],
  ['terminated',   new Set<SessionStatus>()],
  ['archived',     new Set<SessionStatus>()],
]);

// ---------------------------------------------------------------------------
// SessionStateError
// ---------------------------------------------------------------------------

/** Thrown on invalid state transitions. HTTP mapping: 409 Conflict. */
export class SessionStateError extends SudoError {
  public readonly httpStatus = 409;

  constructor(
    message: string,
    code: `session_state_${string}`,
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
    (this as unknown as { name: string }).name = 'SessionStateError';
  }
}

// ---------------------------------------------------------------------------
// Internal DB row
// ---------------------------------------------------------------------------

interface StatusRow {
  status: string;
}

// ---------------------------------------------------------------------------
// SessionStateMachine
// ---------------------------------------------------------------------------

/**
 * Manages state transitions for sessions persisted in SQLite.
 * Extends EventEmitter — emits `session:status:<state>` after each transition.
 */
export class SessionStateMachine extends EventEmitter {
  private readonly db: Database;
  private readonly stmtGetStatus: ReturnType<Database['prepare']>;
  private readonly stmtUpdateStatus: ReturnType<Database['prepare']>;

  constructor(db: Database) {
    super();
    this.db = db;
    this.stmtGetStatus = this.db.prepare(
      `SELECT status FROM sessions WHERE id = ?`,
    );
    this.stmtUpdateStatus = this.db.prepare(
      `UPDATE sessions SET status = :status, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get the current status of a session.
   * @throws SessionStateError if the session does not exist.
   */
  getState(sessionId: string): SessionStatus {
    if (!sessionId) {
      throw new SessionStateError(
        'sessionId is required',
        'session_state_invalid_params',
      );
    }
    const row = this.stmtGetStatus.get(sessionId) as StatusRow | undefined;
    if (!row) {
      throw new SessionStateError(
        `Session not found: ${sessionId}`,
        'session_state_not_found',
        { sessionId },
      );
    }
    return this._coerceStatus(row.status);
  }

  /**
   * Transition a session to a new state.
   * Validates the transition, updates the DB, and emits `session:status:<toState>`.
   *
   * @throws SessionStateError on invalid transition or session not found.
   */
  transition(sessionId: string, toState: SessionStatus): void {
    if (!sessionId) {
      throw new SessionStateError(
        'sessionId is required',
        'session_state_invalid_params',
      );
    }
    if (!VALID_TRANSITIONS.has(toState)) {
      throw new SessionStateError(
        `Unknown target state: ${toState}`,
        'session_state_unknown_target',
        { sessionId, toState },
      );
    }

    const currentState = this.getState(sessionId); // throws if not found

    if (currentState === toState) {
      // No-op: already in target state
      log.debug({ sessionId, state: toState }, 'transition: already in target state (no-op)');
      return;
    }

    const allowed = VALID_TRANSITIONS.get(currentState);
    if (!allowed || !allowed.has(toState)) {
      throw new SessionStateError(
        `Invalid transition: ${currentState} → ${toState}`,
        'session_state_invalid_transition',
        { sessionId, from: currentState, to: toState },
      );
    }

    const info = this.stmtUpdateStatus.run({ status: toState, id: sessionId });
    if (info.changes === 0) {
      // Row disappeared between getState and update (race); treat as not found
      throw new SessionStateError(
        `Session not found during transition: ${sessionId}`,
        'session_state_not_found',
        { sessionId },
      );
    }

    log.info({ sessionId, from: currentState, to: toState }, 'session state transition');
    this.emit(`session:status:${toState}`, { sessionId, from: currentState, to: toState });
  }

  /**
   * Returns true if `state` is a terminal state (no transitions allowed).
   */
  isTerminal(state: SessionStatus): boolean {
    return TERMINAL_STATES.has(state);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Coerce raw DB string to SessionStatus, defaulting to 'idle' if unrecognised. */
  private _coerceStatus(raw: string): SessionStatus {
    if (VALID_TRANSITIONS.has(raw as SessionStatus)) {
      return raw as SessionStatus;
    }
    log.warn({ raw }, 'Unrecognised session status — defaulting to idle');
    return 'idle';
  }
}
