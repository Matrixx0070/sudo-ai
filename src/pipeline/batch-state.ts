/**
 * @file batch-state.ts
 * Internal state I/O helpers for the daily-batch orchestrator.
 * Handles PipelineState load/save and BatchResult persistence.
 * Not part of the public pipeline API — imported only by daily-batch.ts.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../core/shared/logger.js';
import { PATHS } from '../core/shared/constants.js';
import { todayISO } from '../core/shared/utils.js';
import type { PipelineState, BatchResult } from './types.js';

const log = createLogger('pipeline:batch-state');

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

export const STATE_FILE = path.join(PATHS.DATA, 'pipeline', 'state.json');
export const BATCHES_DIR = path.join(PATHS.DATA, 'pipeline', 'batches');

// ---------------------------------------------------------------------------
// State load / save
// ---------------------------------------------------------------------------

/**
 * Load PipelineState from disk.
 * Creates and returns a fresh default state when the file does not exist
 * or its contents are malformed. Never throws.
 */
export function loadState(): PipelineState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PipelineState;
    if (!Array.isArray(parsed.topicUsage)) {
      throw new Error('topicUsage is not an array');
    }
    return parsed;
  } catch (err) {
    log.warn({ err: String(err) }, 'State file missing or malformed — initialising fresh state');
    return {
      topicUsage: [],
      dailyCostUsd: 0,
      dailyCostResetDate: todayISO(),
      totalVideosProduced: 0,
    };
  }
}

/**
 * Persist PipelineState to disk using a write-then-rename strategy.
 * Errors are logged and swallowed — state persistence failure must never
 * abort a running batch.
 *
 * @param state - The current PipelineState to write.
 */
export function saveState(state: PipelineState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    log.debug(
      { dailyCostUsd: state.dailyCostUsd, total: state.totalVideosProduced },
      'Pipeline state saved',
    );
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to persist pipeline state — non-fatal');
  }
}

/**
 * Save a completed BatchResult to data/pipeline/batches/<batchId>.json.
 * Errors are logged and swallowed.
 *
 * @param result - The BatchResult to persist.
 */
export function saveBatchResult(result: BatchResult): void {
  try {
    fs.mkdirSync(BATCHES_DIR, { recursive: true });
    const filePath = path.join(BATCHES_DIR, `${result.batchId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');
    log.debug({ batchId: result.batchId, filePath }, 'Batch result persisted');
  } catch (err) {
    log.error(
      { err: String(err), batchId: result.batchId },
      'Failed to save batch result — non-fatal',
    );
  }
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

/**
 * Reset the daily cost accumulator when the calendar date has advanced (UTC).
 * Mutates the provided state object in place.
 *
 * @param state - Current PipelineState to mutate.
 */
export function maybeResetDailyCost(state: PipelineState): void {
  const today = todayISO();
  if (state.dailyCostResetDate !== today) {
    log.info(
      { previousDate: state.dailyCostResetDate, previousCost: state.dailyCostUsd },
      'New UTC day — resetting daily cost accumulator',
    );
    state.dailyCostUsd = 0;
    state.dailyCostResetDate = today;
  }
}
