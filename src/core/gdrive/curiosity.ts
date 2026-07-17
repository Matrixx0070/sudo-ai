/**
 * @file gdrive/curiosity.ts
 * @description F38 — leashed self-directed learning.
 *
 * Mid-task, out-of-scope questions append to a local buffer (one line, zero
 * derailment). Idle windows drain it: BOUNDED research per item (injected
 * research call, token/char caps), output written to knowledge/curiosity/ →
 * routed through the SAME quarantine as inbox files (F18) → ingested at
 * self_acquired trust (F16, lower ranking weight). Hard daily budget; PAUSE
 * halts it; never preempts principal-assigned work (runs on the dream-window
 * cron only).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { ChunkStoreLike, StructuredStoreLike } from './brain-serializer.js';
import { inspectContent, type InspectorBrainCall } from './quarantine.js';
import { chunkText } from './inbox.js';
import { loadBeliefs, saveBeliefs, upsertBelief } from './beliefs.js';
import { isGdrivePaused } from './canary.js';

const log = createLogger('gdrive:curiosity');

interface CuriosityBuffer {
  questions: Array<{ id: string; question: string; addedAt: string }>;
  /** Daily budget tracking. */
  day: string;
  drainedToday: number;
}

export function curiosityPath(): string {
  return dataPath('gdrive', 'curiosity.json');
}

function load(): CuriosityBuffer {
  try {
    const parsed = JSON.parse(readFileSync(curiosityPath(), 'utf-8')) as CuriosityBuffer;
    return { questions: parsed.questions ?? [], day: parsed.day ?? '', drainedToday: parsed.drainedToday ?? 0 };
  } catch {
    return { questions: [], day: '', drainedToday: 0 };
  }
}

function save(buf: CuriosityBuffer): void {
  const p = curiosityPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(buf, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

/** Mid-task append: one line, zero derailment. */
export function appendCuriosity(question: string): void {
  const buf = load();
  if (buf.questions.length >= 100) return; // bounded buffer
  buf.questions.push({ id: randomUUID().slice(0, 8), question: question.slice(0, 400), addedAt: new Date().toISOString() });
  save(buf);
}

export function listCuriosity(): Array<{ id: string; question: string }> {
  return load().questions;
}

export type ResearchCall = (question: string) => Promise<string>;

export interface DrainResult {
  researched: string[];
  held: string[];
  budgetLeft: number;
}

const OUTPUT_CAP_CHARS = 16_000;

/** Idle-window drain: bounded research → quarantine → self_acquired ingest. */
export async function drainCuriosity(
  client: DriveClient,
  folders: FolderIdMap,
  deps: {
    research: ResearchCall;
    chunks: ChunkStoreLike;
    structured: StructuredStoreLike;
    inspectorBrain?: InspectorBrainCall;
    dailyBudget?: number;
    now?: () => Date;
  },
): Promise<DrainResult> {
  const result: DrainResult = { researched: [], held: [], budgetLeft: 0 };
  if (isGdrivePaused()) {
    log.warn('gdrive PAUSED — curiosity drain skipped');
    return result;
  }
  const curiosityFolder = folders['knowledge/curiosity'];
  if (!curiosityFolder) throw new Error('curiosity: knowledge/curiosity folder id missing');
  const dailyBudget = deps.dailyBudget ?? 5;
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);

  const buf = load();
  if (buf.day !== today) {
    buf.day = today;
    buf.drainedToday = 0;
  }
  result.budgetLeft = Math.max(0, dailyBudget - buf.drainedToday);

  while (buf.questions.length > 0 && buf.drainedToday < dailyBudget) {
    const item = buf.questions[0]!;
    let output: string;
    try {
      output = (await deps.research(item.question)).slice(0, OUTPUT_CAP_CHARS);
    } catch (err) {
      log.warn({ id: item.id, err: String(err) }, 'curiosity research failed — item stays buffered');
      break; // research backend down: stop the drain, budget unspent
    }
    buf.drainedToday++;
    buf.questions.shift();

    // SAME quarantine as any inbox file (F18) — self-research is untrusted.
    const verdict = await inspectContent(output, deps.inspectorBrain ? { brainCall: deps.inspectorBrain } : {});
    const name = `curiosity-${item.id}.txt`;
    await client.filesCreate(
      { name, parents: [curiosityFolder] },
      { mimeType: 'text/plain', body: `Q: ${item.question}\n\n${output}` },
    );
    if (verdict.verdict === 'hold') {
      result.held.push(item.id);
      save(buf);
      continue;
    }

    // Ingest at self_acquired trust — lower ranking weight (F16).
    for (const piece of chunkText(output)) {
      deps.chunks.storeChunk(piece, `curiosity/${item.id}`, 'learning', { role: 'assistant' });
    }
    await deps.structured.saveMemory({
      type: 'reference',
      id: `curiosity-${item.id}`,
      name: `Curiosity: ${item.question.slice(0, 80)}`,
      description: 'self_acquired research (curiosity buffer) — lower epistemic weight',
      content: JSON.stringify({ question: item.question, trustTier: 'self_acquired', researchedAt: today }),
    });
    const graph = loadBeliefs();
    upsertBelief(graph, {
      id: `curiosity-${item.id}`,
      chunkPathPrefix: `curiosity/${item.id}`,
      sources: [],
      trustTier: 'self_acquired',
    });
    saveBeliefs(graph);
    result.researched.push(item.id);
    save(buf);
  }
  result.budgetLeft = Math.max(0, dailyBudget - buf.drainedToday);
  save(buf);
  if (result.researched.length || result.held.length) log.info(result, 'curiosity drain complete');
  return result;
}

/** Test/ops probe. */
export function hasCuriosityBuffer(): boolean {
  return existsSync(curiosityPath());
}
