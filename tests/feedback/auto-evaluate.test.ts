/**
 * @file auto-evaluate.test.ts
 * @description Autonomous self-evaluation: hard behavioural signals override a
 * strict model judge; only real unrated rows are graded; auto rows are tagged
 * and never re-judged; the batch is bounded and fail-soft.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolBrain } from '../../src/core/brain/brain-text.js';

let tmpData: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpData = mkdtempSync(join(tmpdir(), 'autoeval-'));
  saved['DATA_DIR'] = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpData;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmpData, { recursive: true, force: true });
  if (saved['DATA_DIR'] === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = saved['DATA_DIR'];
  vi.resetModules();
});

const importAuto = () => import('../../src/core/feedback/auto-evaluate.js');

function db() {
  return new Database(join(tmpData, 'mind.db'));
}

/** Seed the two tables the evaluator reads. */
function seed(): void {
  const d = db();
  d.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, session_id TEXT, channel TEXT, task_summary TEXT,
      task_type TEXT, rating TEXT, notes TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
      tool_name TEXT, tool_output TEXT, created_at TEXT
    );
  `);
  d.close();
}

function addFeedback(row: { id: string; session_id: string; task_summary: string; rating?: string; notes?: string | null; at: string }): void {
  const d = db();
  d.prepare(`INSERT INTO feedback (id, session_id, channel, task_summary, task_type, rating, notes, created_at)
             VALUES (@id, @session_id, 'telegram', @task_summary, 'general', @rating, @notes, @at)`)
    .run({ rating: 'skip', notes: null, ...row });
  d.close();
}
function addMsg(m: { session_id: string; role: string; content: string; at: string; tool_name?: string; tool_output?: string }): void {
  const d = db();
  d.prepare(`INSERT INTO messages (session_id, role, content, tool_name, tool_output, created_at)
             VALUES (@session_id, @role, @content, @tool_name, @tool_output, @at)`)
    .run({ tool_name: null, tool_output: null, ...m });
  d.close();
}
function ratingOf(id: string): { rating: string; notes: string | null } {
  const d = db();
  const r = d.prepare('SELECT rating, notes FROM feedback WHERE id = ?').get(id) as { rating: string; notes: string | null };
  d.close();
  return r;
}

const fixedBrain = (reply: string): ToolBrain => ({ chat: async () => reply });
const sinceAllTime = '2000-01-01T00:00:00.000Z';

describe('autoEvaluateUnrated — hybrid grading', () => {
  it('AUTO-1: a tool failure forces BAD even if the model would say GOOD', async () => {
    seed();
    const t = '2026-08-17T10:00:00.000Z';
    addMsg({ session_id: 's1', role: 'user', content: 'Deploy the service', at: '2026-08-17T09:59:00.000Z' });
    addMsg({ session_id: 's1', role: 'tool', content: '', tool_name: 'shell', tool_output: '{"success":false,"error":"boom"}', at: '2026-08-17T09:59:30.000Z' });
    addMsg({ session_id: 's1', role: 'assistant', content: 'All done, deployed!', at: t });
    addFeedback({ id: 'f1', session_id: 's1', task_summary: 'Deploy the service', at: t });

    const { autoEvaluateUnrated } = await importAuto();
    const res = await autoEvaluateUnrated(fixedBrain('VERDICT: GOOD\nREASON: looks fine'), { sinceIso: sinceAllTime });
    expect(res.rated).toBe(1);
    expect(res.bad).toBe(1);
    const r = ratingOf('f1');
    expect(r.rating).toBe('bad');
    expect(r.notes).toMatch(/^auto-eval:.*signal.*tool failure/i);
  });

  it('AUTO-2: an owner correction next turn forces BAD', async () => {
    seed();
    const t = '2026-08-17T10:00:00.000Z';
    addMsg({ session_id: 's2', role: 'user', content: 'What is 2+2?', at: '2026-08-17T09:59:00.000Z' });
    addMsg({ session_id: 's2', role: 'assistant', content: 'It is 5.', at: t });
    addMsg({ session_id: 's2', role: 'user', content: 'No, that is wrong.', at: '2026-08-17T10:00:30.000Z' });
    addFeedback({ id: 'f2', session_id: 's2', task_summary: 'What is 2+2?', at: t });

    const { autoEvaluateUnrated } = await importAuto();
    const res = await autoEvaluateUnrated(fixedBrain('VERDICT: GOOD\nREASON: fine'), { sinceIso: sinceAllTime });
    expect(res.bad).toBe(1);
    expect(ratingOf('f2').notes).toMatch(/corrected|re-asked/i);
  });

  it('AUTO-3: explicit praise next turn forces GOOD', async () => {
    seed();
    const t = '2026-08-17T10:00:00.000Z';
    addMsg({ session_id: 's3', role: 'user', content: 'Summarise the doc', at: '2026-08-17T09:59:00.000Z' });
    addMsg({ session_id: 's3', role: 'assistant', content: 'Here is the summary...', at: t });
    addMsg({ session_id: 's3', role: 'user', content: 'Perfect, thanks!', at: '2026-08-17T10:00:20.000Z' });
    addFeedback({ id: 'f3', session_id: 's3', task_summary: 'Summarise the doc', at: t });

    const { autoEvaluateUnrated } = await importAuto();
    // Model says BAD but praise overrides to good.
    const res = await autoEvaluateUnrated(fixedBrain('VERDICT: BAD\nREASON: meh'), { sinceIso: sinceAllTime });
    expect(res.good).toBe(1);
    expect(ratingOf('f3').rating).toBe('good');
  });

  it('AUTO-4: with no hard signal, the model verdict decides', async () => {
    seed();
    const t = '2026-08-17T10:00:00.000Z';
    addMsg({ session_id: 's4', role: 'user', content: 'Write a haiku', at: '2026-08-17T09:59:00.000Z' });
    addMsg({ session_id: 's4', role: 'assistant', content: 'An autumn morning...', at: t });
    addFeedback({ id: 'f4', session_id: 's4', task_summary: 'Write a haiku', at: t });

    const { autoEvaluateUnrated } = await importAuto();
    const res = await autoEvaluateUnrated(fixedBrain('VERDICT: BAD\nREASON: not 5-7-5'), { sinceIso: sinceAllTime });
    expect(res.bad).toBe(1);
    expect(ratingOf('f4').notes).toMatch(/model/i);
  });

  it('AUTO-5: skips marker rows, human-rated rows, and already-auto rows', async () => {
    seed();
    const t = '2026-08-17T10:00:00.000Z';
    addMsg({ session_id: 's5', role: 'assistant', content: 'reply', at: t });
    addFeedback({ id: 'm1', session_id: 's5', task_summary: 'rating-update:x', at: t });                 // marker
    addFeedback({ id: 'h1', session_id: 's5', task_summary: 'a real task', rating: 'bad', at: t });        // human-rated
    addFeedback({ id: 'a1', session_id: 's5', task_summary: 'auto task', notes: 'auto-eval: model: x', at: t }); // already auto (skip+tag)

    const { autoEvaluateUnrated } = await importAuto();
    const res = await autoEvaluateUnrated(fixedBrain('VERDICT: GOOD\nREASON: ok'), { sinceIso: sinceAllTime });
    expect(res.scanned).toBe(0); // none are eligible
    expect(ratingOf('h1').rating).toBe('bad'); // untouched
  });

  it('AUTO-6: an unparseable judge leaves the row unrated (no fabrication)', async () => {
    seed();
    const t = '2026-08-17T10:00:00.000Z';
    addMsg({ session_id: 's6', role: 'user', content: 'anything', at: '2026-08-17T09:59:00.000Z' });
    addMsg({ session_id: 's6', role: 'assistant', content: 'a reply', at: t });
    addFeedback({ id: 'f6', session_id: 's6', task_summary: 'anything', at: t });

    const { autoEvaluateUnrated } = await importAuto();
    const res = await autoEvaluateUnrated(fixedBrain('I am not sure honestly'), { sinceIso: sinceAllTime });
    expect(res.rated).toBe(0);
    expect(ratingOf('f6').rating).toBe('skip'); // left unrated
  });

  it('AUTO-7: respects the cap', async () => {
    seed();
    for (let i = 0; i < 5; i++) {
      const t = `2026-08-17T10:0${i}:00.000Z`;
      addMsg({ session_id: `c${i}`, role: 'assistant', content: 'reply', at: t });
      addFeedback({ id: `c${i}`, session_id: `c${i}`, task_summary: `task ${i}`, at: t });
    }
    const { autoEvaluateUnrated } = await importAuto();
    const res = await autoEvaluateUnrated(fixedBrain('VERDICT: GOOD\nREASON: ok'), { sinceIso: sinceAllTime, cap: 2 });
    expect(res.scanned).toBe(2);
  });
});
