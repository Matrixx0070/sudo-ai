/**
 * @file task-type-classify.test.ts
 * @description Task-type classification: the scored heuristic (deterministic,
 * hot-path default), the model-first classifier with taxonomy validation +
 * heuristic fallback, and the bounded analysis-time reclassifier.
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
  tmpData = mkdtempSync(join(tmpdir(), 'tasktype-'));
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

const importStore = () => import('../../src/core/feedback/store.js');

/** A ToolBrain whose reply is fixed (or throws). */
function fakeBrain(reply: string | (() => never)): ToolBrain {
  return { chat: async () => (typeof reply === 'function' ? reply() : reply) };
}

describe('detectTaskType — scored classifier', () => {
  it('SCORE-1: "Fix the build script" is coding, not youtube (the ordered-if bug)', async () => {
    const { detectTaskType } = await importStore();
    // "script" alone matched youtube first under the old if-chain; now "fix" +
    // "build" give coding 2 hits vs youtube's 1.
    expect(detectTaskType('Fix the build script')).toBe('coding');
  });

  it('SCORE-2: each category is reachable from a natural phrase', async () => {
    const { detectTaskType } = await importStore();
    expect(detectTaskType('Upload the new YouTube video')).toBe('youtube');
    expect(detectTaskType('Generate an image of a logo')).toBe('media');
    expect(detectTaskType('Refactor the npm build and fix the bug')).toBe('coding');
    expect(detectTaskType('Schedule a daily cron reminder')).toBe('scheduling');
    expect(detectTaskType('Research pricing trends in the news')).toBe('research');
    expect(detectTaskType('Send an email and a telegram message')).toBe('communication');
    expect(detectTaskType('Check system health and uptime')).toBe('system');
  });

  it('SCORE-3: no keyword → general; word-boundary avoids false hits', async () => {
    const { detectTaskType } = await importStore();
    expect(detectTaskType('Tell me a story about the sea')).toBe('general');
    // "scripture" must NOT match the youtube \bscript\b keyword.
    expect(detectTaskType('Recite a line of scripture')).toBe('general');
  });
});

describe('classifyTaskTypeLLM — model-first with validated fallback', () => {
  it('LLM-1: a valid label is taken verbatim', async () => {
    const { classifyTaskTypeLLM } = await importStore();
    expect(await classifyTaskTypeLLM('anything', fakeBrain('coding'))).toBe('coding');
  });
  it('LLM-2: a noisy but valid label is normalized', async () => {
    const { classifyTaskTypeLLM } = await importStore();
    expect(await classifyTaskTypeLLM('anything', fakeBrain('  Research.\n'))).toBe('research');
  });
  it('LLM-3: an out-of-taxonomy answer falls back to the heuristic', async () => {
    const { classifyTaskTypeLLM } = await importStore();
    // Model returns garbage; heuristic reads the summary → coding.
    expect(await classifyTaskTypeLLM('fix the deploy bug', fakeBrain('banana'))).toBe('coding');
  });
  it('LLM-4: a throwing brain falls back to the heuristic (never throws)', async () => {
    const { classifyTaskTypeLLM } = await importStore();
    const brain = fakeBrain(() => { throw new Error('brain down'); });
    expect(await classifyTaskTypeLLM('research the market trends', brain)).toBe('research');
  });
});

describe('reclassifyAmbiguousRatedTypes — bounded analysis-time refinement', () => {
  it('RECLASS-1: relabels only ambiguous rated rows; skips markers/non-general/skip', async () => {
    const { saveFeedback, reclassifyAmbiguousRatedTypes } = await importStore();
    const now = new Date().toISOString();
    // Target: rated + general + real summary → should be relabelled.
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'debug the failing deploy', task_type: 'general', rating: 'bad', notes: null });
    // Skip: not rated → left alone.
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'another coding task', task_type: 'general', rating: 'skip', notes: null });
    // Already categorised → left alone.
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'make a video', task_type: 'youtube', rating: 'bad', notes: null });
    // Synthetic marker → must be skipped even though rated+general.
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'rating-update:xyz', task_type: 'general', rating: 'bad', notes: null });

    const brain = fakeBrain('coding');
    const n = await reclassifyAmbiguousRatedTypes(brain, new Date(Date.parse(now) - 86_400_000).toISOString());
    expect(n).toBe(1); // only the one real ambiguous rated row

    const db = new Database(join(tmpData, 'mind.db'), { readonly: true });
    const byType = (s: string) =>
      (db.prepare('SELECT task_type FROM feedback WHERE task_summary = ?').get(s) as { task_type: string }).task_type;
    expect(byType('debug the failing deploy')).toBe('coding'); // relabelled
    expect(byType('another coding task')).toBe('general');     // skip rating untouched
    expect(byType('make a video')).toBe('youtube');            // non-general untouched
    expect(byType('rating-update:xyz')).toBe('general');       // marker untouched
    db.close();
  });

  it('RECLASS-2: returns 0 when the model keeps a row as general (no write)', async () => {
    const { saveFeedback, reclassifyAmbiguousRatedTypes } = await importStore();
    saveFeedback({ session_id: 's', channel: 'telegram', task_summary: 'ambiguous chit chat', task_type: 'general', rating: 'good', notes: null });
    const brain = fakeBrain('general');
    const n = await reclassifyAmbiguousRatedTypes(brain, new Date(Date.now() - 86_400_000).toISOString());
    expect(n).toBe(0);
  });
});
