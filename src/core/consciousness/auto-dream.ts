/**
 * AutoDream — 4-phase memory consolidation system.
 *
 * Runs during idle periods to consolidate session signals and daily logs into
 * structured memory. Inspired by sleep-consolidation research: the system
 * reviews what happened, distils patterns, and prunes stale data so that
 * SUDO-AI grows smarter across sessions rather than accumulating noise.
 *
 * Phases:
 *   1. Orient      — read workspace/memory/ daily logs from the last 7 days
 *   2. Gather      — query mind.db for tasks, errors, tool calls from last 24h
 *   3. Consolidate — call brain to extract decisions, patterns, lessons
 *   4. Prune       — trim MEMORY.md if > 25 KB; delete logs older than 30 days
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoDreamStatus {
  lastRun: string | null;
  sessionsCount: number;
  memorySize: number;
}

interface AutoDreamState {
  lastRun: string;
  sessionCountAtRun: number;
}

interface BrainLike {
  call(opts: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
    source?: string;
  }): Promise<{ content: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = 'data';
const WORKSPACE_DIR = 'workspace';
const MEMORY_DIR = path.join(WORKSPACE_DIR, 'memory');
const MEMORY_MD = path.join(WORKSPACE_DIR, 'MEMORY.md');
const STATE_FILE = path.join(DATA_DIR, 'autodream.json');
const LOCK_FILE = path.join(DATA_DIR, 'autodream-lock.json');
const LOG_FILE = path.join(DATA_DIR, 'autodream.log');

const HOURS_BETWEEN_CYCLES = 24;
const MIN_SESSIONS_SINCE_LAST = 5;
const MAX_MEMORY_BYTES = 25 * 1024; // 25 KB
const LOG_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    // Append synchronously — we want guaranteed ordering across all phases.
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
    writeFileSync(LOG_FILE, existing + line, 'utf8');
  } catch {
    // Log failures are non-fatal.
  }
}

function readState(): AutoDreamState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as AutoDreamState;
  } catch {
    return null;
  }
}

function writeState(state: AutoDreamState): void {
  ensureDataDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function acquireLock(): boolean {
  ensureDataDir();
  const payload = JSON.stringify(
    { pid: process.pid, startedAt: new Date().toISOString() },
    null,
    2,
  );

  const tryCreate = (): boolean => {
    try {
      // Exclusive create: fails atomically with EEXIST if a lock already exists.
      writeFileSync(LOCK_FILE, payload, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  // Fast path: no lock present — atomically create it.
  if (tryCreate()) return true;

  // A lock file exists. Decide whether it is stale (or corrupt) and stealable.
  let stale = true;
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as { pid: number; startedAt: string };
    // Treat locks older than 2 hours as stale.
    const ageMs = Date.now() - new Date(lock.startedAt).getTime();
    if (ageMs < 2 * 60 * 60 * 1000) stale = false;
  } catch {
    // Corrupt lock file — steal the lock.
  }

  if (!stale) return false;

  // Steal the stale/corrupt lock, then re-acquire atomically. If another
  // process recreated the lock in the meantime, the exclusive create fails
  // and we back off rather than clobbering an active lock.
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Another process may have already removed/replaced it — fall through.
  }
  return tryCreate();
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    // Non-fatal.
  }
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function ensureMemoryDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

/**
 * Parse a daily log filename like YYYY-MM-DD.md into a Date.
 * Returns null if the filename does not match the pattern.
 */
function parseLogDate(filename: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(filename);
  if (!match) return null;
  const d = new Date(match[1] as string);
  return isNaN(d.getTime()) ? null : d;
}

