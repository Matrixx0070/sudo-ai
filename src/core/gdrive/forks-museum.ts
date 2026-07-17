/**
 * @file gdrive/forks-museum.ts
 * @description F60 — forks museum. A catalog of the agent's PAST SELVES: the
 * F25 brain forks (manifest snapshots under brains/forks/). The museum lists
 * metadata only — name, brainId, counter (the era), policy note, entry count,
 * created-at — never raw manifest entries, so it is zone-2 by construction and
 * safe to broadcast as a self-knowledge shape. It is also the corpus a notebook
 * chats against for "conversations with past selves" (the F60 dialogue return).
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

const log = createLogger('gdrive:forks-museum');

export interface ForkCatalogEntry {
  name: string;
  brainId: string;
  counter: number;
  createdAt: string;
  policyNote: string;
  entryCount: number;
}

/** Read brains/forks/*.json → a catalog of past selves (metadata only). */
export async function buildForksMuseum(client: DriveClient, folders: FolderIdMap): Promise<ForkCatalogEntry[]> {
  const forksFolder = folders['brains/forks'];
  if (!forksFolder) return [];
  const files = (await client.listChildren(forksFolder)).filter((f) => f.name.endsWith('.json'));
  const out: ForkCatalogEntry[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(await client.filesDownload(f.id)) as {
        brainId?: string; counter?: number; createdAt?: string; policyNote?: string; entries?: unknown[];
      };
      out.push({
        name: f.name.replace(/\.json$/, ''),
        brainId: typeof raw.brainId === 'string' ? raw.brainId : '(unknown)',
        counter: typeof raw.counter === 'number' ? raw.counter : 0,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
        policyNote: typeof raw.policyNote === 'string' ? raw.policyNote : '',
        entryCount: Array.isArray(raw.entries) ? raw.entries.length : 0,
      });
    } catch {
      log.warn({ file: f.name }, 'forks-museum: unreadable fork manifest — skipping');
    }
  }
  // Newest era first.
  out.sort((a, b) => b.counter - a.counter || b.createdAt.localeCompare(a.createdAt));
  return out;
}

export function renderForksMuseum(entries: ForkCatalogEntry[]): string {
  const lines = [
    '# Forks museum (F60) — past selves',
    '',
    `${entries.length} past self/selves preserved (metadata only — no raw memory).`,
    '',
  ];
  if (entries.length === 0) {
    lines.push('_No forks yet. A fork is a manifest snapshot of a counterfactual self._');
    return lines.join('\n');
  }
  for (const e of entries) {
    lines.push(
      `## ${e.name} — counter ${e.counter}`,
      `- brainId: \`${e.brainId}\`${e.createdAt ? ` · created ${e.createdAt}` : ''} · ${e.entryCount} memory ref(s)`,
      e.policyNote ? `- policy: ${e.policyNote}` : '- policy: (none noted)',
      '',
    );
  }
  return lines.join('\n');
}
