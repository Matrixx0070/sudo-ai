/**
 * @file notebooklm/estate-pack.ts
 * @description F56 — succession notebook / estate pack. The durable complement
 * to F64's live succession gate: a standing, POINTER-ONLY index of where the
 * estate lives, so whoever inherits (a successor model, or the principal picking
 * up the estate) can find everything. It carries LABELS + POINTERS (Drive
 * fileIds/URLs + local paths) — never embedded content — so it is cheap,
 * zone-2 by construction, and never leaks memory. buildEstatePack only LISTS;
 * it never downloads a file's body (enforced by test).
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from '../gdrive/client.js';
import type { FolderIdMap } from '../gdrive/types.js';
import type { NlmFolderMap } from './folders.js';
import { HEADER_SENTENCE } from './export-lane.js';

const log = createLogger('notebooklm:estate-pack');

export interface EstatePointer {
  name: string;
  ref: string; // Drive URL or local path — a pointer, not content
}
export interface EstateSection {
  label: string;
  note?: string;
  pointers: EstatePointer[];
}
export interface EstatePack {
  generatedAt: string;
  sections: EstateSection[];
}

const driveUrl = (id: string) => `https://drive.google.com/open?id=${id}`;

/** List a folder's children as pointers (names + URLs), newest-name first, capped. */
async function folderPointers(client: DriveClient, folderId: string | undefined, cap = 8): Promise<EstatePointer[]> {
  if (!folderId) return [];
  const children = await client.listChildren(folderId);
  return children
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, cap)
    .map((f) => ({ name: f.name, ref: driveUrl(f.id) }));
}

/**
 * Assemble the estate pack. `gdriveFolders`/`nlmFolders` provide the tree;
 * local artifacts (sealed operator model, case law, succession state) are named
 * by PATH only — the successor needs the enc key for the sealed ones. Only
 * listChildren is used against Drive; no file body is ever read.
 */
export async function buildEstatePack(
  client: DriveClient,
  gdriveFolders: FolderIdMap,
  nlmFolders: NlmFolderMap,
  now: () => Date = () => new Date(),
): Promise<EstatePack> {
  const sections: EstateSection[] = [
    {
      label: 'Identity & manifest (frozen — read-only)',
      note: 'The signed manifest defines identity/values. Never rewrite it.',
      pointers: await folderPointers(client, gdriveFolders['manifest']),
    },
    {
      label: 'Self-reports & atlas',
      pointers: await folderPointers(client, gdriveFolders['ops/reports'], 10),
    },
    {
      label: 'Forks museum (past selves)',
      pointers: await folderPointers(client, nlmFolders['notebooklm/releases/forks-museum']),
    },
    {
      label: 'Sealed local artifacts (need the zone-1 enc key)',
      note: 'Encrypted at rest; decrypt in-harness only.',
      pointers: [
        { name: 'operator model (F62)', ref: 'data/gdrive/self/operator-model.sealed' },
        { name: 'successor pack (F64)', ref: 'data/notebooklm/succession/successor-pack.sealed' },
      ],
    },
    {
      label: 'Binding fleet case law (F70)',
      pointers: [{ name: 'ratified precedents', ref: 'data/gdrive/case-law.json' }],
    },
    {
      label: 'Succession state (F64)',
      pointers: [{ name: 'succession gate state', ref: 'data/notebooklm/succession.json' }],
    },
  ];
  return { generatedAt: now().toISOString(), sections };
}

export function renderEstatePack(pack: EstatePack): string {
  const lines = [
    '# Succession notebook — estate pack (F56)',
    '',
    `> ${HEADER_SENTENCE}`,
    '',
    'Pointer-only index of the estate. Follow the pointers; nothing here is a copy.',
    '',
  ];
  for (const s of pack.sections) {
    lines.push(`## ${s.label}`);
    if (s.note) lines.push(`_${s.note}_`);
    if (s.pointers.length === 0) lines.push('- (none yet)');
    else for (const p of s.pointers) lines.push(`- ${p.name} → \`${p.ref}\``);
    lines.push('');
  }
  return lines.join('\n');
}

/** Publish the estate pack to notebooklm/succession. */
export async function publishEstatePack(
  client: DriveClient,
  gdriveFolders: FolderIdMap,
  nlmFolders: NlmFolderMap,
  now: () => Date = () => new Date(),
): Promise<string | null> {
  const folderId = nlmFolders['notebooklm/succession'];
  if (!folderId) return null;
  const body = renderEstatePack(await buildEstatePack(client, gdriveFolders, nlmFolders, now));
  const name = 'F56.estate-pack';
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  const id = existing
    ? (await client.filesUpdateGoogleDoc(existing.id, body), existing.id)
    : (await client.filesCreateAsGoogleDoc(name, folderId, body)).id;
  log.info('F56 estate pack published (pointer-only)');
  return id;
}
