/**
 * @file gdrive/case-law.ts
 * @description F70 — fleet case law. Precedents the fleet accumulates: a
 * situation + the ruling it settled on. New precedents are PROPOSED to
 * tasks/proposals/ (peer-visible via the F14 blackboard, G-PROPOSALS folder),
 * and only become binding once RATIFIED — pulled into a local ratified store.
 * consultPrecedents() matches the ratified case law against a plan (a pure,
 * hot-path-safe local read, like matchDeadEnds) so the live planner can be
 * reminded "the fleet already ruled on this."
 *
 * Only RATIFIED precedents are ever consulted — a proposal alone is not binding.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import { contentWords } from './error-atlas.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

const log = createLogger('gdrive:case-law');

export interface Precedent {
  id: string;
  situation: string;
  ruling: string;
  rationale: string;
  status: 'proposed' | 'ratified';
  createdAt: string;
  proposedBy?: string;
  ratifiedAt?: string;
}

const ID_RE = /^[\w-]{1,64}$/;

// ---------------------------------------------------------------------------
// Propose (→ Drive tasks/proposals, peer-visible)
// ---------------------------------------------------------------------------

export async function proposePrecedent(
  client: DriveClient,
  folders: FolderIdMap,
  input: { id: string; situation: string; ruling: string; rationale: string; now?: () => Date },
): Promise<string> {
  if (!ID_RE.test(input.id)) throw new Error(`case-law: invalid precedent id "${input.id}"`);
  const folderId = folders['tasks/proposals'];
  if (!folderId) throw new Error('case-law: tasks/proposals folder id missing');
  const { getInstanceId } = await import('./blackboard.js');
  const rec: Precedent = {
    id: input.id, situation: input.situation, ruling: input.ruling, rationale: input.rationale,
    status: 'proposed', createdAt: (input.now ?? (() => new Date()))().toISOString(), proposedBy: getInstanceId(),
  };
  const body = JSON.stringify(rec, null, 2);
  const name = `${input.id}.json`;
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  const id = existing
    ? (await client.filesUpdate(existing.id, {}, { mimeType: 'application/json', body }), existing.id)
    : (await client.filesCreate({ name, parents: [folderId] }, { mimeType: 'application/json', body })).id;
  log.info({ id: input.id }, 'F70 precedent proposed (not binding until ratified)');
  return id;
}

export async function listProposals(client: DriveClient, folders: FolderIdMap): Promise<Precedent[]> {
  const folderId = folders['tasks/proposals'];
  if (!folderId) return [];
  const out: Precedent[] = [];
  for (const f of await client.listChildren(folderId)) {
    if (!f.name.endsWith('.json')) continue;
    try { out.push(JSON.parse(await client.filesDownload(f.id)) as Precedent); } catch { /* skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ratify (→ local binding store) + consult
// ---------------------------------------------------------------------------

function storePath(): string {
  const d = dataPath('gdrive');
  mkdirSync(d, { recursive: true });
  return join(d, 'case-law.json');
}

export function listRatifiedPrecedents(): Precedent[] {
  const p = storePath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { precedents?: Precedent[] };
    return Array.isArray(parsed.precedents) ? parsed.precedents : [];
  } catch {
    return [];
  }
}

/** Ratify a proposed precedent into the binding local store. Idempotent by id. */
export async function ratifyPrecedent(
  client: DriveClient,
  folders: FolderIdMap,
  id: string,
  now: () => Date = () => new Date(),
): Promise<Precedent> {
  const proposals = await listProposals(client, folders);
  const prop = proposals.find((p) => p.id === id);
  if (!prop) throw new Error(`case-law: no proposal "${id}" to ratify`);
  const ratified: Precedent = { ...prop, status: 'ratified', ratifiedAt: now().toISOString() };
  const store = listRatifiedPrecedents().filter((p) => p.id !== id);
  store.push(ratified);
  writeFileSync(storePath(), JSON.stringify({ precedents: store }, null, 2), { mode: 0o600 });
  log.info({ id }, 'F70 precedent RATIFIED — now binding case law');
  return ratified;
}

export interface PrecedentMatch {
  id: string;
  situation: string;
  ruling: string;
}

/**
 * Match RATIFIED precedents against plan text by content-word overlap. Pure +
 * local — safe to call from the planner every turn. Only ratified precedents
 * are ever returned (a proposal is not binding).
 */
export function consultPrecedents(planText: string, minHits = 2): PrecedentMatch[] {
  const planWords = new Set(contentWords(planText));
  if (planWords.size === 0) return [];
  const out: Array<PrecedentMatch & { hits: number }> = [];
  for (const p of listRatifiedPrecedents()) {
    const sit = new Set(contentWords(p.situation));
    let hits = 0;
    for (const w of sit) if (planWords.has(w)) hits++;
    if (hits >= minHits) out.push({ id: p.id, situation: p.situation, ruling: p.ruling, hits });
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, 5).map(({ id, situation, ruling }) => ({ id, situation, ruling }));
}
