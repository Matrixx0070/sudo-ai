/**
 * Feedback store — durably persists the owner's task ratings in mind.db.
 *
 * Schema (created on first use):
 *   feedback(id, session_id, channel, task_summary, task_type, rating, notes, created_at)
 *
 * Also provides pattern analysis: what types of tasks get bad ratings most.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import { normalizeBrainText, type ToolBrain } from '../brain/brain-text.js';

const log = createLogger('feedback:store');

const DB_PATH = path.join(DATA_DIR, 'mind.db');

export type Rating = 'good' | 'bad' | 'skip';

export interface FeedbackEntry {
  id: string;
  session_id: string;
  channel: string;
  task_summary: string;
  task_type: string;
  rating: Rating;
  notes: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// DB init
// ---------------------------------------------------------------------------

function getDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL DEFAULT '',
      channel      TEXT NOT NULL DEFAULT 'telegram',
      task_summary TEXT NOT NULL DEFAULT '',
      task_type    TEXT NOT NULL DEFAULT 'general',
      rating       TEXT NOT NULL CHECK (rating IN ('good','bad','skip')),
      notes        TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
    CREATE INDEX IF NOT EXISTS idx_feedback_type   ON feedback(task_type);
    CREATE INDEX IF NOT EXISTS idx_feedback_ts     ON feedback(created_at);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Task-type classification
//
// task_type is a grouping key consumed only at ANALYSIS time (the self-improve
// pattern-detector and the meta.feedback tool) — never on the hot path. So the
// capture-time label uses a fast, deterministic heuristic, and a model-based
// refinement (classifyTaskTypeLLM) can upgrade it later where a brain exists.
// ---------------------------------------------------------------------------

/** The single source of truth for task categories (heuristic + LLM share it). */
export const TASK_CATEGORIES = [
  'youtube', 'coding', 'research', 'media', 'system', 'scheduling', 'communication', 'general',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

// Word-boundary keyword sets per category. Iteration order is the tie-breaker
// when two categories score equally (first wins), so more-specific buckets come
// before broad ones. Scoring (count of DISTINCT keyword hits) replaces the old
// ordered if-chain, whose first branch greedily won — e.g. "fix the build
// script" matched youtube on "script" before coding ever got a look.
const CATEGORY_KEYWORDS: Array<{ category: TaskCategory; words: RegExp[] }> = [
  { category: 'youtube', words: [/\byoutube\b/, /\bvideos?\b/, /\bthumbnails?\b/, /\bshorts?\b/, /\bremotion\b/, /\bchannel\b/, /\buploads?\b/, /\bscript\b/] },
  { category: 'media', words: [/\bimages?\b/, /\bphotos?\b/, /\bpictures?\b/, /\bgenerate\b/, /\brender\b/, /\blogo\b/, /\bavatar\b/] },
  { category: 'coding', words: [/\bcode\b/, /\bfix(es|ed|ing)?\b/, /\bbugs?\b/, /\bbuild(s|ing)?\b/, /\bdeploy(s|ed|ing|ment)?\b/, /\btools?\b/, /\bskills?\b/, /\btypescript\b/, /\bnpm\b/, /\brefactor\b/, /\bcompile\b/, /\btests?\b/, /\berrors?\b/, /\bfunctions?\b/, /\bcommit\b/, /\bpull request\b/, /\bpr\b/] },
  { category: 'scheduling', words: [/\bschedules?\b/, /\bscheduled\b/, /\bcron\b/, /\breminders?\b/, /\brecurring\b/, /\bdaily\b/, /\bweekly\b/, /\bevery day\b/] },
  { category: 'research', words: [/\bsearch\b/, /\bresearch\b/, /\bfind\b/, /\btrend(s|ing)?\b/, /\bnews\b/, /\btopics?\b/, /\banalyse\b/, /\banalyze\b/, /\binvestigate\b/, /\bcompare\b/, /\blook up\b/] },
  { category: 'communication', words: [/\bemails?\b/, /\btelegram\b/, /\bnotify\b/, /\bmessages?\b/, /\bsend\b/, /\breply\b/, /\bslack\b/, /\bdiscord\b/, /\bdm\b/] },
  { category: 'system', words: [/\bhealth\b/, /\bstatus\b/, /\bdiagnostics?\b/, /\bmonitor(s|ing)?\b/, /\buptime\b/, /\brestart\b/, /\bpm2\b/, /\bsystem\b/, /\blogs?\b/, /\bmemory\b/, /\bdisk\b/, /\bcpu\b/] },
];

/**
 * Fast, deterministic task-type classifier. Scores each category by the number
 * of distinct keyword hits and returns the highest; ties break by declaration
 * order (more-specific first). Zero-latency and side-effect-free — safe for the
 * hot path. Returns 'general' when nothing matches.
 */
export function detectTaskType(summary: string): TaskCategory {
  const s = summary.toLowerCase();
  let best: TaskCategory = 'general';
  let bestScore = 0;
  for (const { category, words } of CATEGORY_KEYWORDS) {
    let score = 0;
    for (const re of words) if (re.test(s)) score++;
    if (score > bestScore) { bestScore = score; best = category; }
  }
  return best;
}

/** Prompt a model to pick exactly one category — the model-first classifier. */
function buildClassifyPrompt(summary: string): string {
  return [
    'Classify the following task into exactly ONE category.',
    `Categories: ${TASK_CATEGORIES.join(', ')}.`,
    'Reply with ONLY the single category word — no punctuation, no explanation.',
    '',
    `Task: "${summary.slice(0, 300)}"`,
  ].join('\n');
}

/**
 * Model-first task-type classifier. Asks the brain to pick one TASK_CATEGORIES
 * label and validates the answer against the taxonomy; any invalid, empty, or
 * failed response falls back to the deterministic heuristic. Never throws.
 * Used OFF the hot path (analysis-time refinement) — see
 * reclassifyAmbiguousRatedTypes.
 */
export async function classifyTaskTypeLLM(summary: string, brain: ToolBrain): Promise<TaskCategory> {
  try {
    const raw = await brain.chat([{ role: 'user', content: buildClassifyPrompt(summary) }]);
    const label = normalizeBrainText(raw).trim().toLowerCase().replace(/[^a-z]/g, '');
    if ((TASK_CATEGORIES as readonly string[]).includes(label)) return label as TaskCategory;
    log.debug({ label, summary: summary.slice(0, 40) }, 'LLM task-type not in taxonomy — using heuristic');
    return detectTaskType(summary);
  } catch (err) {
    log.debug({ err: String(err) }, 'LLM task-type classify failed — using heuristic');
    return detectTaskType(summary);
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function saveFeedback(entry: Omit<FeedbackEntry, 'id' | 'created_at'>, id: string = randomUUID()): string {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO feedback (id, session_id, channel, task_summary, task_type, rating, notes)
      VALUES (@id, @session_id, @channel, @task_summary, @task_type, @rating, @notes)
    `).run({ id, ...entry });
    log.info({ id, rating: entry.rating, type: entry.task_type }, 'Feedback saved');
  } finally {
    db.close();
  }
  return id;
}

/**
 * Resolve a pending feedback row to its final rating IN PLACE, preserving the
 * task_summary and task_type captured at pre-save. This is how a 👍/👎 tap is
 * recorded — NOT a fresh insert. Returns true if a row with this id existed.
 *
 * Before this existed the rating callback inserted a synthetic
 * `rating-update:<uuid>` / task_type='general' row (the button id never matched
 * any real row — see keyboard.ts), so every rating destroyed its task context
 * and polluted the self-improvement signal with meaningless "general 80% bad"
 * noise. Updating by id keeps the real task attached to the owner's verdict.
 */
export function updateFeedbackRating(feedbackId: string, rating: Rating, notes?: string): boolean {
  const db = getDb();
  try {
    const res = db.prepare(
      `UPDATE feedback SET rating = @rating${notes !== undefined ? ', notes = @notes' : ''} WHERE id = @id`,
    ).run({ id: feedbackId, rating, notes: notes ?? null });
    const matched = res.changes > 0;
    log.info({ feedbackId, rating, matched }, matched ? 'Feedback rating resolved in place' : 'Feedback rating: no row matched id');
    return matched;
  } finally {
    db.close();
  }
}

/**
 * Analysis-time refinement: upgrade the coarse 'general' bucket on RATED
 * (good/bad) rows to accurate categories using the model. Bounded and idempotent
 * — only touches 'general' rated rows in the window, capped, and skips synthetic
 * marker rows. Runs OFF the hot path (self-improve), so LLM latency is fine.
 * Returns the number of rows re-labelled. Never throws on a single bad row.
 */
export async function reclassifyAmbiguousRatedTypes(
  brain: ToolBrain,
  sinceIso: string,
  cap = 30,
): Promise<number> {
  let rows: { id: string; task_summary: string }[];
  {
    const db = getDb();
    try {
      rows = db.prepare(`
        SELECT id, task_summary FROM feedback
        WHERE rating IN ('good','bad')
          AND task_type = 'general'
          AND created_at >= ?
          AND task_summary NOT LIKE 'rating-update:%'
          AND task_summary NOT LIKE 'rating-orphan:%'
          AND task_summary NOT LIKE 'regen-%'
        ORDER BY created_at DESC
        LIMIT ?
      `).all(sinceIso, cap) as { id: string; task_summary: string }[];
    } finally {
      db.close();
    }
  }
  if (rows.length === 0) return 0;

  // Classify with the DB connection closed — do not hold a handle across awaits.
  const updates: { id: string; t: string }[] = [];
  for (const r of rows) {
    const t = await classifyTaskTypeLLM(r.task_summary, brain);
    if (t !== 'general') updates.push({ id: r.id, t });
  }
  if (updates.length === 0) return 0;

  const db = getDb();
  try {
    const upd = db.prepare(`UPDATE feedback SET task_type = @t WHERE id = @id`);
    db.transaction((us: { id: string; t: string }[]) => us.forEach((u) => upd.run(u)))(updates);
  } finally {
    db.close();
  }
  log.info({ scanned: rows.length, relabelled: updates.length }, 'Reclassified ambiguous rated feedback types (LLM)');
  return updates.length;
}

export function addNoteToFeedback(feedbackId: string, notes: string): void {
  const db = getDb();
  try {
    db.prepare(`UPDATE feedback SET notes = @notes WHERE id = @id`).run({ notes, id: feedbackId });
    log.info({ feedbackId }, 'Feedback note added');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface FeedbackStats {
  total: number;
  good: number;
  bad: number;
  skip: number;
  goodRate: number;
  byType: Record<string, { good: number; bad: number }>;
  recentBadSummaries: string[];
}

export function getFeedbackStats(limitDays = 30): FeedbackStats {
  const db = getDb();
  try {
    const since = new Date(Date.now() - limitDays * 86_400_000).toISOString();

    const rows = db.prepare(`
      SELECT rating, task_type, task_summary
      FROM feedback
      WHERE created_at >= ?
    `).all(since) as { rating: string; task_type: string; task_summary: string }[];

    const stats: FeedbackStats = {
      total: rows.length,
      good: 0, bad: 0, skip: 0,
      goodRate: 0,
      byType: {},
      recentBadSummaries: [],
    };

    for (const r of rows) {
      if (r.rating === 'good') stats.good++;
      else if (r.rating === 'bad') stats.bad++;
      else stats.skip++;

      if (!stats.byType[r.task_type]) stats.byType[r.task_type] = { good: 0, bad: 0 };
      if (r.rating === 'good') stats.byType[r.task_type]!.good++;
      if (r.rating === 'bad') {
        stats.byType[r.task_type]!.bad++;
        stats.recentBadSummaries.push(r.task_summary.slice(0, 80));
      }
    }

    const rated = stats.good + stats.bad;
    stats.goodRate = rated > 0 ? Math.round((stats.good / rated) * 100) : 100;
    stats.recentBadSummaries = stats.recentBadSummaries.slice(-5);

    return stats;
  } finally {
    db.close();
  }
}
