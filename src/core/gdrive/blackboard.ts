/**
 * @file gdrive/blackboard.ts
 * @description F14 — multi-instance blackboard. Honestly a bulletin board:
 * one file per instance (single-writer-per-file sidesteps Drive's lack of
 * locking), slow-cycle peer reads, ADVISORY coarse task claims resolved by
 * earliest-timestamp-wins. Seconds-to-minutes latency, best-effort, never a
 * correctness-critical channel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

const log = createLogger('gdrive:blackboard');

export interface BlackboardStatus {
  instanceId: string;
  host: string;
  pid: number;
  lastBeat: string;
  status: string;
  claims: Array<{ taskId: string; claimedAt: string }>;
  discoveries: string[];
}

function instanceIdPath(): string {
  return dataPath('gdrive', 'instance-id.json');
}

/** Stable per-installation instance id. */
export function getInstanceId(): string {
  try {
    const parsed = JSON.parse(readFileSync(instanceIdPath(), 'utf-8')) as { id?: string };
    if (parsed.id) return parsed.id;
  } catch {
    /* create below */
  }
  const id = `inst-${randomUUID().slice(0, 8)}`;
  mkdirSync(dirname(instanceIdPath()), { recursive: true });
  writeFileSync(instanceIdPath(), JSON.stringify({ id }), { mode: 0o600 });
  return id;
}

function myFileIdPath(): string {
  return dataPath('gdrive', 'blackboard-file-id.json');
}

/** Write MY status file (create once, update in place). */
export async function writeMyStatus(
  client: DriveClient,
  folders: FolderIdMap,
  params: { status: string; claims?: Array<{ taskId: string; claimedAt: string }>; discoveries?: string[] },
): Promise<BlackboardStatus> {
  const folderId = folders['tasks/blackboard'];
  if (!folderId) throw new Error('gdrive blackboard: tasks/blackboard folder id missing');
  const me: BlackboardStatus = {
    instanceId: getInstanceId(),
    host: hostname(),
    pid: process.pid,
    lastBeat: new Date().toISOString(),
    status: params.status,
    claims: params.claims ?? [],
    discoveries: (params.discoveries ?? []).slice(-20),
  };
  const media = { mimeType: 'application/json', body: JSON.stringify(me, null, 2) };

  let fileId: string | null = null;
  try {
    fileId = (JSON.parse(readFileSync(myFileIdPath(), 'utf-8')) as { fileId?: string }).fileId ?? null;
  } catch {
    /* first run */
  }
  if (fileId) {
    try {
      await client.filesUpdate(fileId, {}, media);
      return me;
    } catch {
      fileId = null; // stale — re-resolve
    }
  }
  const name = `${me.instanceId}.json`;
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  if (existing) {
    await client.filesUpdate(existing.id, {}, media);
    fileId = existing.id;
  } else {
    fileId = (await client.filesCreate({ name, parents: [folderId] }, media)).id;
  }
  mkdirSync(dirname(myFileIdPath()), { recursive: true });
  writeFileSync(myFileIdPath(), JSON.stringify({ fileId }), { mode: 0o600 });
  return me;
}

/** Read all peers' status files (excluding mine). */
export async function readPeers(client: DriveClient, folders: FolderIdMap): Promise<BlackboardStatus[]> {
  const folderId = folders['tasks/blackboard'];
  if (!folderId) return [];
  const mine = getInstanceId();
  const peers: BlackboardStatus[] = [];
  for (const f of await client.listChildren(folderId)) {
    if (!f.name.endsWith('.json') || f.name === `${mine}.json`) continue;
    try {
      peers.push(JSON.parse(await client.filesDownload(f.id)) as BlackboardStatus);
    } catch {
      /* torn peer file — skip */
    }
  }
  return peers;
}

/**
 * Advisory claim: earliest-timestamp-wins. Returns whether WE hold the claim
 * (a peer with an earlier claim on the same task => back off).
 */
export function resolveClaim(
  taskId: string,
  myClaimedAt: string,
  peers: BlackboardStatus[],
): { held: boolean; winner?: string } {
  for (const peer of peers) {
    const peerClaim = peer.claims.find((c) => c.taskId === taskId);
    if (peerClaim && peerClaim.claimedAt < myClaimedAt) {
      return { held: false, winner: peer.instanceId };
    }
  }
  return { held: true };
}

/** Test/ops probe. */
export function hasInstanceId(): boolean {
  return existsSync(instanceIdPath());
}
