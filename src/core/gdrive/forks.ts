/**
 * @file gdrive/forks.ts
 * @description F25 — brain forks: counterfactual experiments on memory policy.
 * Blobs are shared and immutable, so a fork is just a manifest copy — cheap.
 * The scorecard's Forks tab compares them over a window; adopting a winner
 * re-signs its manifest as main (through F17) and bumps the local counter.
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { BrainKeys } from './keys.js';
import { loadVersionedManifest } from './migrations.js';
import { buildManifest, type BrainManifest } from './manifest.js';
import { MANIFEST_FILE_NAME } from './blob-store.js';
import { loadBrainState, saveBrainState } from './checkpoint.js';

const log = createLogger('gdrive:forks');

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,32}$/;

/** Copy the current main manifest to brains/forks/<name>.json. */
export async function forkBrain(
  client: DriveClient,
  folders: FolderIdMap,
  name: string,
  keys: BrainKeys,
  policyNote?: string,
): Promise<string> {
  if (!NAME_RE.test(name)) throw new Error(`forks: invalid fork name "${name}"`);
  const manifestFolder = folders['manifest'];
  const forksFolder = folders['brains/forks'];
  if (!manifestFolder || !forksFolder) throw new Error('forks: folder ids missing');
  const mf = (await client.listChildren(manifestFolder)).find((f) => f.name === MANIFEST_FILE_NAME);
  if (!mf) throw new Error('forks: no main manifest to fork');
  const main = loadVersionedManifest(JSON.parse(await client.filesDownload(mf.id)), keys.hmacKey);

  // Fork = re-signed manifest with its own brainId (blobs shared, immutable).
  const fork = buildManifest(
    {
      brainId: `fork-${name}`,
      counter: main.counter,
      createdAt: new Date().toISOString(),
      entries: main.entries,
    },
    keys.hmacKey,
  );
  const body = JSON.stringify({ ...fork, policyNote }, null, 2);
  const existing = (await client.listChildren(forksFolder)).find((f) => f.name === `${name}.json`);
  const id = existing
    ? (await client.filesUpdate(existing.id, {}, { mimeType: 'application/json', body }), existing.id)
    : (await client.filesCreate({ name: `${name}.json`, parents: [forksFolder] }, { mimeType: 'application/json', body })).id;
  log.info({ name, counter: fork.counter }, 'brain forked');
  return id;
}

/** Append a fork comparison row (F4 Forks tab). */
export async function recordForkScore(
  client: DriveClient,
  scorecardId: string,
  row: { fork: string; window: string; suite: string; score: number },
): Promise<void> {
  await client.sheetsValuesAppend(scorecardId, 'Forks!A1', [[
    row.fork, row.window, row.suite, row.score, new Date().toISOString(),
  ]]);
}

/** Adopt a winning fork: its manifest becomes main (re-signed, counter+1). */
export async function adoptFork(
  client: DriveClient,
  folders: FolderIdMap,
  name: string,
  keys: BrainKeys,
): Promise<BrainManifest> {
  if (!NAME_RE.test(name)) throw new Error(`forks: invalid fork name "${name}"`);
  const forksFolder = folders['brains/forks'];
  const manifestFolder = folders['manifest'];
  if (!forksFolder || !manifestFolder) throw new Error('forks: folder ids missing');
  const forkFile = (await client.listChildren(forksFolder)).find((f) => f.name === `${name}.json`);
  if (!forkFile) throw new Error(`forks: fork not found: ${name}`);
  const raw = JSON.parse(await client.filesDownload(forkFile.id)) as Record<string, unknown>;
  delete raw['policyNote']; // metadata, not part of the signed body
  const fork = loadVersionedManifest(raw, keys.hmacKey); // signature verified

  const state = loadBrainState();
  const adopted = buildManifest(
    {
      brainId: 'main',
      counter: Math.max(state.counter, fork.counter) + 1,
      createdAt: new Date().toISOString(),
      entries: fork.entries,
    },
    keys.hmacKey,
  );
  const mf = (await client.listChildren(manifestFolder)).find((f) => f.name === MANIFEST_FILE_NAME);
  const body = JSON.stringify(adopted, null, 2);
  if (mf) await client.filesUpdate(mf.id, {}, { mimeType: 'application/json', body });
  else await client.filesCreate({ name: MANIFEST_FILE_NAME, parents: [manifestFolder] }, { mimeType: 'application/json', body });
  saveBrainState({ ...state, counter: adopted.counter });
  log.info({ name, counter: adopted.counter }, 'fork adopted as main');
  return adopted;
}
