/**
 * @file refine-before-detection.ts
 * @description Pre-detection feedback refinement for the self-improvement run.
 * Two bounded, fail-soft, off-hot-path passes that make the signal the detector
 * groups on both HONEST and ACCURATE:
 *
 *   1. Autonomous self-evaluation — grade recent UNRATED tasks good/bad (hybrid:
 *      hard behavioural signals override a strict model judge) so the loop
 *      learns without the owner tapping 👍/👎. Env SUDO_AUTO_FEEDBACK=0 disables.
 *   2. Task-type refinement — upgrade coarse 'general' labels on rated rows via
 *      the model before the detector groups by task_type.
 *
 * Kept out of engine.ts so the engine stays a thin orchestrator.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import { reclassifyAmbiguousRatedTypes } from '../feedback/store.js';
import { autoEvaluateUnrated, type AutoEvalResult } from '../feedback/auto-evaluate.js';
import type { ToolBrain } from '../brain/brain-text.js';

const log = createLogger('self-improvement:refine');
const DB_PATH = path.join(DATA_DIR, 'mind.db');

export interface RefinementResult {
  autoRated: AutoEvalResult;
  reclassified: number;
}

/**
 * Run the auto-evaluation and type-refinement passes before detection. Each pass
 * is independently fail-soft — a hiccup in one never sinks the run or the other.
 */
export async function refineBeforeDetection(
  opts: { autoRater?: ToolBrain; taskClassifier?: ToolBrain; windowSince: string },
): Promise<RefinementResult> {
  let autoRated: AutoEvalResult = { scanned: 0, rated: 0, good: 0, bad: 0 };
  let reclassified = 0;

  if (opts.autoRater && existsSync(DB_PATH) && process.env['SUDO_AUTO_FEEDBACK'] !== '0') {
    try {
      autoRated = await autoEvaluateUnrated(opts.autoRater, { sinceIso: opts.windowSince });
      if (autoRated.rated > 0) log.info(autoRated, 'Auto-evaluated unrated tasks before detection');
    } catch (err) {
      log.warn({ err: String(err) }, 'Auto-evaluation failed — continuing without new ratings');
    }
  }

  if (opts.taskClassifier && existsSync(DB_PATH)) {
    try {
      reclassified = await reclassifyAmbiguousRatedTypes(opts.taskClassifier, opts.windowSince);
      if (reclassified > 0) log.info({ reclassified }, 'Feedback task types refined by model before detection');
    } catch (err) {
      log.warn({ err: String(err) }, 'Task-type refinement failed — continuing with heuristic labels');
    }
  }

  return { autoRated, reclassified };
}
