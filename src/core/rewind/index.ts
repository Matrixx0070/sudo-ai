/**
 * @file index.ts
 * @description Rewind engine — auto-snapshot before file-mutating tools, and
 * restore a checkpoint's files.
 *
 * The snapshot hook lives at the ToolRegistry choke point, so EVERY current and
 * future file-mutating tool is covered by one interception rather than each
 * tool remembering to back itself up. It is fail-open by contract: a rewind
 * failure must never block the user's actual work.
 *
 * Disable with SUDO_REWIND=0.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import {
  addSnapshot,
  rewindRoot,
  createCheckpoint,
  getMessageBoundary,
  setMessageBoundary,
  getBlob,
  getCheckpoint,
  getSnapshots,
  listCheckpoints,
  putBlob,
} from './store.js';

const log = createLogger('rewind');

/**
 * Tools that mutate files on disk, mapped to the params that may carry a path.
 * Keep this list explicit: snapshotting on a guess would copy unrelated files.
 */
const MUTATING_TOOLS: Record<string, string[]> = {
  'coder.write-file': ['path', 'filePath'],
  'coder.edit-file': ['path', 'filePath'],
  'coder.apply-patch': ['path', 'filePath', 'file'],
  'fs.write': ['path', 'filePath'],
  'fs.delete': ['path', 'filePath'],
  'fs.move': ['source', 'from', 'path'],
};

export function rewindEnabled(): boolean {
  return process.env['SUDO_REWIND'] !== '0';
}

/** Paths this tool call may mutate (absolute paths only). */
export function pathsForTool(toolName: string, params: Record<string, unknown>): string[] {
  const keys = MUTATING_TOOLS[toolName];
  if (!keys) return [];
  const out: string[] = [];
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.trim() !== '' && isAbsolute(v)) out.push(v);
  }
  return out;
}

/**
 * Snapshot the files a tool call is about to mutate. Returns the checkpoint id,
 * or null when nothing was captured. NEVER throws.
 */
export function snapshotBeforeTool(
  toolName: string,
  params: Record<string, unknown>,
  sessionId: string,
  mindDbPath?: string,
): number | null {
  if (!rewindEnabled()) return null;
  try {
    const paths = pathsForTool(toolName, params);
    if (paths.length === 0) return null;

    const id = createCheckpoint(sessionId, `before ${toolName}`, toolName);
    // Conversation half: remember where the transcript stood. Files alone are a
    // half-undo — you revert the code but the model still "remembers" doing it.
    setMessageBoundary(id, currentMessageBoundary(sessionId, mindDbPath));
    let captured = 0;
    for (const p of paths) {
      const existed = existsSync(p);
      // A file that does not exist yet is still recorded: restoring the
      // checkpoint must DELETE it (that is what "undo a create" means).
      const sha = existed ? putBlob(p) : null;
      addSnapshot(id, p, sha, existed);
      captured += 1;
    }
    log.debug({ checkpoint: id, tool: toolName, captured }, 'rewind checkpoint created');
    return id;
  } catch (err) {
    log.warn({ err: String(err), tool: toolName }, 'rewind snapshot failed (fail-open)');
    return null;
  }
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  skipped: string[];
}

/**
 * Restore every file captured in a checkpoint to its pre-tool state. Files that
 * did not exist before are deleted; files whose blob is missing are skipped.
 */
export function restoreCheckpoint(checkpointId: number): RestoreResult {
  const result: RestoreResult = { restored: [], deleted: [], skipped: [] };
  const snaps = getSnapshots(checkpointId);
  for (const s of snaps) {
    try {
      if (s.existedBefore === 0) {
        if (existsSync(s.path)) rmSync(s.path, { force: true });
        result.deleted.push(s.path);
        continue;
      }
      if (!s.sha256) {
        result.skipped.push(s.path);
        continue;
      }
      const buf = getBlob(s.sha256);
      if (!buf) {
        result.skipped.push(s.path);
        continue;
      }
      mkdirSync(dirname(s.path), { recursive: true });
      writeFileSync(s.path, buf);
      result.restored.push(s.path);
    } catch (err) {
      log.warn({ err: String(err), path: s.path }, 'rewind restore failed for path');
      result.skipped.push(s.path);
    }
  }
  return result;
}

/** True when the file currently on disk differs from what the checkpoint holds. */
export function checkpointDiffers(checkpointId: number): boolean {
  for (const s of getSnapshots(checkpointId)) {
    const nowExists = existsSync(s.path);
    if ((s.existedBefore === 1) !== nowExists) return true;
    if (nowExists && s.sha256) {
      const blob = getBlob(s.sha256);
      if (!blob) continue;
      try {
        if (!blob.equals(readFileSync(s.path))) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

export { listCheckpoints, getCheckpoint, getSnapshots };


// ---------------------------------------------------------------------------
// Conversation rewind
// ---------------------------------------------------------------------------

/**
 * Highest message id currently stored for a session, or null when unknown.
 * Opens its own READ connection to the memory DB: the rewind store is
 * standalone, and threading a live handle through the ToolRegistry hook would
 * couple the choke point to memory internals for no gain (SQLite WAL supports
 * concurrent readers).
 */
export function currentMessageBoundary(sessionId: string, mindDbPath?: string): number | null {
  try {
    const d = new Database(mindDbPath ?? dataPath('mind.db'), { readonly: true, fileMustExist: true });
    try {
      const row = d.prepare('SELECT MAX(id) AS m FROM messages WHERE session_id = ?').get(sessionId) as
        | { m: number | null }
        | undefined;
      return row?.m ?? null;
    } finally {
      d.close();
    }
  } catch (err) {
    log.debug({ err: String(err), sessionId }, 'message boundary unavailable (files-only checkpoint)');
    return null;
  }
}

export interface ConversationRestoreResult {
  ok: boolean;
  removed: number;
  archivedTo?: string;
  reason?: string;
}

/**
 * Drop every message the session recorded AFTER the checkpoint, so the model's
 * transcript matches the restored files.
 *
 * Removed messages are ARCHIVED to a blob first — a rewind must itself be
 * undoable, or "undo" becomes the most destructive button in the product.
 */
export function restoreConversation(checkpointId: number, mindDbPath?: string): ConversationRestoreResult {
  const ckpt = getCheckpoint(checkpointId);
  if (!ckpt) return { ok: false, removed: 0, reason: `no checkpoint #${checkpointId}` };
  const boundary = getMessageBoundary(checkpointId);
  if (boundary === null) {
    return { ok: false, removed: 0, reason: 'checkpoint has no conversation boundary (files-only)' };
  }
  try {
    const d = new Database(mindDbPath ?? dataPath('mind.db'));
    try {
      const doomed = d
        .prepare('SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id')
        .all(ckpt.sessionId, boundary) as Array<Record<string, unknown>>;
      if (doomed.length === 0) return { ok: true, removed: 0 };

      const archivePath = join(rewindRoot(), `conv-${checkpointId}-${boundary}.json`);
      writeFileSync(archivePath, JSON.stringify(doomed, null, 2));

      d.prepare('DELETE FROM messages WHERE session_id = ? AND id > ?').run(ckpt.sessionId, boundary);
      log.info({ checkpointId, removed: doomed.length, archivePath }, 'conversation rewound');
      return { ok: true, removed: doomed.length, archivedTo: archivePath };
    } finally {
      d.close();
    }
  } catch (err) {
    return { ok: false, removed: 0, reason: `conversation restore failed: ${String(err).slice(0, 160)}` };
  }
}
