/**
 * @file gdrive/prospective.ts
 * @description F24 — prospective memory: the agent remembers to do things later.
 *
 * noteToFutureSelf(openAt, content, context) appends to a local store
 * (data/gdrive/prospective.json, zone-2, included in checkpoints via the
 * serializer's extra-file hook). The nightly job delivers due notes into the
 * planning path (a high-priority 'feedback' structured memory — the same
 * surface F6 corrections use) and the self-report's "Today's due notes".
 * Delivered notes convert to normal records with outcome annotation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { StructuredStoreLike } from './brain-serializer.js';

const log = createLogger('gdrive:prospective');

export interface ProspectiveNote {
  id: string;
  openAt: string; // ISO date(time) at which the note becomes due
  content: string;
  context?: string;
  createdAt: string;
  deliveredAt?: string;
}

interface ProspectiveStore {
  notes: ProspectiveNote[];
}

export function prospectivePath(): string {
  return dataPath('gdrive', 'prospective.json');
}

function load(): ProspectiveStore {
  try {
    const parsed = JSON.parse(readFileSync(prospectivePath(), 'utf-8')) as ProspectiveStore;
    return { notes: parsed.notes ?? [] };
  } catch {
    return { notes: [] };
  }
}

function save(store: ProspectiveStore): void {
  const p = prospectivePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

/** The memory-API surface: schedule a note for a future date. */
export function noteToFutureSelf(openAt: string, content: string, context?: string): ProspectiveNote {
  if (!Number.isFinite(Date.parse(openAt))) throw new Error(`prospective: invalid openAt "${openAt}"`);
  const store = load();
  const note: ProspectiveNote = {
    id: randomUUID(),
    openAt: new Date(openAt).toISOString(),
    content: content.slice(0, 4000),
    context: context?.slice(0, 1000),
    createdAt: new Date().toISOString(),
  };
  store.notes.push(note);
  save(store);
  log.info({ openAt: note.openAt }, 'prospective note scheduled');
  return note;
}

export function listDueNotes(now: string = new Date().toISOString()): ProspectiveNote[] {
  return load().notes.filter((n) => !n.deliveredAt && n.openAt <= now);
}

export function listPendingNotes(): ProspectiveNote[] {
  return load().notes.filter((n) => !n.deliveredAt);
}

/**
 * Deliver due notes: save each as a high-priority planning memory and mark
 * delivered (with outcome annotation). Returns the delivered notes so the
 * daily report can list them.
 */
export async function deliverDueNotes(
  structured: StructuredStoreLike,
  now: string = new Date().toISOString(),
): Promise<ProspectiveNote[]> {
  const store = load();
  const due = store.notes.filter((n) => !n.deliveredAt && n.openAt <= now);
  for (const note of due) {
    await structured.saveMemory({
      type: 'feedback',
      id: `prospective-${note.id}`,
      name: `Due note-to-self (${note.openAt.slice(0, 10)})`,
      description: 'PROSPECTIVE MEMORY due today — consult at planning time',
      content: [
        `[NOTE TO FUTURE SELF — scheduled ${note.createdAt.slice(0, 10)}, due ${note.openAt.slice(0, 10)}]`,
        note.content,
        note.context ? `Context: ${note.context}` : '',
        `Outcome: delivered ${now}`,
      ].filter(Boolean).join('\n'),
    });
    note.deliveredAt = now;
  }
  if (due.length) {
    save(store);
    log.info({ delivered: due.length }, 'prospective notes delivered');
  }
  return due;
}

/** Test/ops probe. */
export function hasProspectiveStore(): boolean {
  return existsSync(prospectivePath());
}
