/**
 * @file run-journal.ts
 * @description Append-only JSONL journal per eval run (ADR-0007). One file at
 * data/eval-runs/<runId>/journal.jsonl; every line is a self-contained event.
 * Sync appendFileSync is deliberate — same posture as the bench substrate, and
 * an eval run is single-writer by construction.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export type JournalEventType =
  | 'run.start'
  | 'prompt'
  | 'tool.call'
  | 'tool.result'
  | 'policy.decision'
  | 'fault.injected'
  | 'replay.path-remap'
  | 'budget.exhausted'
  | 'resource.sample'
  | 'role.turn'
  | 'run.end'
  | 'scores';

export interface JournalEvent {
  type: JournalEventType;
  ts: string;
  [key: string]: unknown;
}

/** Payload cap for journalled tool params / outputs. */
export const JOURNAL_TRUNCATE_BYTES = 4096;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function truncateForJournal(text: string): string {
  return text.length > JOURNAL_TRUNCATE_BYTES ? text.slice(0, JOURNAL_TRUNCATE_BYTES) : text;
}

export class RunJournal {
  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(event: { type: JournalEventType; [key: string]: unknown }): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    appendFileSync(this.filePath, line + '\n');
  }
}

/**
 * Parse a journal back into events (Phase 3 replay reads this). Malformed
 * lines are skipped rather than fatal: a journal cut off mid-write (crash,
 * wall-clock kill) must still replay its intact prefix.
 */
export function readJournal(filePath: string): JournalEvent[] {
  if (!existsSync(filePath)) return [];
  const out: JournalEvent[] = [];
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as JournalEvent);
    } catch {
      /* torn tail line — skip */
    }
  }
  return out;
}
