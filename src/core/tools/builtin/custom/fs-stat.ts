import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const logger = createLogger('fs.stat');

export const fs_statTool: ToolDefinition = {
  name: 'fs.stat',
  description: 'Retrieve metadata (size, mode, mtime, type) for a file or directory at an absolute path.',
  category: 'custom' as const,
  timeout: 30_000,
  parameters: {
    /** Absolute path to the file or directory to inspect. Must begin with '/'. */
    path: {
      type: 'string',
      description: 'Absolute path to the file or directory (must start with /).',
      required: true,
    },
    /** When true, follows symlinks and stats the target; when false, stats the symlink itself. Defaults to true. */
    followSymlinks: {
      type: 'boolean',
      description: 'Follow symlinks to stat the target (true) or stat the symlink itself (false). Defaults to true.',
      required: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    logger.info({ session: ctx.sessionId }, 'fs.stat invoked');

    try {
      // --- Input validation ---
      const rawPath = params['path'];
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return { success: false, output: 'Error: "path" must be a non-empty string.' };
      }
      const targetPath = rawPath.trim();
      if (!isAbsolute(targetPath)) {
        return { success: false, output: `Error: "path" must be an absolute path. Received: "${targetPath}"` };
      }

      const followSymlinks =
        params['followSymlinks'] === undefined ? true : Boolean(params['followSymlinks']);

      // --- Stat call ---
      const stats = followSymlinks
        ? await stat(targetPath)
        : await import('node:fs/promises').then((m) => m.lstat(targetPath));

      // --- Derive human-readable type ---
      let type: string;
      if (stats.isFile()) {
        type = 'file';
      } else if (stats.isDirectory()) {
        type = 'directory';
      } else if (stats.isSymbolicLink()) {
        type = 'symlink';
      } else if (stats.isBlockDevice()) {
        type = 'blockDevice';
      } else if (stats.isCharacterDevice()) {
        type = 'characterDevice';
      } else if (stats.isFIFO()) {
        type = 'fifo';
      } else if (stats.isSocket()) {
        type = 'socket';
      } else {
        type = 'unknown';
      }

      const result = {
        path: targetPath,
        type,
        size: stats.size,
        mode: `0${(stats.mode & 0o777).toString(8)}`,
        mtime: stats.mtime.toISOString(),
        atime: stats.atime.toISOString(),
        ctime: stats.ctime.toISOString(),
        birthtime: stats.birthtime.toISOString(),
        uid: stats.uid,
        gid: stats.gid,
        nlink: stats.nlink,
        ino: stats.ino,
        dev: stats.dev,
        followedSymlinks: followSymlinks,
      };

      logger.info({ session: ctx.sessionId, path: targetPath, type, size: stats.size }, 'fs.stat success');

      return {
        success: true,
        output: JSON.stringify(result, null, 2),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        return { success: false, output: `Error: Path not found: ${params['path']}` };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { success: false, output: `Error: Permission denied accessing: ${params['path']}` };
      }
      if (code === 'ENOTDIR') {
        return { success: false, output: `Error: A component of the path is not a directory: ${params['path']}` };
      }

      logger.error({ err: msg, code }, 'fs.stat error');
      return { success: false, output: `Error: ${msg}` };
    }
  },
};