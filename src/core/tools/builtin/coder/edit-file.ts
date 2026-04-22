/**
 * coder.edit-file — Surgical text edits on an existing file.
 * Supports replace (with exact-match guard), line-insert, and line-delete ops.
 * Applies all edits in order, returns a diff summary.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Edit operation types
// ---------------------------------------------------------------------------

interface ReplaceEdit {
  type: 'replace';
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

interface InsertEdit {
  type: 'insert';
  line: number; // 1-based; content inserted BEFORE this line
  content: string;
}

interface DeleteEdit {
  type: 'delete';
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
}

type Edit = ReplaceEdit | InsertEdit | DeleteEdit;

function applyReplace(text: string, edit: ReplaceEdit): { text: string; count: number } {
  if (edit.replaceAll) {
    let count = 0;
    const result = text.split(edit.oldText).join(edit.newText);
    // The above doesn't work with a function — use proper replacement.
    const escaped = edit.oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const matches = text.match(re);
    count = matches ? matches.length : 0;
    return { text: text.replace(re, edit.newText), count };
  }

  // Exact-once replacement — verify uniqueness first.
  const escaped = edit.oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'g');
  const matches = text.match(re);
  const occurrences = matches ? matches.length : 0;

  if (occurrences === 0) {
    throw new Error(`Replace failed: oldText not found in file.\noldText: ${edit.oldText.slice(0, 120)}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `Replace failed: oldText found ${occurrences} times (must be unique). ` +
      `Use replaceAll:true to replace all occurrences.\noldText: ${edit.oldText.slice(0, 120)}`,
    );
  }

  return { text: text.replace(edit.oldText, edit.newText), count: 1 };
}

function applyInsert(lines: string[], edit: InsertEdit): string[] {
  const idx = Math.max(0, Math.min(edit.line - 1, lines.length));
  const newLines = [...lines];
  newLines.splice(idx, 0, edit.content);
  return newLines;
}

function applyDelete(lines: string[], edit: DeleteEdit): { lines: string[]; deleted: number } {
  const start = Math.max(0, edit.startLine - 1);
  const end = Math.min(lines.length, edit.endLine);
  const deleted = end - start;
  const newLines = [...lines];
  newLines.splice(start, deleted);
  return { lines: newLines, deleted };
}

export const editFileTool: ToolDefinition = {
  name: 'coder.edit-file',
  description:
    'Perform surgical edits on a file. Supports replace (exact text match), ' +
    'insert (before a line number), and delete (line range) operations. ' +
    'All edits are applied in sequence. Returns a summary of changes made.',
  category: 'coder',
  timeout: 15_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'Absolute or working-dir-relative path to the file to edit.',
    },
    edits: {
      type: 'array',
      required: true,
      description:
        'Ordered list of edit operations. Each is an object with type="replace"|"insert"|"delete" ' +
        'plus operation-specific fields.',
      items: {
        type: 'object',
        description: 'A single edit operation.',
        properties: {
          type: { type: 'string', description: 'replace | insert | delete', enum: ['replace', 'insert', 'delete'] },
          oldText: { type: 'string', description: '(replace) Exact text to find.' },
          newText: { type: 'string', description: '(replace) Replacement text.' },
          replaceAll: { type: 'boolean', description: '(replace) Replace all occurrences instead of requiring uniqueness.' },
          line: { type: 'number', description: '(insert) 1-based line number to insert before.' },
          content: { type: 'string', description: '(insert) Text to insert.' },
          startLine: { type: 'number', description: '(delete) First line of range (1-based, inclusive).' },
          endLine: { type: 'number', description: '(delete) Last line of range (1-based, inclusive).' },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const rawPath = params['path'];
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return { success: false, output: 'coder.edit-file: "path" parameter is required.' };
    }
    if (!Array.isArray(params['edits']) || params['edits'].length === 0) {
      return { success: false, output: 'coder.edit-file: "edits" must be a non-empty array.' };
    }

    const filePath = resolve(ctx.workingDir, rawPath);
    if (!filePath.startsWith(ctx.workingDir)) {
      return { success: false, output: `Path traversal blocked: ${rawPath} resolves outside working directory` };
    }
    const edits = params['edits'] as Edit[];
    const summary: string[] = [];

    try {
      let text = await readFile(filePath, 'utf-8');

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit || !edit.type) {
          return { success: false, output: `coder.edit-file: edit[${i}] missing "type" field.` };
        }

        if (edit.type === 'replace') {
          if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
            return { success: false, output: `coder.edit-file: edit[${i}] replace requires oldText and newText strings.` };
          }
          const { text: newText, count } = applyReplace(text, edit);
          text = newText;
          summary.push(`[${i + 1}] replace: ${count} occurrence(s) replaced`);
        } else if (edit.type === 'insert') {
          if (typeof edit.line !== 'number') {
            return { success: false, output: `coder.edit-file: edit[${i}] insert requires numeric "line".` };
          }
          if (typeof edit.content !== 'string') {
            return { success: false, output: `coder.edit-file: edit[${i}] insert requires "content" string.` };
          }
          const lines = applyInsert(text.split('\n'), edit);
          text = lines.join('\n');
          summary.push(`[${i + 1}] insert: line added before line ${edit.line}`);
        } else if (edit.type === 'delete') {
          if (typeof edit.startLine !== 'number' || typeof edit.endLine !== 'number') {
            return { success: false, output: `coder.edit-file: edit[${i}] delete requires startLine and endLine numbers.` };
          }
          const { lines, deleted } = applyDelete(text.split('\n'), edit);
          text = lines.join('\n');
          summary.push(`[${i + 1}] delete: ${deleted} line(s) removed (${edit.startLine}–${edit.endLine})`);
        } else {
          return { success: false, output: `coder.edit-file: edit[${i}] unknown type "${(edit as Edit).type}".` };
        }
      }

      await writeFile(filePath, text, 'utf-8');
      const bytesWritten = Buffer.byteLength(text, 'utf-8');
      log.info({ tool: 'coder.edit-file', path: filePath, edits: edits.length }, 'File edited');

      return {
        success: true,
        output: `Applied ${edits.length} edit(s) to ${filePath}\n` + summary.join('\n'),
        data: { path: filePath, editsApplied: edits.length, summary },
        artifacts: [{ path: filePath, action: 'modified', size: bytesWritten }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: 'coder.edit-file', path: filePath, err }, 'Edit failed');
      return { success: false, output: `coder.edit-file error: ${msg}` };
    }
  },
};

export default editFileTool;
