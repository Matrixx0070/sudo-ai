/**
 * @file admin/system.handler.ts
 * @description Admin API handlers for system information and operations.
 *
 * Routes registered:
 *   GET  /api/admin/system/info      — Process and OS info
 *   GET  /api/admin/system/doctor    — Health diagnostics (files, dirs, deps)
 *   POST /api/admin/system/backup    — Create tar.gz backup of data + config
 *   POST /api/admin/system/restore   — Restore from a named backup archive
 *   GET  /api/admin/system/databases — SQLite DB file sizes
 *   GET  /api/admin/system/env       — Sanitised process.env (secrets masked)
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:system');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to the project root (two levels up from dist/src). */
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../../',
);

/** Directories/files checked by the doctor endpoint. */
const DOCTOR_CHECKS: Array<{ label: string; rel: string; type: 'file' | 'dir' }> = [
  { label: 'config/sudo-ai.json5',        rel: 'config/sudo-ai.json5',          type: 'file' },
  { label: 'data/',                        rel: 'data',                           type: 'dir'  },
  { label: 'data/knowledge.db',           rel: 'data/knowledge.db',              type: 'file' },
  { label: 'data/consciousness.db',       rel: 'data/consciousness.db',          type: 'file' },
  { label: 'node_modules/',               rel: 'node_modules',                   type: 'dir'  },
  { label: 'dist/renderer/chat/index.html', rel: 'dist/renderer/chat/index.html', type: 'file' },
];

/** Database files reported by /system/databases. */
const DB_FILES: Array<{ name: string; rel: string }> = [
  { name: 'knowledge.db',      rel: 'data/knowledge.db'      },
  { name: 'consciousness.db',  rel: 'data/consciousness.db'  },
  { name: 'mind.db',           rel: 'data/mind.db'           },
];

/** Pattern for masking sensitive environment variable keys. */
const SENSITIVE_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASS/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromRoot(rel: string): string {
  return path.join(PROJECT_ROOT, rel);
}

function fileSizeBytes(absPath: string): number | null {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return null;
  }
}

function exists(absPath: string, type: 'file' | 'dir'): boolean {
  try {
    const stat = fs.statSync(absPath);
    return type === 'dir' ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/system/info
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/system/info', async (_req, res) => {
  log.debug('system/info requested');

  const memUsage = process.memoryUsage();

  sendJson(res, 200, {
    pid: process.pid,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptimeProcess: Math.round(process.uptime()),
    uptimeSystem: Math.round(os.uptime()),
    memory: {
      rss:        Math.round(memUsage.rss        / 1024 / 1024),
      heapTotal:  Math.round(memUsage.heapTotal  / 1024 / 1024),
      heapUsed:   Math.round(memUsage.heapUsed   / 1024 / 1024),
      external:   Math.round(memUsage.external   / 1024 / 1024),
    },
    cpuCount: os.cpus().length,
    hostname: os.hostname(),
    loadAvg: os.loadavg(),
    projectRoot: PROJECT_ROOT,
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/system/doctor
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/system/doctor', async (_req, res) => {
  log.debug('system/doctor requested');

  const checks = DOCTOR_CHECKS.map(({ label, rel, type }) => {
    const absPath = resolveFromRoot(rel);
    const ok = exists(absPath, type);
    log.debug({ label, absPath, ok }, 'doctor check');
    return { label, ok, path: absPath };
  });

  const allOk = checks.every((c) => c.ok);

  sendJson(res, 200, {
    healthy: allOk,
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/system/backup
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/system/backup', async (_req, res) => {
  log.info('system/backup requested');

  const backupDir = resolveFromRoot('data/backups');

  try {
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    log.error({ err }, 'system/backup: cannot create backup directory');
    sendJson(res, 500, { error: { message: 'Cannot create backup directory', code: 500 } });
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.tar.gz`;
  const backupPath = path.join(backupDir, filename);

  // Build a list of items to include; skip any that do not exist.
  const candidates = [
    'data/knowledge.db',
    'data/consciousness.db',
    'data/mind.db',
    'config',
  ];
  const targets = candidates.filter((rel) => {
    try { fs.statSync(resolveFromRoot(rel)); return true; } catch { return false; }
  });

  if (targets.length === 0) {
    log.warn('system/backup: no target files found to back up');
    sendJson(res, 400, { error: { message: 'No backup targets found', code: 400 } });
    return;
  }

  const cmd = `tar -czf "${backupPath}" ${targets.map((t) => `"${t}"`).join(' ')}`;

  try {
    execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'pipe' });
  } catch (err) {
    log.error({ err, cmd }, 'system/backup: tar command failed');
    sendJson(res, 500, { error: { message: 'Backup failed', code: 500 } });
    return;
  }

  const sizeBytes = fileSizeBytes(backupPath) ?? 0;
  log.info({ filename, sizeBytes }, 'system/backup: backup created');

  sendJson(res, 200, {
    success: true,
    filename,
    path: backupPath,
    sizeBytes,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/system/restore
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/system/restore', async (req, res) => {
  log.info('system/restore requested');

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    log.warn({ err }, 'system/restore: invalid request body');
    sendJson(res, 400, { error: { message: 'Invalid JSON body', code: 400 } });
    return;
  }

  const filename =
    body !== null &&
    typeof body === 'object' &&
    'filename' in body &&
    typeof (body as Record<string, unknown>)['filename'] === 'string'
      ? (body as Record<string, string>)['filename']
      : null;

  if (!filename) {
    sendJson(res, 400, { error: { message: 'Missing required field: filename', code: 400 } });
    return;
  }

  // Prevent directory traversal: filename must not contain path separators.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    log.warn({ filename }, 'system/restore: path traversal attempt rejected');
    sendJson(res, 400, { error: { message: 'Invalid filename', code: 400 } });
    return;
  }

  const backupPath = path.join(resolveFromRoot('data/backups'), filename);

  if (!exists(backupPath, 'file')) {
    log.warn({ backupPath }, 'system/restore: archive not found');
    sendJson(res, 404, { error: { message: 'Backup archive not found', code: 404 } });
    return;
  }

  const cmd = `tar -xzf "${backupPath}" -C "${PROJECT_ROOT}"`;

  try {
    execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'pipe' });
  } catch (err) {
    log.error({ err, backupPath }, 'system/restore: tar extraction failed');
    sendJson(res, 500, { error: { message: 'Restore failed', code: 500 } });
    return;
  }

  log.info({ filename }, 'system/restore: restore completed');
  sendJson(res, 200, {
    success: true,
    filename,
    restoredAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/system/databases
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/system/databases', async (_req, res) => {
  log.debug('system/databases requested');

  const databases = DB_FILES.map(({ name, rel }) => {
    const absPath = resolveFromRoot(rel);
    const sizeBytes = fileSizeBytes(absPath);
    return {
      name,
      path: absPath,
      exists: sizeBytes !== null,
      sizeBytes: sizeBytes ?? 0,
      sizeMB: sizeBytes !== null ? Math.round((sizeBytes / 1024 / 1024) * 100) / 100 : 0,
    };
  });

  sendJson(res, 200, { databases });
});

// ---------------------------------------------------------------------------
// GET /api/admin/system/env
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/system/env', async (_req, res) => {
  log.debug('system/env requested');

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    env[key] = SENSITIVE_PATTERN.test(key) ? '***' : value;
  }

  sendJson(res, 200, { env, count: Object.keys(env).length });
});
