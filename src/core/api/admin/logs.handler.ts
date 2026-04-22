/**
 * @file admin/logs.handler.ts
 * @description Admin API handlers for log retrieval and download.
 *
 * Routes registered:
 *   GET /api/admin/logs          — Filtered, paginated log entries (JSON)
 *   GET /api/admin/logs/download — Stream raw log file as text/plain
 *
 * Log format: pino JSON Lines — one JSON object per line.
 * The file lives at data/logs/sudo-ai.log relative to the project root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { adminRouter, sendJson } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:logs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to the project root. */
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../../',
);

const LOG_FILE = path.join(PROJECT_ROOT, 'data/logs/sudo-ai.log');

/** Maximum lines returned in a single request. Hard cap prevents OOM. */
const MAX_LIMIT = 2000;

/** Default number of lines returned when no limit param supplied. */
const DEFAULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse query parameters from an IncomingMessage URL.
 * Returns an object of string values; repeated keys take the last value.
 */
function parseQuery(url: string | undefined): Record<string, string> {
  if (!url) return {};
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

/**
 * Read the log file and return its lines in reverse order (newest first).
 * Returns an empty array if the file does not exist.
 * Throws on unexpected read errors.
 */
function readLogLines(): string[] {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    // Split, remove trailing empty lines, reverse so newest is first.
    return raw.split('\n').filter((l) => l.trim().length > 0).reverse();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug({ logFile: LOG_FILE }, 'Log file does not exist yet — returning empty');
      return [];
    }
    throw err;
  }
}

/**
 * Attempt to parse a JSON line. Returns null on failure (corrupt/truncated lines).
 */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/logs
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/logs', async (req, res) => {
  const query = parseQuery(req.url);

  const levelFilter   = query['level']  ?? null;   // e.g. 'error', 'warn', 'info'
  const searchFilter  = query['search'] ?? null;   // substring match on msg
  const rawLimit      = parseInt(query['limit'] ?? String(DEFAULT_LIMIT), 10);
  const limit         = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  log.debug({ levelFilter, searchFilter, limit }, 'logs requested');

  let lines: string[];
  try {
    lines = readLogLines();
  } catch (err) {
    log.error({ err }, 'logs: failed to read log file');
    sendJson(res, 500, { error: { message: 'Failed to read log file', code: 500 } });
    return;
  }

  const entries: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (entries.length >= limit) break;

    const entry = parseLine(line);
    if (!entry) continue;

    // Level filter — pino uses numeric levels; map name to number.
    if (levelFilter) {
      const pinoLevels: Record<string, number> = {
        trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
      };
      const requiredNum = pinoLevels[levelFilter.toLowerCase()];
      if (requiredNum !== undefined) {
        const entryLevel = typeof entry['level'] === 'number' ? entry['level'] : -1;
        if (entryLevel !== requiredNum) continue;
      }
    }

    // Search filter — case-insensitive substring match on the msg field.
    if (searchFilter) {
      const msg = typeof entry['msg'] === 'string' ? entry['msg'] : '';
      if (!msg.toLowerCase().includes(searchFilter.toLowerCase())) continue;
    }

    entries.push(entry);
  }

  sendJson(res, 200, {
    entries,
    count: entries.length,
    total: lines.length,
    limit,
    levelFilter,
    searchFilter,
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/logs/download
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/logs/download', async (_req, res) => {
  log.info('logs/download requested');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(LOG_FILE);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      sendJson(res, 404, { error: { message: 'Log file not found', code: 404 } });
      return;
    }
    log.error({ err }, 'logs/download: stat failed');
    sendJson(res, 500, { error: { message: 'Cannot access log file', code: 500 } });
    return;
  }

  const filename = path.basename(LOG_FILE);

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });

  const stream = fs.createReadStream(LOG_FILE);

  stream.on('error', (err) => {
    log.error({ err }, 'logs/download: stream error after headers sent');
    // Headers already sent — cannot send JSON error; just destroy.
    res.destroy(err);
  });

  stream.pipe(res);

  log.debug({ filename, sizeBytes: stat.size }, 'logs/download: streaming log file');
});
