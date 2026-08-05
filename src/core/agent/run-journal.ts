/**
 * @file agent/run-journal.ts
 * @description Durable per-run journal so a halted run is a PAUSE, not a
 * restart.
 *
 * 2026-08-05 autonomy audit, blocker #1 (the agent's own top-ranked): a run
 * that hit its spend cap after 38 iterations left ZERO durable artifacts —
 * everything it learned existed only in the conversation, and the next turn
 * started cold. Claude-Code-style long missions survive interruption because
 * progress is written down as it happens.
 *
 * Design constraints:
 *   - Append-only JSONL per session under data/run-journal/. Crash-safe: a
 *     partial last line is skipped on read, never throws.
 *   - Best-effort at every call site. The journal must never fail a turn —
 *     every export swallows its own IO errors (logged, not thrown).
 *   - Bounded: entries are capped per run and each file is truncated when it
 *     grows past MAX_FILE_BYTES, so an hour-long run can't fill the disk.
 *   - Pure formatting is separated from IO (buildResumeDigest) for testing.
 *
 * Kill-switch: SUDO_RUN_JOURNAL=0 disables reads and writes entirely.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:run-journal');

const JOURNAL_DIR = path.join(DATA_DIR, 'run-journal');
/** Truncate a session's journal past this size (keeps the newest half). */
const MAX_FILE_BYTES = 512 * 1024;
/** Hard cap on steps carried into a resume digest. */
const MAX_DIGEST_STEPS = 20;

/** One journal record. `at` is an ISO timestamp. */
export type JournalEntry =
  | { kind: 'start'; at: string; runId: string; goal: string }
  | { kind: 'step'; at: string; runId: string; iteration: number; tools: string[]; note?: string }
  | { kind: 'halt'; at: string; runId: string; reason: string; iterations: number }
  | { kind: 'end'; at: string; runId: string; iterations: number }
  | { kind: 'resumed'; at: string; runId: string; ofRunId: string };

/** True when the journal is enabled (default ON). */
export function journalEnabled(): boolean {
  return process.env['SUDO_RUN_JOURNAL'] !== '0';
}

function journalPath(sessionId: string): string {
  // Session ids are internally generated (nanoid) — still sanitize so a hostile
  // id can never escape the journal dir.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
  return path.join(JOURNAL_DIR, `${safe}.jsonl`);
}

/** Append one entry. Best-effort: never throws, never blocks a turn. */
export function appendEntry(sessionId: string, entry: JournalEntry): void {
  if (!journalEnabled()) return;
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true });
    const file = journalPath(sessionId);
    try {
      if (statSync(file).size > MAX_FILE_BYTES) {
        // Keep the newest half — an interrupted run's tail is what a resume needs.
        const lines = readFileSync(file, 'utf8').split('\n');
        writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'), 'utf8');
      }
    } catch { /* no file yet */ }
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log.warn({ sessionId, err: String(err) }, 'run-journal append failed (non-fatal)');
  }
}

/** Read a session's entries oldest-first. Skips malformed/partial lines. */
export function readEntries(sessionId: string): JournalEntry[] {
  if (!journalEnabled()) return [];
  const file = journalPath(sessionId);
  try {
    if (!existsSync(file)) return [];
    const out: JournalEntry[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as JournalEntry); } catch { /* partial tail line */ }
    }
    return out;
  } catch (err) {
    log.warn({ sessionId, err: String(err) }, 'run-journal read failed (non-fatal)');
    return [];
  }
}

/**
 * The most recent run that HALTED and has not yet been resumed, or null.
 * A run is resumable when its last lifecycle record is a `halt` — an `end`
 * (finished) or a later `resumed` for the same runId clears it.
 */
