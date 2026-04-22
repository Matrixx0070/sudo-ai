/**
 * @file cron.handler.ts
 * @description Admin API route handlers for /api/admin/cron/* endpoints.
 *
 * File I/O and validation helpers live in cron.store-utils.ts.
 *
 * Routes registered (overriding stubs in admin-router.ts):
 *   GET    /api/admin/cron/jobs
 *   POST   /api/admin/cron/jobs
 *   PUT    /api/admin/cron/jobs/:id
 *   DELETE /api/admin/cron/jobs/:id
 *   POST   /api/admin/cron/jobs/:id/toggle
 *   POST   /api/admin/cron/jobs/:id/run
 *   GET    /api/admin/cron/history
 */

import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import type { CronJob } from '../../cron/types.js';
import {
  genId,
  readJobs,
  writeJobs,
  readHistory,
  validateNewJob,
  validatePatchJob,
  MAX_HISTORY,
} from './cron.store-utils.js';

const log = createLogger('api:admin:cron');

// ---------------------------------------------------------------------------
// Shared body-parse helper
// ---------------------------------------------------------------------------

async function parseBody(req: Parameters<typeof readJsonBody>[0]): Promise<Record<string, unknown> | string> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return err instanceof Error ? err.message : 'Bad request body';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /api/admin/cron/jobs
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/cron/jobs', async (_req, res) => {
  log.debug('GET /api/admin/cron/jobs');
  const jobs = readJobs();
  sendJson(res, 200, { jobs, count: jobs.length });
});

// ---------------------------------------------------------------------------
// POST /api/admin/cron/jobs
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/cron/jobs', async (req, res) => {
  log.debug('POST /api/admin/cron/jobs');

  const result = await parseBody(req);
  if (typeof result === 'string') {
    sendJson(res, 400, { error: { message: result, code: 400 } });
    return;
  }
  const input = result;

  const validErr = validateNewJob(input);
  if (validErr) {
    sendJson(res, 400, { error: { message: validErr, code: 400 } });
    return;
  }

  const newJob: CronJob = {
    id: genId(),
    name: (input['name'] as string).trim(),
    schedule: input['schedule'] as CronJob['schedule'],
    payload: input['payload'] as CronJob['payload'],
    sessionTarget: input['sessionTarget'] as 'main' | 'isolated',
    enabled: typeof input['enabled'] === 'boolean' ? input['enabled'] : true,
    consecutiveErrors: 0,
  };

  const jobs = readJobs();
  jobs.push(newJob);
  try {
    writeJobs(jobs);
  } catch {
    sendJson(res, 500, { error: { message: 'Failed to persist cron jobs', code: 500 } });
    return;
  }

  log.info({ jobId: newJob.id, name: newJob.name }, 'Cron job created');
  sendJson(res, 201, { job: newJob });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/cron/jobs/:id
// ---------------------------------------------------------------------------

adminRouter.put('/api/admin/cron/jobs/:id', async (req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'PUT /api/admin/cron/jobs/:id');

  if (!id) { sendJson(res, 400, { error: { message: 'Job id is required', code: 400 } }); return; }

  const result = await parseBody(req);
  if (typeof result === 'string') {
    sendJson(res, 400, { error: { message: result, code: 400 } });
    return;
  }
  const input = result;

  const validErr = validatePatchJob(input);
  if (validErr) {
    sendJson(res, 400, { error: { message: validErr, code: 400 } });
    return;
  }

  const jobs = readJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    sendJson(res, 404, { error: { message: `Cron job not found: ${id}`, code: 404 } });
    return;
  }

  const existing = jobs[idx]!;
  const updated: CronJob = {
    ...existing,
    ...(input as Partial<CronJob>),
    id: existing.id,
    consecutiveErrors: existing.consecutiveErrors,
  };
  jobs[idx] = updated;

  try {
    writeJobs(jobs);
  } catch {
    sendJson(res, 500, { error: { message: 'Failed to persist cron jobs', code: 500 } });
    return;
  }

  log.info({ jobId: id }, 'Cron job updated');
  sendJson(res, 200, { job: updated });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/cron/jobs/:id
// ---------------------------------------------------------------------------

adminRouter.delete('/api/admin/cron/jobs/:id', async (_req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'DELETE /api/admin/cron/jobs/:id');

  if (!id) { sendJson(res, 400, { error: { message: 'Job id is required', code: 400 } }); return; }

  const jobs = readJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    sendJson(res, 404, { error: { message: `Cron job not found: ${id}`, code: 404 } });
    return;
  }

  jobs.splice(idx, 1);
  try {
    writeJobs(jobs);
  } catch {
    sendJson(res, 500, { error: { message: 'Failed to persist cron jobs', code: 500 } });
    return;
  }

  log.info({ jobId: id }, 'Cron job deleted');
  sendJson(res, 200, { ok: true, deletedId: id });
});

// ---------------------------------------------------------------------------
// POST /api/admin/cron/jobs/:id/toggle
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/cron/jobs/:id/toggle', async (req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'POST /api/admin/cron/jobs/:id/toggle');

  if (!id) { sendJson(res, 400, { error: { message: 'Job id is required', code: 400 } }); return; }

  let forcedEnabled: boolean | undefined;
  try {
    const parsed = await readJsonBody(req);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const p = parsed as Record<string, unknown>;
      if (typeof p['enabled'] === 'boolean') forcedEnabled = p['enabled'];
    }
  } catch { /* flip current value */ }

  const jobs = readJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    sendJson(res, 404, { error: { message: `Cron job not found: ${id}`, code: 404 } });
    return;
  }

  const job = jobs[idx]!;
  const newEnabled = forcedEnabled !== undefined ? forcedEnabled : !job.enabled;
  jobs[idx] = { ...job, enabled: newEnabled };

  try {
    writeJobs(jobs);
  } catch {
    sendJson(res, 500, { error: { message: 'Failed to persist cron jobs', code: 500 } });
    return;
  }

  log.info({ jobId: id, enabled: newEnabled }, 'Cron job toggled');
  sendJson(res, 200, { ok: true, id, enabled: newEnabled });
});

// ---------------------------------------------------------------------------
// POST /api/admin/cron/jobs/:id/run
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/cron/jobs/:id/run', async (_req, res, params) => {
  const { id } = params;
  log.debug({ id }, 'POST /api/admin/cron/jobs/:id/run');

  if (!id) { sendJson(res, 400, { error: { message: 'Job id is required', code: 400 } }); return; }

  const job = readJobs().find((j) => j.id === id);
  if (!job) {
    sendJson(res, 404, { error: { message: `Cron job not found: ${id}`, code: 404 } });
    return;
  }

  log.info({ jobId: id, jobName: job.name }, 'Manual run requested (stub)');
  sendJson(res, 200, { ok: true, id, name: job.name, message: 'Run queued (stub — scheduler not yet wired)' });
});

// ---------------------------------------------------------------------------
// GET /api/admin/cron/history
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/cron/history', async (req, res) => {
  log.debug('GET /api/admin/cron/history');
  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const rawLimit = urlObj.searchParams.get('limit');
  const limit = rawLimit ? Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), MAX_HISTORY) : 50;
  const history = readHistory(limit);
  sendJson(res, 200, { history, count: history.length });
});
