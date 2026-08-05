/**
 * @file fields.ts
 * @description docx.replace_field + docx.delete_sections + docx.comment — three
 * more edit primitives from grok's docx skill, wrapping vendored scripts that
 * operate on an unpacked OOXML dir. All run the unpack→edit→pack round trip via
 * unpackRun (shared with edit.ts). Paths confined to /tmp or data/docx.
 *
 * - replace_field: fill Word merge fields / content controls (SDT) / bookmarks —
 *   the structured placeholders many templates use instead of plain text.
 * - delete_sections: drop document sections by index (list first for indices).
 * - comment: create a review comment and RETURN the anchor-marker XML the caller
 *   must insert (via docx.patch or a direct edit) to attach it to a range.
 */

import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { unpackRun, validateInput, resolveOutput } from './edit.js';

const logger = createLogger('docx:fields');

function errMsg(err: unknown): string {
  // These scripts report the actionable reason (e.g. "No matching fields found")
  // on STDOUT before exiting nonzero, so surface stdout ahead of the bare
  // "Command failed" message.
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const detail = e.stderr?.trim() || e.stdout?.trim() || e.message || String(err);
  return detail.slice(0, 800);
}

// ---------------------------------------------------------------------------
// docx.replace_field
// ---------------------------------------------------------------------------

