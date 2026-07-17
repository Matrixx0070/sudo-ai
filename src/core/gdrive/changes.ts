/**
 * @file gdrive/changes.ts
 * @description F22 changes-feed sweep — never re-list the tree.
 *
 * Persists Drive's changes page token (data/gdrive/changes-token.json) and,
 * per sweep, maps edited/deleted files onto the beliefs graph: edits flag
 * dependents stale, deletions orphan them. Also feeds the world mirror (F37)
 * diff path when the changed file lives under knowledge/mirror/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import { loadBeliefs, saveBeliefs, flagSourceChanged, flagSourceDeleted } from './beliefs.js';

const log = createLogger('gdrive:changes');

function tokenPath(): string {
  return dataPath('gdrive', 'changes-token.json');
}

export function loadChangesToken(): string | null {
  try {
    return (JSON.parse(readFileSync(tokenPath(), 'utf-8')) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

export function saveChangesToken(token: string): void {
  const p = tokenPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ token }), { mode: 0o600 });
}

export interface ChangesSweepResult {
  changes: number;
  staledBeliefs: string[];
  orphanedBeliefs: string[];
}

/** One changes-feed sweep. First run just anchors the token (no backfill). */
export async function runChangesSweep(client: DriveClient): Promise<ChangesSweepResult> {
  const result: ChangesSweepResult = { changes: 0, staledBeliefs: [], orphanedBeliefs: [] };
  let token = loadChangesToken();
  if (!token) {
    token = await client.changesGetStartPageToken();
    saveChangesToken(token);
    log.info('changes token anchored (first run)');
    return result;
  }

  const graph = loadBeliefs();
  let dirty = false;
  let pageToken: string | undefined = token;
  while (pageToken) {
    const page = await client.changesList(pageToken);
    for (const change of page.changes) {
      const fileId = change.fileId ?? undefined;
      if (!fileId) continue;
      result.changes++;
      if (change.removed || change.file?.trashed) {
        const orphaned = flagSourceDeleted(graph, fileId);
        result.orphanedBeliefs.push(...orphaned);
        dirty = dirty || orphaned.length > 0;
      } else {
        const staled = flagSourceChanged(graph, fileId);
        result.staledBeliefs.push(...staled);
        dirty = dirty || staled.length > 0;
      }
    }
    if (page.newStartPageToken) {
      saveChangesToken(page.newStartPageToken);
      pageToken = undefined;
    } else {
      pageToken = page.nextPageToken;
    }
  }
  if (dirty) saveBeliefs(graph);
  if (result.staledBeliefs.length || result.orphanedBeliefs.length) {
    log.info(
      { staled: result.staledBeliefs.length, orphaned: result.orphanedBeliefs.length },
      'changes sweep flagged beliefs',
    );
  }
  return result;
}

/** Test/ops probe. */
export function hasChangesToken(): boolean {
  return existsSync(tokenPath());
}
