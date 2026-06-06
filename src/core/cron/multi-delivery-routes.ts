/**
 * Multi-Delivery Cron REST Routes
 *
 * HTTP API for managing cron jobs with multiple delivery targets.
 * All routes require Bearer token authentication.
 */

import { createLogger } from '../shared/logger.js';
import type { MultiDeliveryCron } from './multi-delivery.js';
import type { CronJob, DeliveryTarget } from './multi-delivery-types.js';

const log = createLogger('cron:routes');

/** Generate unique ID */
function generateId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse JSON body safely */
function parseBody(req: unknown): Record<string, unknown> {
  const r = req as { body?: unknown };
  if (typeof r.body === 'string') {
    try {
      return JSON.parse(r.body);
    } catch {
      return {};
    }
  }
  return (r.body as Record<string, unknown>) ?? {};
}

/** Send JSON response */
function sendJson(res: unknown, status: number, data: unknown): void {
  const r = res as {
    statusCode?: number;
    setHeader?: (k: string, v: string) => unknown;
    end?: (body: string) => void;
    write?: (body: string) => void;
  };
  r.statusCode = status;
  r.setHeader?.('Content-Type', 'application/json');
  const body = JSON.stringify(data);
  r.end?.(body);
}

/** Extract Bearer token from request */
function getBearerToken(req: unknown): string | null {
  const r = req as { headers?: Record<string, string | string[] | undefined> };
  const auth = r.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  // Also check query param for testing
  const q = r.headers?.query as Record<string, string> | undefined;
  return q?.token ?? null;
}

/** Bearer gate middleware - returns true if authorized */
function bearerGate(req: unknown, res: unknown, allowedToken?: string): boolean {
  const token = getBearerToken(req);
  const expected = allowedToken ?? process.env['GATEWAY_TOKEN'];

  if (!expected) {
    // No token configured - allow all (dev mode)
    return true;
  }

  if (!token || token !== expected) {
    sendJson(res, 401, { error: 'Unauthorized', code: 'BEARER_REQUIRED' });
    return false;
  }

  return true;
}

