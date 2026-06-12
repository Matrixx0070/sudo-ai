/**
 * fs.list-by-mtime — List files in a directory sorted by modification time (newest first).
 * Supports mtime filtering (olderThan/newerThan), glob patterns, and result limiting.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isAbsolute, resolve } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const logger = createLogger('fs.list-by-mtime');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validatePath(input: unknown): { error: string } | { resolved: string } {
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: 'fs.list-by-mtime: path is required' };
  }
  if (input.includes('\0')) {
    return { error: 'fs.list-by-mtime: path contains null byte' };
  }
  if (!isAbsolute(input)) {
    return { error: `fs.list-by-mtime: path must be absolute (got: ${input})` };
  }
  return { resolved: resolve(input) };
}

function parseDate(val: unknown, fieldName: string): { error: string } | { date: Date } | null {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string' || val.trim() === '') {
    return { error: `fs.list-by-mtime: invalid ${fieldName}: must be an ISO string` };
  }
  const d = new Date(val);
  if (isNaN(d.getTime())) {
    return { error: `fs.list-by-mtime: invalid ${fieldName}: "${val}" is not a valid ISO date` };
  }
  return { date: d };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const fsListByMtimeTool: ToolDefinition = {
  name: 'fs.list-by-mtime',
  description: 'List files in a directory sorted by modification time, newest first. Supports mtime range filters, glob patterns, and result limit.',
  category: 'system',
  safety: 'readonly',
  requiresConfirmation: false,
  timeout: 15_000,
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute path to the directory to list.',
      required: true,
    },
    olderThan: {
      type: 'string',
      description: 'ISO date string — only include files modified before this time.',
      required: false,
    },
    newerThan: {
      type: 'string',
      description: 'ISO date string — only include files modified after this time.',
      required: false,
    },
    glob: {
      type: 'string',
      description: 'Glob pattern to filter filenames (e.g. "*.ts"). Applied via node:fs/promises glob when available.',
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results to return (1–1000, default 100).',
      required: false,
      default: 100,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // --- Path validation ---
      const pathResult = validatePath(params['path']);
      if ('error' in pathResult) {
        return { success: false, output: pathResult.error, data: { error: pathResult.error } };
      }
      const { resolved } = pathResult;
      logger.info({ resolved, session: ctx.sessionId }, 'fs.list-by-mtime');

      // --- Date filter validation ---
      const olderThanResult = parseDate(params['olderThan'], 'olderThan');
      if (olderThanResult && 'error' in olderThanResult) {
        return { success: false, output: olderThanResult.error, data: { error: olderThanResult.error } };
      }
      const newerThanResult = parseDate(params['newerThan'], 'newerThan');
      if (newerThanResult && 'error' in newerThanResult) {
        return { success: false, output: newerThanResult.error, data: { error: newerThanResult.error } };
      }
      const olderThan: Date | null = olderThanResult ? (olderThanResult as { date: Date }).date : null;
      const newerThan: Date | null = newerThanResult ? (newerThanResult as { date: Date }).date : null;

      // --- Limit clamping ---
      const rawLimit = params['limit'];
      const limit = Math.min(Math.max(typeof rawLimit === 'number' ? rawLimit : 100, 1), 1000);

      // --- Glob param ---
      const globParam = typeof params['glob'] === 'string' && params['glob'].trim() !== ''
        ? params['glob'].trim()
        : null;

      // --- Enumerate names ---
      let names: string[];
      if (globParam !== null) {
        try {
          // Dynamic import to handle @types/node gap (R4 gotcha): fs.glob exists
          // at runtime on Node >= 22 but may be absent from the installed types.
          const fsPromises = (await import('node:fs/promises')) as typeof import('node:fs/promises') & {
            glob?: (pattern: string, opts: { cwd: string }) => AsyncIterable<string>;
          };
          if (typeof fsPromises.glob === 'function') {
            // Collect async iterable manually (Array.fromAsync not in all TS lib targets)
            const collected: string[] = [];
            for await (const entry of fsPromises.glob(globParam, { cwd: resolved })) {
              collected.push(entry);
            }
            names = collected;
          } else {
            throw new Error('glob not available');
          }
        } catch {
          logger.warn({ resolved, globParam }, 'fs/promises.glob unavailable, falling back to readdir');
          names = await readdir(resolved);
        }
      } else {
        names = await readdir(resolved);
      }

      // --- Per-entry stat + mtime filter ---
      interface FileEntry {
        name: string;
        mtime: Date;
        size: number;
      }

      const entries: FileEntry[] = [];
      for (const name of names) {
        // Per-entry stat with silent skip on any error (broken symlinks, race conditions, etc.)
        try {
          const st = await stat(join(resolved, name));
          if (!st.isFile()) continue;
          const mtime = st.mtime;
          if (olderThan !== null && mtime >= olderThan) continue;
          if (newerThan !== null && mtime <= newerThan) continue;
          entries.push({ name, mtime, size: st.size });
        } catch {
          // silently skip
        }
      }

      // --- Sort newest first ---
      entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // --- Truncation (check before slice) ---
      const truncated = entries.length > limit;
      const sliced = entries.slice(0, limit);

      const files = sliced.map((e) => ({
        name: e.name,
        mtime: e.mtime.toISOString(),
        size: e.size,
      }));

      const count = files.length;
      return {
        success: true,
        output: `${count} file(s) in ${resolved}, truncated=${truncated}`,
        data: { files, count, truncated },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, session: ctx.sessionId }, 'fs.list-by-mtime failed');
      return { success: false, output: `fs.list-by-mtime error: ${msg}`, data: { error: msg } };
    }
  },
};
