/**
 * @file gdrive/hibernate.ts
 * @description F35 — task hibernation: long tasks pause on one machine and
 * resume on another.
 *
 * At safe checkpoints, loop state (plan, step cursor, tool-result digests,
 * pending approvals, seeds) serializes zone-1 (ALWAYS encrypted) to
 * tasks/active/<taskId>.json.enc. Resume verifies brain-counter compatibility
 * and claims the task via the F14 blackboard (single-writer, advisory).
 * Completed/abandoned tasks archive out of active/ (trash — recoverable).
 *
 * The loop-side "call hibernate at safe checkpoints" integration is a
 * documented seam — this module is the transport + claim logic.
 */

import { Readable } from 'node:stream';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { BrainKeys } from './keys.js';
import { encryptZone1, decryptZone1 } from './zones.js';
import { getInstanceId, readPeers, resolveClaim, writeMyStatus } from './blackboard.js';

const log = createLogger('gdrive:hibernate');

export interface HibernatedTask {
  schemaVersion: 1;
  taskId: string;
  plan: string;
  stepCursor: number;
  toolResultDigests: string[];
  pendingApprovals: string[];
  seeds?: Record<string, number>;
  /** Brain manifest counter at hibernation (compatibility check on resume). */
  brainCounter: number;
  hibernatedAt: string;
  hibernatedBy: string;
}

function taskFileName(taskId: string): string {
  return `${taskId}.json.enc`;
}

/** Serialize + upload (encrypted) the task state at a safe checkpoint. */
export async function hibernateTask(
  client: DriveClient,
  folders: FolderIdMap,
  keys: BrainKeys,
  task: Omit<HibernatedTask, 'schemaVersion' | 'hibernatedAt' | 'hibernatedBy'>,
): Promise<string> {
  if (!keys.encKey) throw new Error('hibernate: BRAIN_ENC_KEY_PATH required (task state is zone 1)');
  const folderId = folders['tasks/active'];
  if (!folderId) throw new Error('hibernate: tasks/active folder id missing');
  if (!/^[\w-]{1,64}$/.test(task.taskId)) throw new Error(`hibernate: invalid taskId "${task.taskId}"`);

  const full: HibernatedTask = {
    schemaVersion: 1,
    ...task,
    hibernatedAt: new Date().toISOString(),
    hibernatedBy: getInstanceId(),
  };
  const wire = encryptZone1(Buffer.from(JSON.stringify(full), 'utf-8'), keys.encKey);
  const name = taskFileName(task.taskId);
  const media = { mimeType: 'application/octet-stream', body: Readable.from(wire) };
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  const fileId = existing
    ? (await client.filesUpdate(existing.id, {}, media), existing.id)
    : (await client.filesCreate({ name, parents: [folderId] }, media)).id;
  log.info({ taskId: task.taskId, stepCursor: task.stepCursor }, 'task hibernated');
  return fileId;
}

export type ResumeOutcome =
  | { action: 'resumed'; task: HibernatedTask }
  | { action: 'claimed-elsewhere'; winner: string }
  | { action: 'not-found' }
  | { action: 'incompatible'; reason: string };

/**
 * Resume on any machine: claim via blackboard (earliest-timestamp-wins),
 * download + decrypt, verify counter compatibility (local brain must be at
 * least as new — hydrate first when behind).
 */
export async function resumeTask(
  client: DriveClient,
  folders: FolderIdMap,
  keys: BrainKeys,
  taskId: string,
  localBrainCounter: number,
): Promise<ResumeOutcome> {
  if (!keys.encKey) throw new Error('hibernate: BRAIN_ENC_KEY_PATH required');
  const folderId = folders['tasks/active'];
  if (!folderId) throw new Error('hibernate: tasks/active folder id missing');

  // Advisory single-writer claim (F14).
  const claimedAt = new Date().toISOString();
  await writeMyStatus(client, folders, {
    status: `resuming ${taskId}`,
    claims: [{ taskId, claimedAt }],
  });
  const peers = await readPeers(client, folders);
  const claim = resolveClaim(taskId, claimedAt, peers);
  if (!claim.held) {
    await writeMyStatus(client, folders, { status: 'idle', claims: [] });
    return { action: 'claimed-elsewhere', winner: claim.winner! };
  }

  const file = (await client.listChildren(folderId)).find((f) => f.name === taskFileName(taskId));
  if (!file) return { action: 'not-found' };
  const wire = await client.filesDownloadRaw(file.id);
  const task = JSON.parse(decryptZone1(wire, keys.encKey).toString('utf-8')) as HibernatedTask;
  if (task.schemaVersion !== 1) {
    return { action: 'incompatible', reason: `unknown task schemaVersion ${String(task.schemaVersion)}` };
  }
  if (task.brainCounter > localBrainCounter) {
    // The hibernating machine knew MORE than we do — hydrate first (F2), then retry.
    return {
      action: 'incompatible',
      reason: `task expects brain counter >= ${task.brainCounter}, local is ${localBrainCounter} — run restore-check first`,
    };
  }
  log.info({ taskId, stepCursor: task.stepCursor, from: task.hibernatedBy }, 'task resumed');
  return { action: 'resumed', task };
}

/** Archive a completed/abandoned task out of active/ (Drive trash — 30d undo). */
export async function archiveTask(
  client: DriveClient,
  folders: FolderIdMap,
  taskId: string,
): Promise<boolean> {
  const folderId = folders['tasks/active'];
  if (!folderId) return false;
  const file = (await client.listChildren(folderId)).find((f) => f.name === taskFileName(taskId));
  if (!file) return false;
  await client.filesUpdate(file.id, { trashed: true });
  return true;
}
