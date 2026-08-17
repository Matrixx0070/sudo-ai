/**
 * @file auto-evaluate.ts
 * @description Autonomous self-evaluation of task quality — so the owner never
 * has to tap 👍/👎. Runs OFF the hot path (batch, at self-improve time). For each
 * recent UNRATED task it reconstructs the exchange from the messages table and
 * decides a rating with a HYBRID policy:
 *
 *   1. Hard behavioural overrides (un-gameable ground truth):
 *        • a tool in the task failed          → bad
 *        • the owner's next turn is a correction/re-ask → bad
 *        • the owner's next turn is explicit praise      → good
 *   2. Otherwise a strict, skeptical model judge grades GOOD/BAD on a rubric.
 *
 * Auto ratings are tagged `auto-eval:` in notes so they are never confused with
 * the owner's own taps and are never re-judged. Bounded + fail-soft: a single
 * bad row (or a judge hiccup) never sinks the batch, and a row we cannot grade
 * confidently is LEFT as 'skip' rather than fabricated.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import { normalizeBrainText, type ToolBrain } from '../brain/brain-text.js';

const log = createLogger('feedback:auto-evaluate');
const DB_PATH = path.join(DATA_DIR, 'mind.db');

/** Notes prefix that marks a row as machine-graded (vs an owner tap). */
export const AUTO_EVAL_PREFIX = 'auto-eval:';

// A tool result counts as a failure when its recorded output looks like one.
const TOOL_FAILURE_RE = /("success"\s*:\s*false|"error"|\berror:|\bfailed\b|\bexception\b|\btraceback\b)/i;
// The owner's NEXT turn signalling the previous answer missed.
const CORRECTION_RE = /\b(no|nope|wrong|incorrect|not what|isn'?t what|that'?s not|didn'?t work|doesn'?t work|try again|still|again|not right|not correct|you (missed|misunderstood))\b/i;
// The owner's NEXT turn signalling satisfaction.
const PRAISE_RE = /\b(thanks|thank you|thx|perfect|great|awesome|nice|excellent|works|worked|correct|exactly|love it|well done)\b/i;

export interface Exchange {
  request: string;
  reply: string;
  toolSummary: string;
  toolFailures: number;
  nextUser: string | null;
}

interface Candidate {
  id: string;
  session_id: string;
  task_summary: string;
  created_at: string;
}

