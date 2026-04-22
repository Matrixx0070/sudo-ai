/**
 * meta.memory.get — Read a specific memory entry or workspace file by key.
 *
 * Supported key formats:
 *   - 'MEMORY.md'         → reads <workingDir>/MEMORY.md
 *   - 'today'             → reads today's daily note (YYYY-MM-DD.md)
 *   - 'yesterday'         → reads yesterday's daily note
 *   - 'YYYY-MM-DD'        → reads that specific date's daily note
 *   - any other string    → treated as a relative path under workingDir
 *
 * File reads are scoped to the session's workingDir to prevent path traversal.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const logger = createLogger('meta.memory.get');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the key to a safe absolute file path within workingDir.
 * Throws if the resolved path escapes the working directory.
 */
function resolveKey(key: string, workingDir: string): string {
  let relativePath: string;

  if (key === 'MEMORY.md') {
    relativePath = 'MEMORY.md';
  } else if (key === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    relativePath = path.join('notes', `${today}.md`);
  } else if (key === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = d.toISOString().slice(0, 10);
    relativePath = path.join('notes', `${yesterday}.md`);
  } else if (DATE_RE.test(key)) {
    relativePath = path.join('notes', `${key}.md`);
  } else {
    // Treat as a relative path — sanitise by normalising
    relativePath = key;
  }

  const resolved = path.resolve(workingDir, relativePath);

  // Guard against path traversal
  if (!resolved.startsWith(path.resolve(workingDir) + path.sep)) {
    throw new Error(`Path traversal detected: "${key}" resolves outside workingDir`);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const memoryGetTool: ToolDefinition = {
  name: 'memory.get',
  description:
    'Read a specific workspace memory file by key. ' +
    'Supported keys: "MEMORY.md" (main memory file), "today" (today\'s daily note), ' +
    '"yesterday" (yesterday\'s daily note), a date string "YYYY-MM-DD", ' +
    'or any relative path within the working directory.',
  category: 'meta',
  timeout: 10_000,
  parameters: {
    key: {
      type: 'string',
      required: true,
      description:
        'Memory key to read. Examples: "MEMORY.md", "today", "yesterday", "2025-01-15", "notes/ideas.md".',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const key = params['key'] as string | undefined;

    logger.info({ session: ctx.sessionId, key }, 'memory.get invoked');

    if (!key?.trim()) {
      return { success: false, output: 'memory.get: "key" parameter is required and must be non-empty.' };
    }

    let filePath: string;
    try {
      filePath = resolveKey(key.trim(), ctx.workingDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `memory.get: invalid key — ${msg}` };
    }

    try {
      const content = await readFile(filePath, 'utf8');
      const relativePath = path.relative(ctx.workingDir, filePath);

      logger.info({ session: ctx.sessionId, filePath, bytes: content.length }, 'memory.get read success');

      return {
        success: true,
        output: `Contents of "${relativePath}" (${content.length} bytes):\n\n${content}`,
        data: { key, filePath, bytes: content.length },
        artifacts: [{ path: filePath, action: 'read', size: Buffer.byteLength(content, 'utf8') }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNotFound = msg.includes('ENOENT') || msg.includes('no such file');

      logger.warn({ session: ctx.sessionId, filePath, err: msg }, 'memory.get file read failed');

      if (isNotFound) {
        return {
          success: false,
          output: `memory.get: file not found for key "${key}" (looked at: ${path.relative(ctx.workingDir, filePath)})`,
        };
      }

      return { success: false, output: `memory.get error: ${msg}` };
    }
  },
};
