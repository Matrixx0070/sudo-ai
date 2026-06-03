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

// Wave 4b: SQLite Session Store
export { SqliteSessionStore, SessionStoreError } from './sqlite-session-store.js';
export type { SessionRow, MessageRow, ListSessionsOptions } from './sqlite-session-store.js';
export { migrateJsonlToSqlite } from './migrate-jsonl.js';

// Wave 5: Session State Machine + REST Routes
export { SessionStateMachine, SessionStateError } from './state-machine.js';
export type { SessionStatus } from './state-machine.js';
export { registerSessionRoutes, buildSessionRouteDeps } from './routes.js';
export type { SessionRouteDeps } from './routes.js';

// Session Lanes: Multi-lane task queue
export { SessionLaneManager, getLaneManager, resetLaneManager } from './session-lanes.js';
export type { SessionLaneType } from './session-lanes.js';
