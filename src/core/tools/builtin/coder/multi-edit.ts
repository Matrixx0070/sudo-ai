/**
 * coder.multi-edit — Apply multiple exact-string edits across one or more files
 * in a single tool call.
 *
 * Each operation locates an exact old_string in the target file and replaces it
 * with new_string. Only the first occurrence is replaced per operation (consistent
 * with the Claude Code Edit tool contract). The tool emits a per-file status line:
 *   OK     — replacement applied successfully.
 *   SKIP   — old_string not found in the file (no change made).
 *   WARN   — old_string found more than once; first occurrence replaced.
 *   ERROR  — I/O failure or path blocked.
 *   BLOCKED — path resolves outside the working directory.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EditOperation {
  /** Absolute or working-dir-relative path to the file to edit. */
  file: string;
  /** Exact text to locate in the file. */
  old_string: string;
  /** Replacement text. May be empty to perform a deletion. */
  new_string: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Log = {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
};

async function applyOneEdit(
  op: EditOperation,
  workingDir: string,
  log: Log,
): Promise<string> {
  const filePath = resolve(workingDir, op.file);

  // Path-traversal guard.
  if (!filePath.startsWith(workingDir)) {
    log.warn({ file: op.file, resolved: filePath }, 'multi-edit: path traversal blocked');
    return `BLOCKED ${op.file}: path resolves outside working directory`;
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ file: filePath, err }, 'multi-edit: read failed');
    return `ERROR ${op.file}: ${msg}`;
  }

  if (!content.includes(op.old_string)) {
    log.warn({ file: filePath, oldLen: op.old_string.length }, 'multi-edit: old_string not found');
    return `SKIP ${op.file}: old_string not found`;
  }

  const occurrences = content.split(op.old_string).length - 1;
  const prefix = occurrences > 1
    ? `WARN ${op.file}: old_string found ${occurrences} times, replacing first occurrence\n`
    : '';

  // Replace only the first occurrence.
  const updated = content.replace(op.old_string, op.new_string);

  try {
    await writeFile(filePath, updated, 'utf-8');
    const bytesWritten = Buffer.byteLength(updated, 'utf-8');
    log.info(
      { file: filePath, oldLen: op.old_string.length, newLen: op.new_string.length, bytesWritten },
      'multi-edit: edit applied',
    );
    return `${prefix}OK ${op.file}: edited`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ file: filePath, err }, 'multi-edit: write failed');
    return `ERROR ${op.file}: write failed — ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const multiEditTool: ToolDefinition = {
  name: 'coder.multi-edit',
  description:
    'Apply multiple exact-string find-and-replace edits across one or more files in a ' +
    'single call. Each operation specifies a file path, the exact old_string to locate, ' +
    'and the new_string replacement. Replaces the first occurrence only (warns when ' +
    'multiple occurrences exist). Returns a per-file status line: OK | SKIP | WARN | ' +
    'ERROR | BLOCKED. Use this instead of repeated coder.edit-file calls.',
  category: 'coder',
  requiresConfirmation: false,
  timeout: 60_000,
  parameters: {
    edits: {
      type: 'array',
      required: true,
      description:
        'Array of edit operations. Each must have: file (path), old_string (exact text ' +
        'to find), new_string (replacement text — may be empty to delete).',
      items: {
        type: 'object',
        description: 'A single edit operation.',
        properties: {
          file: {
            type: 'string',
            description: 'Absolute or working-dir-relative path to the file.',
          },
          old_string: {
            type: 'string',
            description: 'Exact text to search for in the file. Must not be empty.',
          },
          new_string: {
            type: 'string',
            description: 'Replacement text. Pass an empty string to delete the matched text.',
          },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as Log;

    // Validate top-level input.
    if (!Array.isArray(params['edits']) || params['edits'].length === 0) {
      return {
        success: false,
        output: 'coder.multi-edit: "edits" must be a non-empty array.',
      };
    }

    const edits = params['edits'] as EditOperation[];

    // Validate each operation shape.
    for (let i = 0; i < edits.length; i++) {
      const op = edits[i];
      if (!op || typeof op !== 'object') {
        return { success: false, output: `coder.multi-edit: edits[${i}] is not an object.` };
      }
      if (typeof op.file !== 'string' || op.file.trim() === '') {
        return { success: false, output: `coder.multi-edit: edits[${i}].file is required.` };
      }
      if (typeof op.old_string !== 'string' || op.old_string.length === 0) {
        return { success: false, output: `coder.multi-edit: edits[${i}].old_string must be a non-empty string.` };
      }
      if (typeof op.new_string !== 'string') {
        return { success: false, output: `coder.multi-edit: edits[${i}].new_string must be a string.` };
      }
    }

    // Apply all edits sequentially (preserve order — later edits may depend on earlier ones).
    const results: string[] = [];
    for (const op of edits) {
      const result = await applyOneEdit(op, ctx.workingDir, log);
      results.push(result);
    }

    const okCount = results.filter((r) => r.startsWith('OK') || r.includes('\nOK')).length;
    const skipCount = results.filter((r) => r.startsWith('SKIP')).length;
    const errorCount = results.filter((r) => r.startsWith('ERROR') || r.startsWith('BLOCKED')).length;

    const summary =
      `Multi-edit complete: ${okCount} applied, ${skipCount} skipped, ${errorCount} failed\n` +
      results.join('\n');

    log.info(
      { total: edits.length, okCount, skipCount, errorCount },
      'coder.multi-edit: finished',
    );

    return {
      success: errorCount === 0,
      output: summary,
      data: { okCount, skipCount, errorCount, results },
    };
  },
};

export default multiEditTool;
