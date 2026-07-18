/**
 * @file index.ts
 * @description Public barrel export for the sessions module.
 */

export type { BrainMessage, Session, SessionState, SessionTarget } from './types.js';
export { KeyedAsyncQueue } from './queue.js';
export { SessionManager } from './manager.js';
export { shouldFork, forkSession, FORK_THRESHOLD_CHARS, FORK_MESSAGE_COUNT } from './session-fork.js';
export type { ForkSessionManager, ForkResult } from './session-fork.js';

// Upgrade 45: Session Transcripts
export {
  startTranscript,
  addEntry,
  getTranscript,
  saveTranscript,
  shareTranscript,
} from './transcript.js';
export type { TranscriptEntry, Transcript } from './transcript.js';

// SUDO-AI v5: JSONL Journal
export type {
  JournalEventBase,
  JournalSessionCreated,
  JournalModelChanged,
  JournalMessage,
  JournalToolResult,
  JournalEvent,
  SessionIndexEntry,
  SessionIndex,
} from './journal-types.js';
export { JournalSessionStore } from './journal-store.js';
export { DualSessionManager } from './dual-manager.js';

// SQLite Session Store
export { SqliteSessionStore, SessionStoreError } from './sqlite-session-store.js';
export type { SessionRow, MessageRow, ListSessionsOptions } from './sqlite-session-store.js';
// F99: migrate-jsonl retired 2026-07-18 — prod scan found zero unmigrated legacy
// JSONL stores (no data/sessions.json anywhere) and the migrator had no callers.

// Session State Machine + REST Routes
export { SessionStateMachine, SessionStateError } from './state-machine.js';
export type { SessionStatus } from './state-machine.js';
export { registerSessionRoutes, buildSessionRouteDeps } from './routes.js';
export type { SessionRouteDeps } from './routes.js';

// Session Lineage: Parent chains, frozen snapshots, cross-session FTS5 search
export { SessionLineageTracker } from './session-lineage.js';
export type { SessionLineage, FrozenSnapshot, CrossSessionResult, LineageConfig } from './session-lineage.js';

// Session Rewind: JSONL-based undo history with turn-level checkpointing
export { SessionRewindManager, MAX_REWIND_SIZE, REWIND_POINTS_FILE } from './session-rewind.js';
export type {
  RewindPoint,
  RewindResult,
  AcpRewindPointsRequest,
  AcpRewindPointsResponse,
  AcpRewindExecuteRequest,
  AcpRewindExecuteResponse,
} from './session-rewind.js';
