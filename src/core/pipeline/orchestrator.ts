/**
 * PipelineOrchestrator — manages the 10-stage video production pipeline.
 * Checkpoints after every stage so runs can be paused and resumed safely.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError } from '../shared/errors.js';
import { genId, todayISO } from '../shared/utils.js';
import {
  type PipelineRun,
  type PipelineRunOptions,
  type PipelineStage,
  PIPELINE_STAGES,
} from './types.js';
import { runResearch } from './stages/research.js';
import { runDirection } from './stages/direction.js';
import { runReview } from './stages/review.js';
import { runImageGen } from './stages/image-gen.js';
import { runVideoGen } from './stages/video-gen.js';
import { runVoice } from './stages/voice.js';
import { runMusic } from './stages/music.js';
import { runSfx } from './stages/sfx.js';
import { runAssembly } from './stages/assembly.js';
import { runQualityGate } from './stages/quality-gate.js';

const log = createLogger('pipeline:orchestrator');

// In-memory run store (replace with MindDB integration in production).
const runStore = new Map<string, PipelineRun>();

// ---------------------------------------------------------------------------
// Stage runner registry
// ---------------------------------------------------------------------------

type StageRunner = (
  run: PipelineRun,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkpoint: Record<string, any>,
) => Promise<Record<string, unknown>>;

const STAGE_RUNNERS: Record<PipelineStage, StageRunner> = {
  research: runResearch,
  direction: runDirection,
  review: runReview,
  image_gen: runImageGen,
  video_gen: runVideoGen,
  voice: runVoice,
  music: runMusic,
  sfx: runSfx,
  assembly: runAssembly,
  quality_gate: runQualityGate,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class PipelineOrchestrator {
  /**
   * Start a new pipeline run for the given topic.
   * If options.resumeFromRunId is set, resumes that run from its last checkpoint.
   */
  async run(topic: string, options: PipelineRunOptions = {}): Promise<PipelineRun> {
    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      throw new PipelineError('topic must be a non-empty string', 'pipeline_invalid_topic');
    }

    let run: PipelineRun;

    if (options.resumeFromRunId) {
      const existing = runStore.get(options.resumeFromRunId);
      if (!existing) {
        throw new PipelineError(
          `No run found with id ${options.resumeFromRunId}`,
          'pipeline_run_not_found',
          { runId: options.resumeFromRunId },
        );
      }
      if (existing.status === 'done') {
        log.warn({ runId: existing.id }, 'Run already completed — returning as-is');
        return existing;
      }
      run = { ...existing, status: 'running' };
      log.info({ runId: run.id, stage: run.stage }, 'Resuming pipeline run');
    } else {
      run = {
        id: genId(),
        taskId: genId(),
        topic: topic.trim(),
        stage: PIPELINE_STAGES[0] as PipelineStage,
        stageIndex: 0,
        checkpoint: {},
        totalCost: 0,
        status: 'running',
        createdAt: todayISO(),
      };
      log.info({ runId: run.id, topic: run.topic }, 'Starting new pipeline run');
    }

    runStore.set(run.id, run);

    const startIndex = run.stageIndex;

    for (let i = startIndex; i < PIPELINE_STAGES.length; i++) {
      const stage = PIPELINE_STAGES[i] as PipelineStage;

      if (options.skipStages?.includes(stage)) {
        log.info({ runId: run.id, stage }, 'Skipping stage (in skipStages list)');
        run.stageIndex = i + 1;
        continue;
      }

      // Check paused state after each iteration to allow external pause signals.
      const current = runStore.get(run.id);
      if (current?.status === 'paused') {
        log.info({ runId: run.id, stage }, 'Run paused before stage');
        return current;
      }

      run.stage = stage;
      run.stageIndex = i;
      runStore.set(run.id, run);

      log.info({ runId: run.id, stage, stageIndex: i }, 'Executing stage');

      try {
        if (options.maxCostUsd !== undefined && run.totalCost >= options.maxCostUsd) {
          throw new PipelineError(
            `Cost ceiling reached: $${run.totalCost.toFixed(4)} >= $${options.maxCostUsd}`,
            'pipeline_cost_ceiling',
            { totalCost: run.totalCost, maxCostUsd: options.maxCostUsd },
          );
        }

        const runner = STAGE_RUNNERS[stage];
        const stageOutput = options.dryRun
          ? { dryRun: true }
          : await runner(run, run.checkpoint);

        // Merge stage output into checkpoint and track director plan.
        run.checkpoint = { ...run.checkpoint, [stage]: stageOutput };

        if (stage === 'direction' && stageOutput['plan']) {
          run.directorPlan = stageOutput['plan'] as PipelineRun['directorPlan'];
        }

        if (typeof stageOutput['costUsd'] === 'number') {
          run.totalCost += stageOutput['costUsd'] as number;
        }

        run.stageIndex = i + 1;
        runStore.set(run.id, run);
        log.info({ runId: run.id, stage, totalCost: run.totalCost }, 'Stage complete');
      } catch (err) {
        run.status = 'failed';
        runStore.set(run.id, run);
        const message = err instanceof Error ? err.message : String(err);
        log.error({ runId: run.id, stage, err: message }, 'Stage failed — pipeline halted');
        throw new PipelineError(
          `Stage "${stage}" failed: ${message}`,
          'pipeline_stage_failed',
          { stage, runId: run.id },
        );
      }
    }

    run.status = 'done';
    run.completedAt = todayISO();
    runStore.set(run.id, run);
    log.info({ runId: run.id, totalCost: run.totalCost }, 'Pipeline run completed');
    return run;
  }

  /** Pause a running pipeline. Takes effect before the next stage starts. */
  pause(runId: string): void {
    const run = runStore.get(runId);
    if (!run) {
      throw new PipelineError(`Run not found: ${runId}`, 'pipeline_run_not_found', { runId });
    }
    if (run.status !== 'running') {
      throw new PipelineError(
        `Cannot pause run in status "${run.status}"`,
        'pipeline_invalid_status',
        { runId, status: run.status },
      );
    }
    run.status = 'paused';
    runStore.set(runId, run);
    log.info({ runId }, 'Pipeline run paused');
  }

  /** Resume a paused run from its last checkpoint. */
  async resume(runId: string): Promise<PipelineRun> {
    const run = runStore.get(runId);
    if (!run) {
      throw new PipelineError(`Run not found: ${runId}`, 'pipeline_run_not_found', { runId });
    }
    if (run.status !== 'paused') {
      throw new PipelineError(
        `Cannot resume run in status "${run.status}"`,
        'pipeline_invalid_status',
        { runId, status: run.status },
      );
    }
    log.info({ runId, stage: run.stage, stageIndex: run.stageIndex }, 'Resuming paused run');
    return this.run(run.topic, { resumeFromRunId: runId });
  }

  /** Return current state of a run. */
  getStatus(runId: string): PipelineRun {
    const run = runStore.get(runId);
    if (!run) {
      throw new PipelineError(`Run not found: ${runId}`, 'pipeline_run_not_found', { runId });
    }
    return { ...run };
  }

  /** List all known runs, most recent first. */
  listRuns(): PipelineRun[] {
    return Array.from(runStore.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r }));
  }
}
