/**
 * @file transcript.ts
 * @description Upgrade 45 — Session transcript recording and persistence.
 *
 * Maintains an ordered log of all messages (user, assistant, tool, system)
 * within a session and can flush it to disk as structured JSON.
 */

import { createLogger } from '../shared/logger.js';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

const log = createLogger('sessions:transcript');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: string;
  toolName?: string;
}

export interface Transcript {
  sessionId: string;
  entries: TranscriptEntry[];
  startedAt: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// In-process store
// ---------------------------------------------------------------------------

const transcripts: Map<string, Transcript> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise a new transcript for the given session.
 *
 * Calling this a second time for the same sessionId replaces the existing
 * transcript — intentional so that session restarts get a clean slate.
 *
 * @param sessionId - Unique session identifier.
 * @param model     - Optional model name to attach to the transcript header.
 */
export function startTranscript(sessionId: string, model?: string): Transcript {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('startTranscript: sessionId is required');
  }

  const t: Transcript = {
    sessionId,
    entries: [],
    startedAt: new Date().toISOString(),
    model,
  };

  transcripts.set(sessionId, t);
  log.info({ sessionId, model }, 'Transcript started');
  return t;
}

/**
 * Append a single entry to an existing transcript.
 * Silently no-ops when the sessionId is not found so hot-path callers
 * do not need to guard every call.
 *
 * @param sessionId - Target session.
 * @param role      - Message role.
 * @param content   - Raw text content.
 * @param toolName  - Tool identifier (only relevant when role === 'tool').
 */
export function addEntry(
  sessionId: string,
  role: TranscriptEntry['role'],
  content: string,
  toolName?: string,
): void {
  const t = transcripts.get(sessionId);
  if (!t) {
    log.debug({ sessionId }, 'addEntry: no transcript found for session — skipping');
    return;
  }

  t.entries.push({
    role,
    content,
    timestamp: new Date().toISOString(),
    toolName,
  });
}

/**
 * Retrieve the transcript for a session without modifying it.
 *
 * @returns Transcript or undefined if the session is unknown.
 */
export function getTranscript(sessionId: string): Transcript | undefined {
  return transcripts.get(sessionId);
}

/**
 * Persist the transcript for a session to disk as JSON.
 *
 * @param sessionId - Session whose transcript to save.
 * @param dir       - Target directory (created if absent).
 * @returns Absolute path of the written file.
 */
export async function saveTranscript(
  sessionId: string,
  dir: string = 'data/transcripts',
): Promise<string> {
  const t = transcripts.get(sessionId);
  if (!t) throw new Error(`saveTranscript: no transcript found for session "${sessionId}"`);

  await mkdir(dir, { recursive: true });

  const filepath = path.join(dir, `${sessionId}.json`);
  await writeFile(filepath, JSON.stringify(t, null, 2), 'utf8');

  log.info({ sessionId, entries: t.entries.length, filepath }, 'Transcript saved');
  return filepath;
}

/**
 * Convenience alias: save and return the filepath.
 * Useful for share-via-link workflows where the caller only needs the path.
 */
export async function shareTranscript(sessionId: string): Promise<string> {
  return saveTranscript(sessionId);
}
