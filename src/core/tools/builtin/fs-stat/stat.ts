/**
 * fs.stat — Retrieve file/directory metadata for a given absolute path.
 * Returns mode, size, mtime, type flags, and world-readable status.
 */

import { stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const logger = createLogger('fs.stat');

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const fsStatTool: ToolDefinition = {
  name: 'fs.stat',
  description:
    'Retrieve metadata (size, mode, mtime, type) for a file or directory at an absolute path.',
  category: 'system',
  safety: 'readonly',
  timeout: 5_000,
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute path to the file or directory to inspect.',
      required: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const input = params['path'];

      // --- Input validation ---
      if (typeof input !== 'string' || input.trim() === '') {
        return {
          success: false,
          output: 'fs.stat: path is required',
          data: { error: 'missing_path' },
        };
      }

      if (input.includes('\0')) {
        return {
          success: false,
          output: 'fs.stat: path contains null byte',
          data: { error: 'null_byte' },
        };
      }

      if (!nodePath.isAbsolute(input)) {
        return {
          success: false,
          output: `fs.stat: path must be absolute (got: ${input})`,
          data: { error: 'relative_path' },
        };
      }

      const resolved = nodePath.resolve(input);
      logger.info({ resolved, session: ctx.sessionId }, 'fs.stat');

      // --- Stat the path ---
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(resolved);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return {
            success: true,
            output: `Path does not exist: ${resolved}`,
            data: { exists: false },
          };
        }
        if (code === 'EACCES') {
          return {
            success: false,
            output: `Permission denied: ${resolved}`,
            data: { error: 'eacces' },
          };
        }
        // Propagate unexpected errors to outer catch
        throw err;
      }

      // --- Build result ---
      const worldReadable = (st.mode & 0o004) !== 0;
      const mtime = st.mtime.toISOString();
      const octal = (st.mode & 0o7777).toString(8).padStart(4, '0');

      const data = {
        exists: true,
        mode: st.mode,
        mtime,
        size: st.size,
        isFile: st.isFile(),
        isDir: st.isDirectory(),
        worldReadable,
      };

      return {
        success: true,
        output: `${resolved}: ${st.size} bytes, mode ${octal}, mtime ${mtime}`,
        data,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, session: ctx.sessionId }, 'fs.stat unexpected error');
      return {
        success: false,
        output: `fs.stat error: ${message}`,
        data: { error: 'unexpected' },
      };
    }
  },
};