/** Rough token estimate: 1 token ≈ 4 chars. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to at most maxTokens (approx). */
function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[truncated]';
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class AutoDream {
  private readonly brain: BrainLike;
  private readonly dbPath: string;

  constructor(brain: BrainLike, dbPath: string) {
    this.brain = brain;
    this.dbPath = dbPath;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check all trigger conditions:
   *   - 24+ hours since last dream cycle
   *   - 5+ sessions completed since last cycle
   *   - No active lock (no concurrent run)
   */
  async shouldRun(): Promise<boolean> {
    // Check lock (concurrent run guard).
    if (existsSync(LOCK_FILE)) {
      try {
        const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as { startedAt: string };
        const ageMs = Date.now() - new Date(lock.startedAt).getTime();
        if (ageMs < 2 * 60 * 60 * 1000) {
          appendLog('shouldRun: active lock found — skipping');
          return false;
        }
      } catch {
        // Corrupt lock — treat as no lock.
      }
    }

    const state = readState();

    // Hours since last run check.
    if (state) {
      const lastRunMs = new Date(state.lastRun).getTime();
      if (!Number.isFinite(lastRunMs)) {
        // Invalid/missing lastRun (e.g. corrupt state). Treat as no prior run
        // rather than letting NaN silently bypass the cooldown guard.
        appendLog('shouldRun: state has invalid lastRun — treating as no prior run');
      } else {
        const hoursSince = (Date.now() - lastRunMs) / (1000 * 60 * 60);
        if (hoursSince < HOURS_BETWEEN_CYCLES) {
          appendLog(
            `shouldRun: only ${hoursSince.toFixed(1)}h since last run (need ${HOURS_BETWEEN_CYCLES}h)`,
          );
          return false;
        }
      }
    }

    // Sessions since last cycle.
    const currentSessions = this.countTotalSessions();
    const sessionsAtLastRun = state?.sessionCountAtRun ?? 0;
    const newSessions = currentSessions - sessionsAtLastRun;

    if (newSessions < MIN_SESSIONS_SINCE_LAST) {
      appendLog(
        `shouldRun: only ${newSessions} new sessions since last run (need ${MIN_SESSIONS_SINCE_LAST})`,
      );
      return false;
    }

    return true;
  }

  /**
   * Execute all 4 dream phases.
   * Acquires a lock before starting and releases it when done (or on error).
   */
  async run(): Promise<{ ran: boolean; summary: string }> {
    if (!acquireLock()) {
      return { ran: false, summary: 'Another dream cycle is already running.' };
    }

    appendLog('AutoDream: cycle started');

    try {
      // Phase 1 — Orient
      appendLog('Phase 1: Orient');
      const orientData = await this.phaseOrient();

      // Phase 2 — Gather Signal
      appendLog('Phase 2: Gather Signal');
      const signalReport = this.phaseGatherSignal();

      // Phase 3 — Consolidate
      appendLog('Phase 3: Consolidate');
      const consolidationSummary = await this.phaseConsolidate(orientData, signalReport);

      // Phase 4 — Prune
      appendLog('Phase 4: Prune');
      await this.phasePrune();

      // Persist state.
      const sessionCountNow = this.countTotalSessions();
      writeState({
        lastRun: new Date().toISOString(),
        sessionCountAtRun: sessionCountNow,
      });

      appendLog('AutoDream: cycle completed successfully');
      return { ran: true, summary: consolidationSummary };
    } catch (err) {
      appendLog(`AutoDream: cycle failed — ${String(err)}`);
      throw err;
    } finally {
      releaseLock();
    }
  }

  /** Return status information without running the cycle. */
  async getStatus(): Promise<AutoDreamStatus> {
    const state = readState();
    const sessionsCount = this.countTotalSessions();

    let memorySize = 0;
    if (existsSync(MEMORY_MD)) {
      try {
        memorySize = statSync(MEMORY_MD).size;
      } catch {
        memorySize = 0;
      }
    }

    return {
      lastRun: state?.lastRun ?? null,
      sessionsCount,
      memorySize,
    };
  }

  // -------------------------------------------------------------------------
  // Phase implementations
  // -------------------------------------------------------------------------

  /**
   * Phase 1 — Orient.
   * Read workspace/memory/ daily logs from the last 7 days.
   * Returns a summary string of what happened.
   */
  private async phaseOrient(): Promise<string> {
    ensureMemoryDir();

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // List all daily log files.
    let files: string[] = [];
    try {
      files = readdirSync(MEMORY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    } catch {
      return 'No daily logs found in workspace/memory/.';
    }

    // Filter to last 7 days and sort descending (newest first).
    const recentFiles = files
      .filter((f) => {
        const d = parseLogDate(f);
        return d !== null && d >= sevenDaysAgo;
      })
      .sort()
      .reverse();

    if (recentFiles.length === 0) {
      return 'No daily logs from the last 7 days found.';
    }

    // Read today, yesterday, and 5 days ago (if they exist).
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const priorityDates = new Set([today, yesterday, fiveDaysAgo]);
    const priorityFiles = recentFiles.filter((f) => priorityDates.has(f.replace('.md', '')));
    const otherFiles = recentFiles.filter((f) => !priorityDates.has(f.replace('.md', '')));

    const readLog = async (filename: string): Promise<string> => {
      const filePath = path.join(MEMORY_DIR, filename);
      try {
        return await readFile(filePath, 'utf8');
      } catch {
        return `[could not read ${filename}]`;
      }
    };

    const sections: string[] = [];

    // Priority files: read fully.
    for (const f of priorityFiles) {
      const content = await readLog(f);
      sections.push(`### ${f}\n${content}`);
    }

    // Remaining recent files: summarise with first 500 chars.
    for (const f of otherFiles) {
      const content = await readLog(f);
      sections.push(`### ${f} (excerpt)\n${content.slice(0, 500)}`);
    }

    return sections.join('\n\n---\n\n');
  }

  /**
   * Phase 2 — Gather Signal.
   * Query mind.db for recent activity and build a plain-text signal report.
   */
  private phaseGatherSignal(): string {
    let db: ReturnType<typeof Database> | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true });

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Tasks completed in last 24h.
      const completedTasks = db
        .prepare(
          `SELECT title, status, finished_at
           FROM tasks
           WHERE status = 'done'
             AND finished_at >= ?
           ORDER BY finished_at DESC
           LIMIT 50`,
        )
        .all(since24h) as Array<{ title: string; status: string; finished_at: string }>;

      // Errors logged in last 24h.
      const errors = db
        .prepare(
          `SELECT content, created_at
           FROM messages
           WHERE role = 'tool'
             AND tool_name IS NOT NULL
             AND created_at >= ?
             AND (content LIKE '%error%' OR content LIKE '%Error%' OR content LIKE '%failed%')
           ORDER BY created_at DESC
           LIMIT 20`,
        )
        .all(since24h) as Array<{ content: string; created_at: string }>;

      // Tool calls in last 24h with counts.
      const toolCalls = db
        .prepare(
          `SELECT tool_name, COUNT(*) as call_count
           FROM messages
           WHERE tool_name IS NOT NULL
             AND created_at >= ?
           GROUP BY tool_name
           ORDER BY call_count DESC
           LIMIT 15`,
        )
        .all(since24h) as Array<{ tool_name: string; call_count: number }>;

      // Most used tools (all time top 5, for pattern detection).
      const topTools = db
        .prepare(
          `SELECT tool_name, COUNT(*) as total
           FROM messages
           WHERE tool_name IS NOT NULL
           GROUP BY tool_name
           ORDER BY total DESC
           LIMIT 5`,
        )
        .all() as Array<{ tool_name: string; total: number }>;

      const lines: string[] = ['## Signal Report (last 24h)'];

      lines.push(
        `\n### Tasks Completed (${completedTasks.length})`,
      );
      for (const t of completedTasks) {
        lines.push(`- ${t.title} [${t.finished_at}]`);
      }
      if (completedTasks.length === 0) lines.push('- None');

      lines.push(`\n### Errors Observed (${errors.length})`);
      for (const e of errors.slice(0, 5)) {
        const snippet = e.content.slice(0, 150).replace(/\n/g, ' ');
        lines.push(`- [${e.created_at}] ${snippet}`);
      }
      if (errors.length === 0) lines.push('- None');

      lines.push(`\n### Tool Usage (last 24h)`);
      for (const t of toolCalls) {
        lines.push(`- ${t.tool_name}: ${t.call_count} calls`);
      }
      if (toolCalls.length === 0) lines.push('- No tool calls recorded');

      lines.push(`\n### All-Time Top Tools`);
      for (const t of topTools) {
        lines.push(`- ${t.tool_name}: ${t.total} total`);
      }

      return lines.join('\n');
    } catch (err) {
      return `## Signal Report\n\nFailed to query mind.db: ${String(err)}`;
    } finally {
      try {
        db?.close();
      } catch {
        // Non-fatal.
      }
    }
  }

  /**
   * Phase 3 — Consolidate.
   * Call brain to extract key decisions, patterns, lessons from all gathered data.
   * Appends dated section to workspace/MEMORY.md.
   */
  private async phaseConsolidate(orientData: string, signalReport: string): Promise<string> {
    const MAX_INPUT_CHARS = 60_000;

    let combined = [
      '## Daily Logs (last 7 days)',
      orientData,
      '',
      signalReport,
    ].join('\n');

    // Keep combined input within bounds.
    if (combined.length > MAX_INPUT_CHARS) {
      combined = combined.slice(0, MAX_INPUT_CHARS) + '\n\n[input truncated]';
    }

    const systemMsg =
      'You are SUDO\'s memory consolidation system. ' +
      'Given session signals and daily logs, extract and return structured markdown with these sections:\n' +
      '## Key Decisions\n' +
      '## Tool Usage Patterns\n' +
      '## Lessons Learned\n' +
      '## Things to Remember\n\n' +
      'Rules:\n' +
      '- Be concise. Bullet points only.\n' +
      '- Focus on durable insights, not one-off events.\n' +
      '- Total response must not exceed 20000 characters.\n' +
      '- Skip sections that have nothing meaningful to report (write "None" as placeholder).';

    const response = await this.brain.call({
      source: 'consciousness',
      messages: [
        { role: 'system', content: systemMsg },
        {
          role: 'user',
          content: `Please consolidate the following session data:\n\n${combined}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 5_000,
    });

    let consolidation = response.content?.trim() ?? '';

    // Enforce 25 KB cap on the consolidation output.
    if (consolidation.length > MAX_MEMORY_BYTES) {
      consolidation = consolidation.slice(0, MAX_MEMORY_BYTES) + '\n\n[consolidation truncated]';
    }

    // Append dated section to MEMORY.md.
    const dateHeader = `\n\n---\n\n## Dream Cycle — ${new Date().toISOString()}\n\n`;
    const section = dateHeader + consolidation;

    let existing = '';
    if (existsSync(MEMORY_MD)) {
      try {
        existing = await readFile(MEMORY_MD, 'utf8');
      } catch {
        existing = '';
      }
    }

    await writeFile(MEMORY_MD, existing + section, 'utf8');
    appendLog(`Phase 3: wrote ${consolidation.length} chars to MEMORY.md`);

    return consolidation;
  }

  /**
   * Phase 4 — Prune.
   * If MEMORY.md > 25 KB: summarise oldest sections via brain, rewrite condensed.
   * Delete daily log files older than 30 days.
   */
  private async phasePrune(): Promise<void> {
    // Prune MEMORY.md if oversized.
    if (existsSync(MEMORY_MD)) {
      try {
        const content = await readFile(MEMORY_MD, 'utf8');
        if (content.length > MAX_MEMORY_BYTES) {
          appendLog(
            `Phase 4: MEMORY.md is ${content.length} chars — summarising oldest sections`,
          );

          // Split by dream-cycle separators.
          const sections = content.split(/\n---\n/);

          if (sections.length > 2) {
            // Keep the last 2 sections raw; summarise everything before.
            const toSummarise = sections.slice(0, sections.length - 2).join('\n---\n');
            const toKeep = sections.slice(sections.length - 2).join('\n---\n');

            const summaryResponse = await this.brain.call({
              source: 'consciousness',
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a memory archivist. Condense the following older memory sections ' +
                    'into a single compact summary. Preserve all durable facts, decisions, and ' +
                    'patterns. Discard redundant or ephemeral details. Output plain markdown.',
                },
                {
                  role: 'user',
                  content: truncateToTokens(
                    `Summarise these older memory sections:\n\n${toSummarise}`,
                    10_000,
                  ),
                },
              ],
              temperature: 0.2,
              maxTokens: 4_000,
            });

            const archiveSummary = summaryResponse.content?.trim() ?? '';
            const pruned =
              `## Archived Memory (condensed)\n\n${archiveSummary}\n\n---\n\n${toKeep}`;

            await writeFile(MEMORY_MD, pruned, 'utf8');
            appendLog(
              `Phase 4: MEMORY.md pruned to ${pruned.length} chars`,
            );
          }
        }
      } catch (err) {
        appendLog(`Phase 4: MEMORY.md prune failed — ${String(err)}`);
      }
    }

    // Delete daily log files older than 30 days.
    ensureMemoryDir();
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let deleted = 0;

    try {
      const files = readdirSync(MEMORY_DIR);
      for (const f of files) {
        const d = parseLogDate(f);
        if (d !== null && d < cutoff) {
          try {
            unlinkSync(path.join(MEMORY_DIR, f));
            deleted++;
          } catch {
            // Non-fatal per file.
          }
        }
      }
    } catch {
      // Non-fatal.
    }

    if (deleted > 0) {
      appendLog(`Phase 4: deleted ${deleted} daily log files older than ${LOG_RETENTION_DAYS} days`);
    }
  }

  // -------------------------------------------------------------------------
  // DB helpers
  // -------------------------------------------------------------------------

  /** Count total sessions recorded in mind.db. */
  private countTotalSessions(): number {
    let db: ReturnType<typeof Database> | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number };
      return row.cnt;
    } catch {
      return 0;
    } finally {
      try {
        db?.close();
      } catch {
        // Non-fatal.
      }
    }
  }
}
