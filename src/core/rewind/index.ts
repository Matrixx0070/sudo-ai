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
import { createLogger } from '../shared/logger.js';
import {
  addSnapshot,
  createCheckpoint,
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
): number | null {
  if (!rewindEnabled()) return null;
  try {
    const paths = pathsForTool(toolName, params);
    if (paths.length === 0) return null;

    const id = createCheckpoint(sessionId, `before ${toolName}`, toolName);
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