export const docxReplaceFieldTool: ToolDefinition = {
  name: 'docx.replace_field',
  description:
    'Fill Word STRUCTURED placeholders — merge fields, content controls (SDT), and bookmarks — ' +
    'which templates use instead of plain text (docx.replace_text only touches plain runs). Set ' +
    '`list` to enumerate every field first. Then replace one with `field`+`text` (merge field by ' +
    'name), `sdt`+`text` (content control by tag/alias), or many via `map` ({name: value}). Writes ' +
    'to `outputPath` or overwrites the input. Paths under /tmp/ or data/docx/.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .docx/.dotx.' },
    list: { type: 'boolean', required: false, description: 'List all fields/content-controls/bookmarks (read-only).' },
    field: { type: 'string', required: false, description: 'Merge-field name to replace (pair with `text`).' },
    sdt: { type: 'string', required: false, description: 'Content-control tag/alias to replace (pair with `text`).' },
    text: { type: 'string', required: false, description: 'Replacement value for `field` or `sdt`.' },
    map: { type: 'object', required: false, description: 'Object of {fieldName: value} for many replacements.' },
    dryRun: { type: 'boolean', required: false, description: 'Preview replacements without writing.' },
    outputPath: { type: 'string', required: false, description: 'Where to write (.docx). Omit to overwrite input.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = await validateInput(inputPath);
    if (invalid) return { success: false, output: `docx.replace_field error: ${invalid}` };

    const listMode = args['list'] === true;
    const hasField = typeof args['field'] === 'string' && args['field'] !== '';
    const hasSdt = typeof args['sdt'] === 'string' && args['sdt'] !== '';
    const hasMap = args['map'] && typeof args['map'] === 'object';
    if (!listMode && !hasField && !hasSdt && !hasMap) {
      return { success: false, output: 'docx.replace_field error: set `list`, or provide `field`/`sdt` (+`text`) or `map`' };
    }

    let mapFile: string | undefined;
    try {
      if (listMode) {
        const r = await unpackRun(inputPath, 'replace_field.py', ['--list'], null);
        return { success: true, output: r.output || '(no fields found)', data: { inputPath, list: true } };
      }
      const dryRun = args['dryRun'] === true;
      const out = resolveOutput(inputPath, args);
      if ('error' in out) return { success: false, output: `docx.replace_field error: ${out.error}` };

      const scriptArgs: string[] = [];
      if (hasField) scriptArgs.push('--field', String(args['field']), '--text', String(args['text'] ?? ''));
      if (hasSdt) scriptArgs.push('--sdt', String(args['sdt']), '--text', String(args['text'] ?? ''));
      if (hasMap) {
        mapFile = path.join(os.tmpdir(), `docxfield-${process.pid}-${Date.now()}.json`);
        await writeFile(mapFile, JSON.stringify(args['map']), 'utf8');
        scriptArgs.push('--map', mapFile);
      }
      if (dryRun) scriptArgs.push('--dry-run');
      const r = await unpackRun(inputPath, 'replace_field.py', scriptArgs, dryRun ? null : { outputPath: out.outputPath });
      logger.info({ inputPath, outputPath: r.outputPath, dryRun }, 'docx.replace_field ok');
      return {
        success: true,
        output: (dryRun ? '[dry-run] ' : '') + (r.output || 'done'),
        data: { inputPath, outputPath: r.outputPath, dryRun },
        ...(r.outputPath ? { artifacts: [{ path: r.outputPath, action: 'modified' as const }] } : {}),
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, err: msg }, 'docx.replace_field error');
      return { success: false, output: `docx.replace_field error: ${msg}` };
    } finally {
      if (mapFile) await rm(mapFile, { force: true }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------
// docx.delete_sections
// ---------------------------------------------------------------------------

export const docxDeleteSectionsTool: ToolDefinition = {
  name: 'docx.delete_sections',
  description:
    'Delete document sections from a .docx by index, preserving all other content, styles, and ' +
    'media. Set `list` to see section indices first. Then `delete` a range/list ("3-11" or ' +
    '"2,5,7") or `keep` only the listed ones (delete the rest). `dryRun` previews. NOTE: the ' +
    'final/terminal section carries the document body properties and cannot be removed (the tool ' +
    'returns an error if you try). Writes to `outputPath` or overwrites the input. Paths under ' +
    '/tmp/ or data/docx/.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .docx/.dotx.' },
    list: { type: 'boolean', required: false, description: 'List sections with indices (read-only).' },
    delete: { type: 'string', required: false, description: 'Sections to delete: "3-11" or "2,5,7".' },
    keep: { type: 'string', required: false, description: 'Sections to KEEP; all others deleted.' },
    dryRun: { type: 'boolean', required: false, description: 'Preview without writing.' },
    outputPath: { type: 'string', required: false, description: 'Where to write (.docx). Omit to overwrite input.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = await validateInput(inputPath);
    if (invalid) return { success: false, output: `docx.delete_sections error: ${invalid}` };

    const listMode = args['list'] === true;
    const hasDelete = typeof args['delete'] === 'string' && args['delete'] !== '';
    const hasKeep = typeof args['keep'] === 'string' && args['keep'] !== '';
    if (!listMode && !hasDelete && !hasKeep) {
      return { success: false, output: 'docx.delete_sections error: set `list`, or provide `delete` or `keep`' };
    }

    try {
      if (listMode) {
        const r = await unpackRun(inputPath, 'list_sections.py', [], null);
        return { success: true, output: r.output || '(no sections)', data: { inputPath, list: true } };
      }
      const dryRun = args['dryRun'] === true;
      const out = resolveOutput(inputPath, args);
      if ('error' in out) return { success: false, output: `docx.delete_sections error: ${out.error}` };

      const scriptArgs = hasDelete ? ['--delete', String(args['delete'])] : ['--keep', String(args['keep'])];
      if (dryRun) scriptArgs.push('--dry-run');
      const r = await unpackRun(inputPath, 'delete_sections.py', scriptArgs, dryRun ? null : { outputPath: out.outputPath });
      logger.info({ inputPath, outputPath: r.outputPath, dryRun }, 'docx.delete_sections ok');
      return {
        success: true,
        output: (dryRun ? '[dry-run] ' : '') + (r.output || 'done'),
        data: { inputPath, outputPath: r.outputPath, dryRun },
        ...(r.outputPath ? { artifacts: [{ path: r.outputPath, action: 'modified' as const }] } : {}),
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, err: msg }, 'docx.delete_sections error');
      return { success: false, output: `docx.delete_sections error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// docx.comment
// ---------------------------------------------------------------------------

export const docxCommentTool: ToolDefinition = {
  name: 'docx.comment',
  description:
    'Add a Word review comment to a .docx, or a threaded reply. TWO-STEP: this creates the ' +
    'comment part and RETURNS the anchor-marker XML you must then insert into the paragraph ' +
    '(via docx.patch or a direct edit) to attach the comment to a range — the file alone carries ' +
    'the comment but not yet its anchor. `paragraph` is the 0-based paragraph index; `text` is ' +
    'the comment body (pre-escape XML entities, e.g. &amp;). `parentId` makes it a reply. Writes ' +
    'to `outputPath` or overwrites the input. Paths under /tmp/ or data/docx/.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .docx/.dotx.' },
    paragraph: { type: 'number', required: true, description: '0-based paragraph index to comment on.' },
    text: { type: 'string', required: true, description: 'Comment body (pre-escaped XML entities).' },
    parentId: { type: 'number', required: false, description: 'Parent comment id — makes this a reply.' },
    outputPath: { type: 'string', required: false, description: 'Where to write (.docx). Omit to overwrite input.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = await validateInput(inputPath);
    if (invalid) return { success: false, output: `docx.comment error: ${invalid}` };
    const para = args['paragraph'];
    if (!Number.isInteger(para) || (para as number) < 0) {
      return { success: false, output: 'docx.comment error: `paragraph` must be a non-negative integer index' };
    }
    const text = args['text'];
    if (typeof text !== 'string' || text === '') {
      return { success: false, output: 'docx.comment error: `text` is required' };
    }

    const out = resolveOutput(inputPath, args);
    if ('error' in out) return { success: false, output: `docx.comment error: ${out.error}` };

    try {
      const scriptArgs = [String(para), text];
      if (Number.isInteger(args['parentId'])) scriptArgs.push('--parent', String(args['parentId']));
      const r = await unpackRun(inputPath, 'comment.py', scriptArgs, { outputPath: out.outputPath });
      logger.info({ inputPath, outputPath: r.outputPath, paragraph: para }, 'docx.comment ok');
      return {
        success: true,
        output: r.output || 'comment added',
        data: { inputPath, outputPath: r.outputPath, paragraph: para },
        ...(r.outputPath ? { artifacts: [{ path: r.outputPath, action: 'modified' as const }] } : {}),
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, err: msg }, 'docx.comment error');
      return { success: false, output: `docx.comment error: ${msg}` };
    }
  },
};