/** Read unrated, real (non-marker, non-auto) candidate rows in the window. */
function readCandidates(db: Database.Database, sinceIso: string, cap: number): Candidate[] {
  return db.prepare(`
    SELECT id, session_id, task_summary, created_at
    FROM feedback
    WHERE rating = 'skip'
      AND (notes IS NULL OR notes NOT LIKE '${AUTO_EVAL_PREFIX}%')
      AND task_summary NOT LIKE 'rating-update:%'
      AND task_summary NOT LIKE 'rating-orphan:%'
      AND task_summary NOT LIKE 'regen-%'
      AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sinceIso, cap) as Candidate[];
}

/**
 * Reconstruct the task around a feedback row: the owner request, SUDO's reply,
 * a compact tool-outcome summary, and the owner's next turn. Reads a small time
 * window of the session's messages and locates the reply at/just before the
 * feedback timestamp.
 */
export function reconstructExchange(
  db: Database.Database,
  sessionId: string,
  aroundIso: string,
  fallbackRequest: string,
): Exchange {
  const around = Date.parse(aroundIso);
  const loIso = new Date(around - 20 * 60_000).toISOString();
  const hiIso = new Date(around + 15 * 60_000).toISOString();
  const rows = db.prepare(`
    SELECT role, content, tool_name, tool_output, created_at
    FROM messages
    WHERE session_id = ? AND created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
  `).all(sessionId, loIso, hiIso) as {
    role: string; content: string; tool_name: string | null; tool_output: string | null; created_at: string;
  }[];

  // Reply = last assistant message at/just before the feedback timestamp.
  const epsilon = around + 60_000; // a reply pre-saves feedback ~immediately
  let replyIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === 'assistant' && Date.parse(rows[i]!.created_at) <= epsilon) { replyIdx = i; break; }
  }
  const reply = replyIdx >= 0 ? rows[replyIdx]!.content : '';

  // Request = last user message before the reply.
  let request = fallbackRequest;
  for (let i = replyIdx >= 0 ? replyIdx : rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === 'user') { request = rows[i]!.content || fallbackRequest; break; }
  }

  // Tools between request and reply.
  let toolFailures = 0;
  const toolBits: string[] = [];
  for (let i = 0; i <= (replyIdx >= 0 ? replyIdx : rows.length - 1); i++) {
    const r = rows[i]!;
    if (r.role !== 'tool') continue;
    const failed = TOOL_FAILURE_RE.test(r.tool_output ?? r.content ?? '');
    if (failed) toolFailures++;
    toolBits.push(`${r.tool_name ?? 'tool'}${failed ? '✗' : '✓'}`);
  }

  // Next owner turn strictly after the reply.
  let nextUser: string | null = null;
  if (replyIdx >= 0) {
    for (let i = replyIdx + 1; i < rows.length; i++) {
      if (rows[i]!.role === 'user') { nextUser = rows[i]!.content; break; }
    }
  }

  return { request, reply, toolSummary: toolBits.join(' '), toolFailures, nextUser };
}

/** Un-gameable behavioural verdict, or null when signals are silent. */
export function hardSignal(ex: Exchange): { rating: 'good' | 'bad'; reason: string } | null {
  if (ex.toolFailures > 0) return { rating: 'bad', reason: `${ex.toolFailures} tool failure(s) in the task` };
  if (ex.nextUser && CORRECTION_RE.test(ex.nextUser)) return { rating: 'bad', reason: 'owner corrected/re-asked next turn' };
  if (ex.nextUser && PRAISE_RE.test(ex.nextUser)) return { rating: 'good', reason: 'owner acknowledged positively next turn' };
  return null;
}

function buildJudgePrompt(ex: Exchange): string {
  return [
    "You are an impartial, skeptical evaluator grading whether SUDO-AI's reply to its owner was GOOD or BAD.",
    'Grade BAD if the reply is incorrect, incomplete, off-topic, evasive, hallucinated, or fails the request.',
    'Grade GOOD only if it genuinely and fully satisfies the request. When unsure, look harder for a flaw.',
    'Respond with EXACTLY two lines:',
    'VERDICT: GOOD or BAD',
    'REASON: one short sentence',
    '',
    '--- Exchange ---',
    `OWNER: ${ex.request.slice(0, 600)}`,
    ex.toolSummary ? `TOOLS: ${ex.toolSummary}` : 'TOOLS: (none)',
    `SUDO: ${ex.reply.slice(0, 1200)}`,
    ex.nextUser ? `OWNER NEXT SAID: ${ex.nextUser.slice(0, 200)}` : '',
  ].filter(Boolean).join('\n');
}

/** Parse the model verdict; null when it cannot be read (→ leave unrated). */
export function parseVerdict(raw: string): { rating: 'good' | 'bad'; reason: string } | null {
  const text = normalizeBrainText(raw);
  const m = /VERDICT:\s*(GOOD|BAD)/i.exec(text);
  if (!m) return null;
  const reasonM = /REASON:\s*(.+)/i.exec(text);
  return {
    rating: m[1]!.toUpperCase() === 'GOOD' ? 'good' : 'bad',
    reason: (reasonM?.[1] ?? 'model verdict').trim().slice(0, 160),
  };
}

async function judge(brain: ToolBrain, ex: Exchange): Promise<{ rating: 'good' | 'bad'; reason: string } | null> {
  try {
    const raw = await brain.chat([{ role: 'user', content: buildJudgePrompt(ex) }]);
    return parseVerdict(raw);
  } catch (err) {
    log.debug({ err: String(err) }, 'Self-eval judge call failed — leaving row unrated');
    return null;
  }
}

export interface AutoEvalResult { scanned: number; rated: number; good: number; bad: number }

/**
 * Grade recent unrated tasks automatically (hybrid: hard behavioural signals
 * override a strict model judge). Bounded by `cap`; rows that cannot be graded
 * confidently are left as 'skip'. Returns the counts. Never throws on one row.
 */
export async function autoEvaluateUnrated(
  brain: ToolBrain,
  opts: { sinceIso: string; cap?: number },
): Promise<AutoEvalResult> {
  const cap = opts.cap ?? 25;

  // Phase 1 — read candidates + reconstruct exchanges, then CLOSE the handle so
  // no connection is held across the judge awaits.
  let prepared: { id: string; ex: Exchange }[];
  {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const cands = readCandidates(db, opts.sinceIso, cap);
      prepared = cands.map((c) => ({ id: c.id, ex: reconstructExchange(db, c.session_id, c.created_at, c.task_summary) }));
    } finally {
      db.close();
    }
  }
  if (prepared.length === 0) return { scanned: 0, rated: 0, good: 0, bad: 0 };

  // Phase 2 — decide each rating (hard signal first, else model judge).
  const verdicts: { id: string; rating: 'good' | 'bad'; reason: string; via: string }[] = [];
  for (const { id, ex } of prepared) {
    if (!ex.reply && ex.toolFailures === 0) continue; // nothing to grade
    const hard = hardSignal(ex);
    if (hard) { verdicts.push({ id, ...hard, via: 'signal' }); continue; }
    const v = await judge(brain, ex);
    if (v) verdicts.push({ id, ...v, via: 'model' });
  }
  if (verdicts.length === 0) return { scanned: prepared.length, rated: 0, good: 0, bad: 0 };

  // Phase 3 — persist (tagged auto-eval so it is never re-judged / confused with taps).
  {
    const db = new Database(DB_PATH);
    try {
      const upd = db.prepare(`UPDATE feedback SET rating = @rating, notes = @notes WHERE id = @id AND rating = 'skip'`);
      db.transaction((vs: typeof verdicts) => vs.forEach((v) =>
        upd.run({ id: v.id, rating: v.rating, notes: `${AUTO_EVAL_PREFIX} ${v.via}: ${v.reason}` }),
      ))(verdicts);
    } finally {
      db.close();
    }
  }

  const good = verdicts.filter((v) => v.rating === 'good').length;
  const bad = verdicts.length - good;
  log.info({ scanned: prepared.length, rated: verdicts.length, good, bad }, 'Auto-evaluated unrated tasks (hybrid)');
  return { scanned: prepared.length, rated: verdicts.length, good, bad };
}
