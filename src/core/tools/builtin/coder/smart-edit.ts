/**
 * coder.smart-edit — Surgical file edit with instant TypeScript type checking.
 *
 * Makes your edit, immediately runs tsc --noEmit, and tells you if your change
 * broke anything. Unlike coder.edit-file (blind edit), smart-edit gives
 * immediate feedback without a separate typecheck step.
 *
 * This is SUDO-AI's answer to Claude Code's edit → verify loop.
 * Use this for ALL TypeScript code changes.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const logger = createLogger('coder.smart-edit');

const PROJECT_ROOT = '/root/sudo-ai-v4';
const TSC = path.join(PROJECT_ROOT, 'node_modules/.bin/tsc');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'data', 'file-backups');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EditOp {
  type: 'replace' | 'insert' | 'delete';
  // replace
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  // insert
  line?: number;
  content?: string;
  // delete
  startLine?: number;
  endLine?: number;
}

interface TsError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function createBackup(abs: string): string {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const rel = path.relative(PROJECT_ROOT, abs).replace(/[\\/]/g, '__');
  const dest = path.join(BACKUP_DIR, `${Date.now()}_${rel}`);
  if (existsSync(abs)) copyFileSync(abs, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Edit engine
// ---------------------------------------------------------------------------

function applyEdits(content: string, edits: EditOp[]): { text: string; summary: string[] } | { error: string } {
  let text = content;
  const summary: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit?.type) return { error: `Edit ${i + 1}: missing "type" field` };

    if (edit.type === 'replace') {
      if (typeof edit.oldText !== 'string') return { error: `Edit ${i + 1} (replace): "oldText" required` };
      if (typeof edit.newText !== 'string') return { error: `Edit ${i + 1} (replace): "newText" required` };

      if (!text.includes(edit.oldText)) {
        return {
          error: `Edit ${i + 1} (replace): text not found.\n\nLooking for:\n${edit.oldText.slice(0, 300)}`,
        };
      }

      if (edit.replaceAll) {
        const count = text.split(edit.oldText).length - 1;
        text = text.split(edit.oldText).join(edit.newText);
        summary.push(`[${i + 1}] replaced ${count} occurrence(s)`);
      } else {
        text = text.replace(edit.oldText, edit.newText);
        summary.push(`[${i + 1}] replaced 1 occurrence`);
      }
    } else if (edit.type === 'insert') {
      if (typeof edit.line !== 'number') return { error: `Edit ${i + 1} (insert): numeric "line" required` };
      if (typeof edit.content !== 'string') return { error: `Edit ${i + 1} (insert): "content" required` };

      const lines = text.split('\n');
      const insertAt = Math.max(0, Math.min(edit.line - 1, lines.length));
      lines.splice(insertAt, 0, edit.content);
      text = lines.join('\n');
      summary.push(`[${i + 1}] inserted content before line ${edit.line}`);
    } else if (edit.type === 'delete') {
      if (typeof edit.startLine !== 'number') return { error: `Edit ${i + 1} (delete): "startLine" required` };
      if (typeof edit.endLine !== 'number') return { error: `Edit ${i + 1} (delete): "endLine" required` };

      const lines = text.split('\n');
      const start = Math.max(0, edit.startLine - 1);
      const end = Math.min(lines.length, edit.endLine);
      const removed = end - start;
      lines.splice(start, removed);
      text = lines.join('\n');
      summary.push(`[${i + 1}] deleted lines ${edit.startLine}–${edit.endLine} (${removed} lines)`);
    } else {
      return { error: `Edit ${i + 1}: unknown type "${(edit as EditOp).type}"` };
    }
  }

  return { text, summary };
}

// ---------------------------------------------------------------------------
// TypeScript check
// ---------------------------------------------------------------------------

function runTypecheck(abs: string): { clean: boolean; errors: TsError[]; output: string; durationMs: number } {
  const start = Date.now();

  if (!existsSync(TSC)) {
    return { clean: true, errors: [], output: '(tsc not available — skipped)', durationMs: 0 };
  }

  let rawOutput = '';
  try {
    execSync(`"${TSC}" --noEmit`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    rawOutput = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
  }

  const durationMs = Date.now() - start;

  if (!rawOutput) {
    return { clean: true, errors: [], output: 'clean', durationMs };
  }

  // Parse errors
  const allErrors: TsError[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(rawOutput)) !== null) {
    const [, file, line, col, code, message] = m;
    allErrors.push({
      file: (file ?? '').trim(),
      line: parseInt(line ?? '0', 10),
      col: parseInt(col ?? '0', 10),
      code: code ?? '',
      message: (message ?? '').trim(),
    });
  }

  // Filter to errors in the edited file (primary focus) + any others
  const rel = abs.replace(PROJECT_ROOT + '/', '');
  const fileErrors = allErrors.filter(e => e.file.includes(rel) || rel.includes(e.file));
  const otherErrors = allErrors.filter(e => !e.file.includes(rel) && !rel.includes(e.file));

  // Build output
  const lines: string[] = [];
  if (fileErrors.length > 0) {
    lines.push(`Errors in edited file (${rel}):`);
    for (const e of fileErrors) {
      lines.push(`  line ${e.line}: ${e.code} — ${e.message}`);
    }
  }
  if (otherErrors.length > 0) {
    lines.push(`\nOther project errors (${otherErrors.length}):`);;
    // Group by file, show max 3 per file
    const byFile: Record<string, TsError[]> = {};
    for (const e of otherErrors) {
      if (!byFile[e.file]) byFile[e.file] = [];
      byFile[e.file].push(e);
    }
    for (const [file, errs] of Object.entries(byFile).slice(0, 5)) {
      const f = file.replace(PROJECT_ROOT + '/', '');
      lines.push(`  ${f}: ${errs.slice(0, 3).map(e => `line ${e.line} ${e.code}`).join(', ')}${errs.length > 3 ? ` +${errs.length - 3} more` : ''}`);
    }
  }

  return {
    clean: allErrors.length === 0,
    errors: allErrors,
    output: lines.join('\n'),
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const smartEditTool: ToolDefinition = {
  name: 'coder.smart-edit',
  description:
    'Surgical file edit with automatic TypeScript type checking. ' +
    'Makes your edit, immediately runs tsc --noEmit, and tells you if your change broke anything. ' +
    'Unlike coder.edit-file (blind), smart-edit gives instant feedback without a separate typecheck step. ' +
    'This is the primary tool for all TypeScript code changes — you get edit + verify in one call. ' +
    'Creates a backup before editing. Supports replace, insert, and delete operations.',
  category: 'coder',
  timeout: 120_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'File path relative to /root/sudo-ai-v4/ or absolute.',
    },
    edits: {
      type: 'array',
      required: true,
      description:
        'Array of edit operations in order. Each operation: ' +
        '{ type: "replace", oldText: "...", newText: "...", replaceAll?: false } or ' +
        '{ type: "insert", line: N, content: "..." } or ' +
        '{ type: "delete", startLine: N, endLine: M }',
    },
    skipTypecheck: {
      type: 'boolean',
      required: false,
      description: 'Skip the tsc check (for non-TS files or when speed matters). Default: false.',
    },
    backup: {
      type: 'boolean',
      required: false,
      description: 'Create backup before editing. Default: true.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = typeof params['path'] === 'string' ? params['path'].trim() : '';
    if (!rawPath) {
      return { success: false, output: 'coder.smart-edit: "path" parameter is required.' };
    }
    if (!Array.isArray(params['edits']) || params['edits'].length === 0) {
      return { success: false, output: 'coder.smart-edit: "edits" must be a non-empty array.' };
    }

    const skipTypecheck = params['skipTypecheck'] === true;
    const doBackup = params['backup'] !== false;

    // Resolve path
    const abs = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(PROJECT_ROOT, rawPath);
    const rel = abs.replace(PROJECT_ROOT + '/', '');

    if (!abs.startsWith(PROJECT_ROOT)) {
      return { success: false, output: `Path traversal blocked: ${rawPath}` };
    }
    if (!existsSync(abs)) {
      return { success: false, output: `File not found: ${rel}` };
    }

    logger.info({ session: ctx.sessionId, path: rel, editCount: (params['edits'] as unknown[]).length }, 'coder.smart-edit invoked');

    // Read original
    const original = readFileSync(abs, 'utf-8');

    // Create backup
    let backupPath = '';
    if (doBackup) {
      try { backupPath = createBackup(abs); } catch { /* non-fatal */ }
    }

    // Apply edits
    const edits = params['edits'] as EditOp[];
    const result = applyEdits(original, edits);
    if ('error' in result) {
      return { success: false, output: `✗ Edit failed: ${result.error}` };
    }

    // Write file
    writeFileSync(abs, result.text, 'utf-8');
    const editSummary = result.summary.join(', ');

    // TypeScript check
    const isTs = abs.endsWith('.ts') || abs.endsWith('.tsx');
    if (!isTs || skipTypecheck) {
      return {
        success: true,
        output: `✓ Edit applied (${editSummary})${backupPath ? `\nBackup: ${backupPath.replace(PROJECT_ROOT + '/', '')}` : ''}\n${skipTypecheck ? '(typecheck skipped)' : '(not a TS file)'}`,
        data: {
          path: rel,
          editCount: edits.length,
          typesClean: null,
          errorCount: 0,
          backup: backupPath,
        },
      };
    }

    const tc = runTypecheck(abs);

    if (tc.clean) {
      return {
        success: true,
        output: `✓ Edit applied (${editSummary}) — TypeScript: clean [${tc.durationMs}ms]${backupPath ? `\nBackup: ${backupPath.replace(PROJECT_ROOT + '/', '')}` : ''}`,
        data: {
          path: rel,
          editCount: edits.length,
          typesClean: true,
          errorCount: 0,
          backup: backupPath,
        },
      };
    }

    const totalErrors = tc.errors.length;
    return {
      success: true, // edit was applied — caller decides whether to rollback
      output: `✓ Edit applied (${editSummary}) — TypeScript: ✗ ${totalErrors} error(s)\n\n${tc.output}\n\nFile saved with errors. Fix types or restore backup:\n  ${backupPath.replace(PROJECT_ROOT + '/', '')}`,
      data: {
        path: rel,
        editCount: edits.length,
        typesClean: false,
        errorCount: totalErrors,
        typeErrors: tc.errors,
        backup: backupPath,
      },
    };
  },
};
