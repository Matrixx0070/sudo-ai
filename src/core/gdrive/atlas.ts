/**
 * @file gdrive/atlas.ts
 * @description F30 — the brain atlas: a browsable map of current knowledge.
 *
 * Nightly walk of consolidated memory -> structured Google Doc, updated IN
 * PLACE so the fileId/link stays stable (comments become unanchored on
 * regeneration but remain retrievable — F6 still scans them; tradeoff noted
 * in the Doc header). Zone-1 content appears as titles-only placeholders.
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { ChunkLike, StructuredMemoryLike } from './brain-serializer.js';
import { classifyZone } from './zones.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';

const log = createLogger('gdrive:atlas');

export const ATLAS_NAME = 'brain-atlas';
const STALE_DAYS = 60;

export interface AtlasInputs {
  chunks: ChunkLike[];
  structured: StructuredMemoryLike[];
  now?: Date;
}

function domainOf(path: string): string {
  const seg = path.split('/').filter(Boolean);
  return seg.length > 1 ? seg.slice(0, 2).join('/') : (seg[0] ?? 'misc');
}

function ageDays(iso: string, now: Date): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86_400_000) : 9_999;
}

/** Pure renderer. */
export function buildAtlas(inputs: AtlasInputs): string {
  const now = inputs.now ?? new Date();
  const lines: string[] = [
    `# Brain Atlas — ${now.toISOString().slice(0, 10)}`,
    '',
    '*Regenerated nightly in place (stable link; comments un-anchor on refresh',
    'but are still read — comment anywhere to correct me, F6).*',
    '',
  ];

  const byDomain = new Map<string, ChunkLike[]>();
  for (const c of inputs.chunks) {
    const d = domainOf(c.path);
    const arr = byDomain.get(d) ?? [];
    arr.push(c);
    byDomain.set(d, arr);
  }

  lines.push(`## Knowledge domains (${byDomain.size})`, '');
  for (const [domain, chunks] of [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${domain} — ${chunks.length} memories`);
    const newest = [...chunks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
    for (const c of newest) {
      const age = ageDays(c.createdAt, now);
      const stale = age > STALE_DAYS ? ' ⚠️stale' : '';
      const zone = classifyZone(c.text);
      const body = zone === 1 ? '[zone-1 — title withheld]' : c.text.replace(/\s+/g, ' ').slice(0, 140);
      lines.push(`- ${body}${c.isEvergreen ? ' 🌲' : ''} *(${age}d${stale})*`);
    }
    if (chunks.length > 8) lines.push(`- …and ${chunks.length - 8} more`);
    lines.push('');
  }

  const feedback = inputs.structured.filter((m) => m.type === 'feedback');
  const projects = inputs.structured.filter((m) => m.type === 'project');
  lines.push(`## Active corrections & directives (${feedback.length})`, '');
  for (const f of feedback.slice(-15)) lines.push(`- **${f.name}** — ${f.description.slice(0, 120)}`);
  lines.push('', `## Projects (${projects.length})`, '');
  for (const p of projects.slice(-15)) lines.push(`- **${p.name}** — ${p.description.slice(0, 120)}`);
  return lines.join('\n');
}

function atlasIdCachePath(): string {
  return dataPath('gdrive', 'atlas-id.json');
}

export function loadAtlasId(): string | null {
  try {
    return (JSON.parse(readFileSync(atlasIdCachePath(), 'utf-8')) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

/** Render + publish (create once, then update in place). Returns fileId. */
export async function publishAtlas(
  client: DriveClient,
  folders: FolderIdMap,
  inputs: AtlasInputs,
): Promise<string> {
  const markdown = buildAtlas(inputs);
  const cached = loadAtlasId();
  if (cached) {
    try {
      await client.filesUpdateGoogleDoc(cached, markdown);
      return cached;
    } catch {
      // stale id — recreate below
    }
  }
  const reportsFolder = folders['ops/reports'];
  if (!reportsFolder) throw new Error('gdrive atlas: ops/reports folder id missing');
  const existing = (await client.listChildren(reportsFolder)).find((f) => f.name === ATLAS_NAME);
  let id: string;
  if (existing) {
    await client.filesUpdateGoogleDoc(existing.id, markdown);
    id = existing.id;
  } else {
    id = (await client.filesCreateAsGoogleDoc(ATLAS_NAME, reportsFolder, markdown)).id;
  }
  const p = atlasIdCachePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ id }), { mode: 0o600 });
  log.info({ id }, 'atlas published');
  return id;
}

/** Test/ops probe. */
export function hasAtlasIdCache(): boolean {
  return existsSync(atlasIdCachePath());
}
