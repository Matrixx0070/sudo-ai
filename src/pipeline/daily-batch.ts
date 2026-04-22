/**
 * @file daily-batch.ts
 * Main cron orchestrator for the SUDO-AI YouTube content pipeline.
 * Runs 3 scheduled batches per day (02:00, 10:00, 16:00 IST) producing 2-3 videos each.
 * Batch-level failures are contained — individual video errors never abort the batch.
 */

import { Cron } from 'croner';
import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { genId, sleep } from '../core/shared/utils.js';
import { selectTopics } from './topic-selector.js';
import { generateScript } from './script-generator.js';
import { renderScenes } from './scene-renderer.js';
import { generateVoice } from './voice-generator.js';
import { assembleVideo } from './video-assembler.js';
import { runQualityCheck } from './quality-gate.js';
import { generateSeoMetadata } from './seo-tagger.js';
import { uploadToYouTube } from './youtube-uploader.js';
import { sendNotification } from './notifier.js';
import { runOptimization } from './optimizer.js';
import { loadState, saveState, saveBatchResult, maybeResetDailyCost } from './batch-state.js';
import type {
  DailyBatchConfig,
  BatchSchedule,
  BatchResult,
  BatchVideoResult,
  TopicUsageRecord,
} from './types.js';

const log = createLogger('pipeline:daily-batch');

/**
 * Return the canonical DailyBatchConfig for the SUDO-AI pipeline.
 * Three batches target 02:00, 10:00, and 16:00 IST (UTC+5:30).
 */
export function getBatchConfig(): DailyBatchConfig {
  return {
    schedules: [
      // 02:00 IST = 20:30 UTC previous day
      { name: 'batch_0200', cronExpression: '0 30 20 * * *', videoCount: 3, format: 'short' as const },
      // 10:00 IST = 04:30 UTC
      { name: 'batch_1000', cronExpression: '0 30 4 * * *', videoCount: 3, format: 'short' as const },
      // 16:00 IST = 10:30 UTC
      { name: 'batch_1600', cronExpression: '0 30 10 * * *', videoCount: 2, format: 'short' as const },
    ],
    maxCostPerBatchUsd: 2.0,
    maxCostPerDayUsd: 5.0,
    maxRetries: 2,
    staggerDelayMs: 30_000,
  };
}

/** Run one video through the full 7-stage pipeline. Never throws — all errors are caught. */
async function processVideo(
  videoResult: BatchVideoResult,
  batchId: string,
  format: DailyBatchConfig['schedules'][0]['format'],
): Promise<void> {
  const { videoId, topic } = videoResult;
  try {
    videoResult.status = 'scripting';
    const script = await generateScript(topic);
    videoResult.script = script;

    videoResult.status = 'rendering';
    const scenes = await renderScenes(script);
    videoResult.scenes = scenes;
    videoResult.totalCostUsd += scenes.costUsd;

    videoResult.status = 'voicing';
    const voice = await generateVoice(script);
    videoResult.voice = voice;
    videoResult.totalCostUsd += voice.costUsd;

    videoResult.status = 'assembling';
    const assembly = await assembleVideo(script, scenes, voice);
    videoResult.assembly = assembly;
    videoResult.totalCostUsd += assembly.costUsd;

    videoResult.status = 'quality_check';
    const quality = await runQualityCheck(assembly, format);
    videoResult.quality = quality;
    log.info({ videoId, grade: quality.grade, passed: quality.passed }, 'Quality check complete');

    if (!quality.passed) {
      videoResult.status = 'failed';
      videoResult.error = `Quality gate failed: grade=${quality.grade}`;
      await sendNotification({ type: 'video_failed', batchId,
        message: `Video ${videoId} rejected by quality gate (grade ${quality.grade})`,
        details: { videoId, error: videoResult.error, grade: quality.grade } });
      return;
    }

    videoResult.status = 'tagging';
    const seo = await generateSeoMetadata(script, assembly);
    videoResult.seo = seo;
    videoResult.totalCostUsd += seo.costUsd;

    videoResult.status = 'uploading';
    const upload = await uploadToYouTube(assembly.videoPath, assembly.thumbnailPath, seo);
    videoResult.upload = upload;
    videoResult.status = 'complete';
    await sendNotification({ type: 'video_complete', batchId,
      message: `Video ${videoId} uploaded successfully`,
      details: { videoId, youtubeUrl: upload.youtubeUrl, costUsd: videoResult.totalCostUsd } });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    videoResult.status = 'failed';
    videoResult.error = errMsg;
    log.error({ batchId, videoId, err: errMsg }, 'Video pipeline stage failed — continuing batch');
    await sendNotification({ type: 'video_failed', batchId,
      message: `Video ${videoId} failed: ${errMsg.slice(0, 200)}`,
      details: { videoId, error: errMsg } });
  } finally {
    videoResult.completedAt = new Date().toISOString();
  }
}

/**
 * Execute a single pipeline batch: select topics, process each video through
 * the 7-stage pipeline, and persist results to disk.
 * Individual video failures are caught and recorded; the batch always completes.
 *
 * @param config   - DailyBatchConfig with cost limits and stagger settings.
 * @param schedule - The specific BatchSchedule (name, videoCount, format).
 * @returns BatchResult with per-video outcomes and aggregate cost/status.
 */