/** Create REST routes for multi-delivery cron */
export function createCronRoutes(cron: MultiDeliveryCron, allowedToken?: string) {
  return {
    /** GET /v1/admin/cron/jobs - List all jobs */
    listJobs: (req: unknown, res: unknown) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const jobs = cron.listJobs();
      sendJson(res, 200, { jobs, count: jobs.length });
    },

    /** POST /v1/admin/cron/jobs - Create a new job */
    createJob: (req: unknown, res: unknown) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const body = parseBody(req);
      const { name, schedule, prompt, skills, deliver, repeat } = body;

      if (!name || typeof name !== 'string') {
        sendJson(res, 400, { error: 'Missing or invalid name' });
        return;
      }

      if (!schedule || typeof schedule !== 'object') {
        sendJson(res, 400, { error: 'Missing schedule object' });
        return;
      }

      const sched = schedule as { type?: string; value?: string };
      if (!sched.type || !['cron', 'interval'].includes(sched.type)) {
        sendJson(res, 400, { error: 'Schedule type must be "cron" or "interval"' });
        return;
      }

      if (!sched.value || typeof sched.value !== 'string') {
        sendJson(res, 400, { error: 'Schedule value must be a string' });
        return;
      }

      if (!prompt || typeof prompt !== 'string') {
        sendJson(res, 400, { error: 'Missing or invalid prompt' });
        return;
      }

      const job: Omit<CronJob, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt'> = {
        name,
        schedule: { type: sched.type as 'cron' | 'interval', value: sched.value },
        prompt,
        skills: Array.isArray(skills) ? skills : [],
        deliver: Array.isArray(deliver) ? (deliver as DeliveryTarget[]) : [{ type: 'local', config: {} }],
        enabled: true,
      };

      if (repeat && typeof repeat === 'object') {
        const r = repeat as { times?: number };
        if (typeof r.times === 'number' && r.times > 0) {
          job.repeat = { times: r.times, completed: 0 };
        }
      }

      const created = cron.addJob(job);
      log.info({ jobId: created.id, name }, 'Cron job created via REST');
      sendJson(res, 201, { job: created });
    },

    /** GET /v1/admin/cron/jobs/:id - Get a single job */
    getJob: (req: unknown, res: unknown, params?: Record<string, string>) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const p = params ?? (req as { params?: Record<string, string> }).params ?? {};
      const id = p.id;

      if (!id) {
        sendJson(res, 400, { error: 'Missing job id' });
        return;
      }

      const job = cron.getJob(id);
      if (!job) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }

      sendJson(res, 200, { job });
    },

    /** PATCH /v1/admin/cron/jobs/:id - Update a job */
    updateJob: (req: unknown, res: unknown, params?: Record<string, string>) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const p = params ?? (req as { params?: Record<string, string> }).params ?? {};
      const id = p.id;
      const body = parseBody(req);

      if (!id) {
        sendJson(res, 400, { error: 'Missing job id' });
        return;
      }

      const updates: Partial<CronJob> = {};

      if (typeof body.name === 'string') updates.name = body.name;
      if (typeof body.prompt === 'string') updates.prompt = body.prompt;

      if (body.schedule && typeof body.schedule === 'object') {
        const s = body.schedule as { type?: string; value?: string };
        if (s.type && s.value && (s.type === 'cron' || s.type === 'interval')) {
          updates.schedule = { type: s.type as 'cron' | 'interval', value: s.value };
        }
      }

      if (Array.isArray(body.skills)) updates.skills = body.skills;
      if (Array.isArray(body.deliver)) updates.deliver = body.deliver;
      if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;

      if (body.repeat && typeof body.repeat === 'object') {
        const r = body.repeat as { times?: number; completed?: number };
        updates.repeat = {
          times: typeof r.times === 'number' ? r.times : 0,
          completed: typeof r.completed === 'number' ? r.completed : 0,
        };
      }

      const updated = cron.updateJob(id, updates);
      if (!updated) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }

      log.info({ jobId: id }, 'Cron job updated via REST');
      sendJson(res, 200, { job: updated });
    },

    /** DELETE /v1/admin/cron/jobs/:id - Delete a job */
    deleteJob: (req: unknown, res: unknown, params?: Record<string, string>) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const p = params ?? (req as { params?: Record<string, string> }).params ?? {};
      const id = p.id;

      if (!id) {
        sendJson(res, 400, { error: 'Missing job id' });
        return;
      }

      const removed = cron.removeJob(id);
      if (!removed) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }

      log.info({ jobId: id }, 'Cron job deleted via REST');
      sendJson(res, 200, { success: true, id });
    },

    /** POST /v1/admin/cron/jobs/:id/run - Trigger job immediately */
    runJob: async (req: unknown, res: unknown, params?: Record<string, string>) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const p = params ?? (req as { params?: Record<string, string> }).params ?? {};
      const id = p.id;

      if (!id) {
        sendJson(res, 400, { error: 'Missing job id' });
        return;
      }

      const job = cron.getJob(id);
      if (!job) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }

      // Deliver to all targets
      const results = await Promise.all(job.deliver.map((t) => cron.deliverToTarget(job, t)));
      const successCount = results.filter((r) => r.success).length;

      // Mark as run
      (job as { lastRunAt?: string }).lastRunAt = new Date().toISOString();

      log.info({ jobId: id, success: successCount, total: results.length }, 'Cron job manually triggered');
      sendJson(res, 200, { success: true, results, jobId: id });
    },

    /** POST /v1/admin/cron/jobs/:id/enable - Enable a job */
    enableJob: (req: unknown, res: unknown, params?: Record<string, string>) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const p = params ?? (req as { params?: Record<string, string> }).params ?? {};
      const id = p.id;

      if (!id) {
        sendJson(res, 400, { error: 'Missing job id' });
        return;
      }

      const enabled = cron.enableJob(id);
      if (!enabled) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }

      log.info({ jobId: id }, 'Cron job enabled via REST');
      sendJson(res, 200, { success: true, enabled: true, jobId: id });
    },

    /** POST /v1/admin/cron/jobs/:id/disable - Disable a job */
    disableJob: (req: unknown, res: unknown, params?: Record<string, string>) => {
      if (!bearerGate(req, res, allowedToken)) return;

      const p = params ?? (req as { params?: Record<string, string> }).params ?? {};
      const id = p.id;

      if (!id) {
        sendJson(res, 400, { error: 'Missing job id' });
        return;
      }

      const disabled = cron.disableJob(id);
      if (!disabled) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }

      log.info({ jobId: id }, 'Cron job disabled via REST');
      sendJson(res, 200, { success: true, enabled: false, jobId: id });
    },
  };
}
