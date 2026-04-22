/**
 * coder.apply-patch — Apply freeform find-and-replace patches to files.
 *
 * Based on Codex's apply_patch_tool_type: "freeform" and Claude Code's
 * Edit tool. Each patch operation locates an exact text string in a file
 * and replaces it with new content.
 *
 * Differences from coder.edit-file:
 *   - Accepts multiple files per call via an array of patch operations.
 *   - Each operation is a simple {file, search, replace} triple.
 *   - Returns a per-file result string rather than structured edit metadata.
 *   - Does NOT require uniqueness (replaces only the first occurrence).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PatchOperation {
  /** Absolute or working-dir-relative path to the file to patch. */
  file: string;
  /** Exact text to locate in the file. Must be unique for predictable results. */
  search: string;
  /** Replacement text. May be empty to perform a deletion. */
  replace: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a single patch operation to a file on disk.
 * Returns a human-readable status string.
 */
async function applyOnePatch(
  op: PatchOperation,
  workingDir: string,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<string> {
  const filePath = resolve(workingDir, op.file);

  // Path traversal guard.
  if (!filePath.startsWith(workingDir)) {
    log.warn({ file: op.file, resolved: filePath }, 'apply-patch: path traversal blocked');
    return `BLOCKED ${op.file}: path resolves outside working directory`;
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ file: filePath, err }, 'apply-patch: read failed');
    return `ERROR ${op.file}: ${msg}`;
  }

  if (!content.includes(op.search)) {
    log.warn({ file: filePath, searchLength: op.search.length }, 'apply-patch: search text not found');
    return `SKIP ${op.file}: search text not found`;
  }

  // Replace only the first occurrence (consistent with Claude Code's Edit tool).
  const updated = content.replace(op.search, op.replace);

  try {
    await writeFile(filePath, updated, 'utf-8');
    const bytesWritten = Buffer.byteLength(updated, 'utf-8');
    log.info({ file: filePath, searchLen: op.search.length, replaceLen: op.replace.length, bytesWritten }, 'apply-patch: patch applied');
    return `OK ${op.file}: replaced ${op.search.length} chars → ${op.replace.length} chars`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ file: filePath, err }, 'apply-patch: write failed');
    return `ERROR ${op.file}: write failed — ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const applyPatchTool: ToolDefinition = {
  name: 'coder.apply-patch',
  description:
    'Apply freeform find-and-replace patches to one or more files. ' +
    'Each operation specifies a file path, the exact text to search for, ' +
    'and the replacement text. Replaces the first occurrence only. ' +
    'Returns a per-file status line: OK | SKIP | ERROR | BLOCKED.',
  category: 'coder',
  requiresConfirmation: false,
  timeout: 30_000,
  parameters: {
    operations: {
      type: 'array',
      required: true,
      description:
        'Array of patch operations. Each must have: file (path), search (exact text to find), replace (replacement text).',
      items: {
        type: 'object',
        description: 'A single patch operation.',
        properties: {
          file: {
            type: 'string',
            description: 'Absolute or working-dir-relative path to the file to patch.',
          },
          search: {
            type: 'string',
            description: 'Exact text string to search for in the file.',
          },
          replace: {
            type: 'string',
            description: 'Replacement text. Pass an empty string to delete the matched text.',
          },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as {
      info: (...a: unknown[]) => void;
      warn: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };

    // Validate input.
    if (!Array.isArray(params['operations']) || params['operations'].length === 0) {
      return {
        success: false,
        output: 'coder.apply-patch: "operations" must be a non-empty array.',
      };
    }

    const ops = params['operations'] as PatchOperation[];

    // Validate each operation shape.
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op !== 'object') {
        return { success: false, output: `coder.apply-patch: operations[${i}] is not an object.` };
      }
      if (typeof op.file !== 'string' || op.file.trim() === '') {
        return { success: false, output: `coder.apply-patch: operations[${i}].file is required.` };
      }
      if (typeof op.search !== 'string') {
        return { success: false, output: `coder.apply-patch: operations[${i}].search must be a string.` };
      }
      if (typeof op.replace !== 'string') {
        return { success: false, output: `coder.apply-patch: operations[${i}].replace must be a string.` };
      }
      if (op.search.length === 0) {
        return { success: false, output: `coder.apply-patch: operations[${i}].search must not be empty.` };
      }
    }

    // Apply all patches and collect results.
    const results: string[] = [];
    for (const op of ops) {
      const result = await applyOnePatch(op, ctx.workingDir, log);
      results.push(result);
    }

    const okCount = results.filter((r) => r.startsWith('OK')).length;
    const skipCount = results.filter((r) => r.startsWith('SKIP')).length;
    const errorCount = results.filter((r) => r.startsWith('ERROR') || r.startsWith('BLOCKED')).length;

    const summary =
      `Patch complete: ${okCount} applied, ${skipCount} skipped, ${errorCount} failed\n` +
      results.join('\n');

    return {
      success: errorCount === 0,
      output: summary,
      data: { okCount, skipCount, errorCount, results },
    };
  },
};

export default applyPatchTool;