export async function runBatch(
  config: DailyBatchConfig,
  schedule: BatchSchedule,
): Promise<BatchResult> {
  if (!config || !schedule?.name) {
    throw new PipelineError(
      'runBatch: config and schedule.name are required',
      'pipeline_batch_invalid_args',
    );
  }

  const batchId = genId();
  const startedAt = new Date().toISOString();

  log.info({ batchId, scheduleName: schedule.name, videoCount: schedule.videoCount }, 'Batch start');

  const result: BatchResult = {
    batchId,
    scheduleName: schedule.name,
    videos: [],
    totalCostUsd: 0,
    startedAt,
    status: 'running',
  };

  const state = loadState();
  maybeResetDailyCost(state);

  // Daily budget guard
  if (state.dailyCostUsd >= config.maxCostPerDayUsd) {
    log.warn({ dailyCostUsd: state.dailyCostUsd }, 'Daily budget exhausted — skipping batch');
    result.status = 'failed';
    result.completedAt = new Date().toISOString();
    await sendNotification({
      type: 'batch_complete',
      batchId,
      message: `Batch ${batchId} skipped — daily budget exhausted ($${state.dailyCostUsd.toFixed(4)})`,
      details: { successful: 0, total: 0, costUsd: 0 },
    });
    return result;
  }

  await sendNotification({
    type: 'batch_start',
    batchId,
    message: `Batch ${batchId} (${schedule.name}) started — producing ${schedule.videoCount} video(s)`,
    details: { videoCount: schedule.videoCount, scheduleName: schedule.name },
  });

  // Topic selection — abort batch on failure (no topics = nothing to produce)
  let topics;
  try {
    topics = selectTopics(schedule.videoCount, state);
  } catch (err) {
    log.error({ err: String(err), batchId }, 'Topic selection failed — aborting batch');
    result.status = 'failed';
    result.completedAt = new Date().toISOString();
    return result;
  }

  log.info({ batchId, topicCount: topics.length }, 'Topics selected');

  // Sequential video processing with stagger
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i]!;
    const videoResult: BatchVideoResult = {
      videoId: genId(),
      topic,
      status: 'pending',
      format: schedule.format,
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    };

    result.videos.push(videoResult);
    log.info({ batchId, videoId: videoResult.videoId, topicId: topic.entry.id }, 'Processing video');

    await processVideo(videoResult, batchId, schedule.format);
    result.totalCostUsd += videoResult.totalCostUsd;

    if (result.totalCostUsd >= config.maxCostPerBatchUsd) {
      log.warn({ batchId, batchCostUsd: result.totalCostUsd }, 'Per-batch cost cap reached — stopping early');
      break;
    }

    if (i < topics.length - 1) {
      await sleep(config.staggerDelayMs);
    }
  }

  // Determine aggregate status
  const completed = result.videos.filter((v) => v.status === 'complete').length;
  const total = result.videos.length;
  result.status = total === 0 || completed === 0 ? 'failed' : completed === total ? 'complete' : 'partial';
  result.completedAt = new Date().toISOString();

  // Append usage records and flush state
  const usageRecords: TopicUsageRecord[] = result.videos.map((v) => ({
    topicId: v.topic.entry.id,
    usedAt: v.startedAt,
    batchId,
    youtubeVideoId: v.upload?.youtubeVideoId,
  }));
  state.topicUsage.push(...usageRecords);
  state.lastBatchId = batchId;
  state.lastBatchAt = result.completedAt;
  state.dailyCostUsd += result.totalCostUsd;
  state.totalVideosProduced += completed;

  saveState(state);
  saveBatchResult(result);

  log.info({ batchId, status: result.status, completed, total, totalCostUsd: result.totalCostUsd }, 'Batch complete');

  await sendNotification({
    type: 'batch_complete',
    batchId,
    message: `Batch ${batchId} (${schedule.name}): ${completed}/${total} uploaded`,
    details: { successful: completed, total, costUsd: result.totalCostUsd },
  });

  return result;
}

/**
 * Register all daily cron jobs using croner (UTC timezone).
 * Schedules three video batch jobs and one nightly optimizer run.
 * Runs indefinitely — call from the process entry point.
 */
export async function runDailyCron(): Promise<void> {
  const config = getBatchConfig();

  log.info({ scheduleCount: config.schedules.length }, 'Registering daily pipeline cron jobs');

  for (const schedule of config.schedules) {
    new Cron(schedule.cronExpression, { timezone: 'UTC' }, async () => {
      log.info({ scheduleName: schedule.name }, 'Cron triggered — starting batch');
      try {
        await runBatch(config, schedule);
      } catch (err) {
        log.error({ scheduleName: schedule.name, err: String(err) }, 'Unexpected cron batch error');
      }
    });

    log.info(
      { scheduleName: schedule.name, cron: schedule.cronExpression, videoCount: schedule.videoCount },
      'Cron job registered',
    );
  }

  // Nightly optimizer: 23:00 IST = 17:30 UTC
  new Cron('0 30 17 * * *', { timezone: 'UTC' }, async () => {
    log.info('Nightly optimizer cron triggered');
    try {
      const result = await runOptimization();
      log.info({ categories: Object.keys(result.topicWeightAdjustments).length }, 'Nightly optimization complete');
    } catch (err) {
      log.error({ err: String(err) }, 'Nightly optimizer failed — non-fatal');
    }
  });

  log.info('Nightly optimizer registered (17:30 UTC / 23:00 IST)');
  log.info('All pipeline cron jobs active — process running');
}