export function findResumableRun(entries: readonly JournalEntry[]): {
  runId: string;
  goal: string;
  reason: string;
  iterations: number;
  steps: JournalEntry[];
} | null {
  const halts = entries.filter((e): e is Extract<JournalEntry, { kind: 'halt' }> => e.kind === 'halt');
  const lastHalt = halts[halts.length - 1];
  if (!lastHalt) return null;

  const settled = entries.some(
    (e) =>
      (e.kind === 'end' && e.runId === lastHalt.runId) ||
      (e.kind === 'resumed' && e.ofRunId === lastHalt.runId),
  );
  if (settled) return null;

  const start = entries.find((e) => e.kind === 'start' && e.runId === lastHalt.runId);
  const steps = entries.filter((e) => e.kind === 'step' && e.runId === lastHalt.runId);
  return {
    runId: lastHalt.runId,
    goal: start && start.kind === 'start' ? start.goal : '',
    reason: lastHalt.reason,
    iterations: lastHalt.iterations,
    steps,
  };
}

/**
 * Render the resume digest injected as a system message on the next turn.
 * Pure — no IO. Empty string when there is nothing to resume.
 */
export function buildResumeDigest(resumable: ReturnType<typeof findResumableRun>): string {
  if (!resumable) return '';
  const lines: string[] = [
    '[Resuming an interrupted run — this is work YOU already did, continue from it]',
  ];
  if (resumable.goal) lines.push(`Original goal: ${resumable.goal}`);
  lines.push(`Previous run stopped after ${resumable.iterations} iterations: ${resumable.reason}`);

  const steps = resumable.steps.slice(-MAX_DIGEST_STEPS);
  if (steps.length > 0) {
    lines.push('Steps already completed:');
    for (const s of steps) {
      if (s.kind !== 'step') continue;
      const tools = s.tools.length > 0 ? s.tools.join(', ') : '(no tools)';
      lines.push(`- iteration ${s.iteration}: ${tools}${s.note ? ` — ${s.note}` : ''}`);
    }
    if (resumable.steps.length > steps.length) {
      lines.push(`  (…${resumable.steps.length - steps.length} earlier steps elided)`);
    }
  }
  lines.push(
    'Do NOT restart from scratch and do NOT repeat completed steps — continue from the next unfinished step, and finish the goal.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// AgentLoop seam — one call per lifecycle point, so the loop never assembles
// entry shapes or timestamps itself.
// ---------------------------------------------------------------------------

/**
 * Record the start of a run AND return the resume digest for a previous run
 * that halted (empty string when there is nothing to resume). One call so the
 * loop's hot path stays two lines. Never throws.
 */
export function beginRun(sessionId: string, runId: string, goal: string): string {
  try {
    appendEntry(sessionId, { kind: 'start', at: new Date().toISOString(), runId, goal: goal.slice(0, 500) });
    return consumeResumeDigest(sessionId);
  } catch (err) {
    log.warn({ sessionId, err: String(err) }, 'run-journal beginRun failed (non-fatal)');
    return '';
  }
}

/** Record one completed iteration (tools used + the model's own note). */
export function journalStep(
  sessionId: string, runId: string, iteration: number, tools: string[], note?: string,
): void {
  const trimmed = note?.trim();
  appendEntry(sessionId, {
    kind: 'step', at: new Date().toISOString(), runId, iteration, tools,
    ...(trimmed ? { note: trimmed.slice(0, 200) } : {}),
  });
}

/** Record a hard halt (budget/iteration cap) — drives the next run's resume. */
export function journalHalt(sessionId: string, runId: string, reason: string, iterations: number): void {
  appendEntry(sessionId, { kind: 'halt', at: new Date().toISOString(), runId, reason, iterations });
}

/** Record a normally-finished run so it is never offered for resume. */
export function journalEnd(sessionId: string, runId: string, iterations: number): void {
  appendEntry(sessionId, { kind: 'end', at: new Date().toISOString(), runId, iterations });
}

/**
 * Read a session's journal and return the resume digest to inject, marking the
 * run resumed so it is not injected twice. Best-effort; '' when nothing to do.
 */
export function consumeResumeDigest(sessionId: string): string {
  if (!journalEnabled()) return '';
  const resumable = findResumableRun(readEntries(sessionId));
  if (!resumable) return '';
  appendEntry(sessionId, {
    kind: 'resumed',
    at: new Date().toISOString(),
    runId: `resume-${Date.now()}`,
    ofRunId: resumable.runId,
  });
  return buildResumeDigest(resumable);
}
