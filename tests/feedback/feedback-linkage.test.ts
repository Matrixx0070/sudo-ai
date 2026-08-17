/**
 * @file feedback-linkage.test.ts
 * @description The owner's 👍/👎 must resolve the ACTUAL pre-saved task row, not
 * mint a synthetic 'rating-update:<uuid>' / task_type='general' orphan. Two bugs
 * used to break this:
 *   1. createFeedbackKeyboard minted a fresh UUID for the buttons while
 *      saveFeedback minted a different id for the row — the button id never
 *      matched any row, so ratings could never resolve.
 *   2. the rating callback therefore INSERTED a garbage marker row, destroying
 *      the task context and poisoning the self-improvement signal.
 * These tests pin the id-linkage, update-in-place, and detector exclusion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpData: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpData = mkdtempSync(join(tmpdir(), 'feedback-link-'));
  saved['DATA_DIR'] = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpData;
  vi.resetModules(); // paths.ts captures DATA_DIR at import time
});

afterEach(() => {
  rmSync(tmpData, { recursive: true, force: true });
  if (saved['DATA_DIR'] === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = saved['DATA_DIR'];
  vi.resetModules();
});

async function importStore() {
  return await import('../../src/core/feedback/store.js');
}
async function importKeyboard() {
  return await import('../../src/core/feedback/keyboard.js');
}

function rows(dir: string): { id: string; task_summary: string; task_type: string; rating: string }[] {
  const db = new Database(join(dir, 'mind.db'), { readonly: true });
  try {
    return db.prepare('SELECT id, task_summary, task_type, rating FROM feedback').all() as never;
  } finally {
    db.close();
  }
}

describe('feedback linkage — rating resolves the real row', () => {
  it('LINK-1: the keyboard feedbackId IS the persisted row id', async () => {
    const { createFeedbackKeyboard } = await importKeyboard();
    const { feedbackId, keyboard } = createFeedbackKeyboard('sess-1', 'Fix the null pointer bug', 'telegram');
    const all = rows(tmpData);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(feedbackId);          // button id == row id
    expect(all[0]!.rating).toBe('skip');           // pending until a tap
    expect(all[0]!.task_type).toBe('coding');      // detected, not 'general'
    // The callback_data carries that exact id.
    const json = JSON.stringify(keyboard);
    expect(json).toContain(`fb:good:${feedbackId}`);
    expect(json).toContain(`fb:bad:${feedbackId}`);
  });

  it('LINK-2: updateFeedbackRating resolves in place, preserving task context', async () => {
    const { createFeedbackKeyboard } = await importKeyboard();
    const { updateFeedbackRating } = await importStore();
    const { feedbackId } = createFeedbackKeyboard('sess-2', 'Research the pricing page', 'telegram');

    const ok = updateFeedbackRating(feedbackId, 'bad');
    expect(ok).toBe(true);

    const all = rows(tmpData);
    expect(all).toHaveLength(1);                    // NO second garbage row
    expect(all[0]!.rating).toBe('bad');             // resolved in place
    expect(all[0]!.task_summary).toBe('Research the pricing page'); // context kept
    expect(all[0]!.task_type).toBe('research');
    expect(all[0]!.task_summary).not.toContain('rating-update');
  });

  it('LINK-3: updateFeedbackRating returns false for an unknown id (no row minted)', async () => {
    const { updateFeedbackRating } = await importStore();
    const ok = updateFeedbackRating('does-not-exist', 'good');
    expect(ok).toBe(false);
    expect(rows(tmpData)).toHaveLength(0);
  });
});

describe('pattern detector — synthetic marker rows are excluded', () => {
  it('DETECT-1: rating-update / rating-orphan / regen markers never become learnings', async () => {
    // Seed real feedback: one genuine bad "coding" task + legacy garbage markers.
    const { saveFeedback } = await importStore();
    // detectPatterns queries the `messages` table unguarded — create an empty one.
    {
      const db = new Database(join(tmpData, 'mind.db'));
      db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, role TEXT, content TEXT,
        tool_name TEXT, tool_output TEXT, created_at TEXT
      )`);
      db.close();
    }
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'Fix the deploy bug', task_type: 'coding', rating: 'bad', notes: null });
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'Fix the lint error', task_type: 'coding', rating: 'bad', notes: null });
    // Legacy/synthetic noise that must be ignored:
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'rating-update:abc', task_type: 'general', rating: 'bad', notes: null });
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'rating-orphan:def', task_type: 'general', rating: 'bad', notes: null });
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'regen-requested:ghi', task_type: 'general', rating: 'bad', notes: null });

    const { detectPatterns } = await import('../../src/core/self-improvement/pattern-detector.js');
    const patterns = detectPatterns(14);
    const types = patterns.badFeedbackTypes.map((p) => p.taskType);
    expect(types).not.toContain('general');        // markers excluded
    // The genuine coding feedback still surfaces (2 bad >= HAVING threshold).
    const coding = patterns.badFeedbackTypes.find((p) => p.taskType === 'coding');
    expect(coding?.bad).toBe(2);
    expect(coding?.badSamples.some((s) => s.includes('rating-'))).toBe(false);
  });
});
