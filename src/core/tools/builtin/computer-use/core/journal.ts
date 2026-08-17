/**
 * @file core/journal.ts
 * @description Append-only action journal for the Computer Use Backend.
 *
 * Every action the executor takes is journaled as one JSONL line: the action,
 * the grounding, the verdict, screenshot hashes before/after, recovery rungs,
 * and latency. This is the backbone of observability AND of replay testing —
 * a recorded journal can drive a deterministic re-run in CI without a display.
 *
 * Writes are best-effort and never throw into the executor's hot path.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import type { StepResult } from './types.js';

const log = createLogger('computer:journal');

export interface JournalEntry {
  ts: number;
  sessionId: string;
  display: string;
  subgoal: string;
  action: StepResult['action'];
  verdict: StepResult['verdict'];
  groundedSource?: string;
  groundedConfidence?: number;
  beforeHash?: string;
  afterHash?: string;
  recovery: string[];
  durationMs: number;
  message: string;
}

export class ActionJournal {
  private readonly path: string;

  constructor(
    private readonly sessionId: string,
    private readonly display: string,
    baseDir = join(process.cwd(), 'data', 'computer-use'),
  ) {
    // Sanitise sessionId for a filesystem path.
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    this.path = join(baseDir, safe, 'journal.jsonl');
  }

  get filePath(): string {
    return this.path;
  }

  async record(subgoal: string, step: StepResult, beforeHash?: string, afterHash?: string): Promise<void> {
    const entry: JournalEntry = {
      ts: Date.now(),
      sessionId: this.sessionId,
      display: this.display,
      subgoal,
      action: step.action,
      verdict: step.verdict,
      groundedSource: step.grounded?.source,
      groundedConfidence: step.grounded?.confidence,
      beforeHash,
      afterHash,
      recovery: step.recovery,
      durationMs: step.durationMs,
      message: step.message,
    };
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      log.warn({ err: String(e), path: this.path }, 'journal append failed (non-fatal)');
    }
  }
}
