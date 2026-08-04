/**
 * @file slide-edit.ts
 * @description pptx slide-editing suite v2 — delete_slide, set_text,
 * inspect_slides, check_overlaps, render_slides. Wraps the zip-only vendored
 * scripts from grok's pptx skill that turn the unpack→edit→pack workflow's
 * "edit slide XML by hand" step into proper primitives: structured text
 * replacement into placeholders, slide deletion with sldIdLst upkeep, geometric
 * overlap/overflow QA (no vision calls), and per-slide rendering with a contact
 * sheet (LibreOffice). Shares path allowlists with the other pptx tools.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, stat } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { isAllowedPath, isRealPathAllowed, validateUnpackedDir, ALLOWED_MSG } from './edit.js';

const logger = createLogger('pptx:slide-edit');
const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const OFFICE_PARENT = path.join(HERE, '..', '..', 'docx', 'scripts');

async function py(script: string, args: string[], needsOffice = false): Promise<string> {
  const { stdout } = await execFileAsync('python3', [path.join(SCRIPTS, script), ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(needsOffice ? { env: { ...process.env, PYTHONPATH: OFFICE_PARENT } } : {}),
  });
  return stdout;
}

function errMsg(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
}

function fail(tool: string, msg: string): ToolResult {
  return { success: false, output: `${tool} error: ${msg}` };
}

/** Resolve a slide reference ("slide2.xml" or "2") inside an unpacked dir. */
function slideFileName(ref: string): string | null {
  if (/^slide\d+\.xml$/.test(ref)) return ref;
  if (/^\d+$/.test(ref)) return `slide${ref}.xml`;
  return null;
}

// ---------------------------------------------------------------------------
// pptx.delete_slide
// ---------------------------------------------------------------------------

export const pptxDeleteSlideTool: ToolDefinition = {
  name: 'pptx.delete_slide',
  description:
    'Delete slides from an unpacked PPTX directory (from pptx.unpack): removes them from ' +
    '<p:sldIdLst> and cleans their files/rels. Pass `slides` to delete ("slide3.xml" or "3"), ' +
    'or `keep` to delete everything EXCEPT the listed slides. Run pptx.clean afterwards, then ' +
    'pptx.pack.',
  category: 'content',
  timeout: 130_000,
  parameters: {
    dir: { type: 'string', required: true, description: 'Unpacked PPTX directory (from pptx.unpack).' },
    slides: { type: 'array', required: false, description: 'Slides to delete: ["slide3.xml", "5", …].' },
    keep: { type: 'array', required: false, description: 'Keep-list mode: slides to KEEP; all others deleted.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const dir = String(args['dir'] ?? '');
    const invalid = await validateUnpackedDir(dir);
    if (invalid) return fail('pptx.delete_slide', invalid);
    const slides = Array.isArray(args['slides']) ? (args['slides'] as unknown[]).map(String) : [];
    const keep = Array.isArray(args['keep']) ? (args['keep'] as unknown[]).map(String) : [];
    if (slides.length === 0 && keep.length === 0) {
      return fail('pptx.delete_slide', 'provide `slides` to delete or `keep` to keep');
    }
    const refs = (keep.length > 0 ? keep : slides).map((r) => slideFileName(r));
    if (refs.some((r) => r === null)) {
      return fail('pptx.delete_slide', 'slide refs must look like "slide3.xml" or "3"');
    }

    try {
      const cliArgs = keep.length > 0 ? [dir, '--keep', ...(refs as string[])] : [dir, ...(refs as string[])];
      const out = await py('delete_slide.py', cliArgs);
      logger.info({ dir, slides, keep }, 'pptx.delete_slide ok');
      return { success: true, output: out.trim() || 'done', data: { dir, slides, keep } };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ dir, err: msg }, 'pptx.delete_slide error');
      return fail('pptx.delete_slide', msg);
    }
  },
};

// ---------------------------------------------------------------------------
// pptx.set_text
// ---------------------------------------------------------------------------

export const pptxSetTextTool: ToolDefinition = {
  name: 'pptx.set_text',
  description:
    'Set the text of a placeholder in one slide of an unpacked PPTX, preserving the template\'s ' +
    'formatting (the structured alternative to hand-editing slide XML). `placeholder` is the ' +
    'ph type or index shown by pptx.inspect_slides (e.g. "ctrTitle", "subTitle", "body", "1"). ' +
    'Use `text` for plain lines ("\\n" separated) or `runs` for styled runs (array of ' +
    '{text, bold?, italic?} arrays, one per paragraph).',
  category: 'content',
  timeout: 40_000,
  parameters: {
    dir: { type: 'string', required: true, description: 'Unpacked PPTX directory.' },
    slide: { type: 'string', required: true, description: 'Slide file ("slide2.xml") or number ("2").' },
    placeholder: { type: 'string', required: true, description: 'Placeholder type/idx from pptx.inspect_slides.' },
    text: { type: 'string', required: false, description: 'New text; "\\n" separates paragraphs.' },
    runs: { type: 'array', required: false, description: 'Styled runs JSON (see description).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const dir = String(args['dir'] ?? '');
    const invalid = await validateUnpackedDir(dir);
    if (invalid) return fail('pptx.set_text', invalid);
    const slide = slideFileName(String(args['slide'] ?? ''));
    if (!slide) return fail('pptx.set_text', 'slide must look like "slide2.xml" or "2"');
    const placeholder = String(args['placeholder'] ?? '');
    if (!placeholder) return fail('pptx.set_text', 'placeholder is required');
    const hasText = typeof args['text'] === 'string' && args['text'] !== '';
    const hasRuns = Array.isArray(args['runs']) && args['runs'].length > 0;
    if (!hasText && !hasRuns) return fail('pptx.set_text', 'provide `text` or `runs`');
    const slidePath = path.join(dir, 'ppt', 'slides', slide);
    try {
      await stat(slidePath);
    } catch {
      return fail('pptx.set_text', `slide not found: ${slidePath}`);
    }

    try {
      const cliArgs = [slidePath, '--ph', placeholder];
      if (hasRuns) cliArgs.push('--runs', JSON.stringify(args['runs']));
      else cliArgs.push('--text', String(args['text']));
      const out = await py('replace_text.py', cliArgs);
      logger.info({ dir, slide, placeholder }, 'pptx.set_text ok');
      return { success: true, output: out.trim() || 'done', data: { dir, slide, placeholder } };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ dir, slide, err: msg }, 'pptx.set_text error');
      return fail('pptx.set_text', msg);
    }
  },
};

// ---------------------------------------------------------------------------
// pptx.inspect_slides
// ---------------------------------------------------------------------------

export const pptxInspectSlidesTool: ToolDefinition = {
  name: 'pptx.inspect_slides',
  description:
    'Inspect an unpacked PPTX directory: per-slide placeholders (types/indexes for pptx.set_text), ' +
    'text content, images, and media. Pass `slide` to focus on one slide; `theme` adds theme ' +
    'colors; `media` adds the media inventory. The unpacked-dir companion to pptx.inspect.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    dir: { type: 'string', required: true, description: 'Unpacked PPTX directory.' },
    slide: { type: 'string', required: false, description: 'Optional single slide ("slide2.xml" or "2").' },
    theme: { type: 'boolean', required: false, description: 'Also show theme colors.' },
    media: { type: 'boolean', required: false, description: 'Also show media inventory.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const dir = String(args['dir'] ?? '');
    const invalid = await validateUnpackedDir(dir);
    if (invalid) return fail('pptx.inspect_slides', invalid);

    const cliArgs: string[] = [];
    if (args['slide']) {
      const slide = slideFileName(String(args['slide']));
      if (!slide) return fail('pptx.inspect_slides', 'slide must look like "slide2.xml" or "2"');
      cliArgs.push(path.join(dir, 'ppt', 'slides', slide));
    } else {
      cliArgs.push(dir);
    }
    if (args['theme'] === true) cliArgs.push('--theme');
    if (args['media'] === true) cliArgs.push('--media');

    try {
      const out = await py('inspect_slide.py', cliArgs);
      logger.info({ dir, slide: args['slide'] }, 'pptx.inspect_slides ok');
      return { success: true, output: out.trim() || '(no output)', data: { dir } };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ dir, err: msg }, 'pptx.inspect_slides error');
      return fail('pptx.inspect_slides', msg);
    }
  },
};

// ---------------------------------------------------------------------------
// pptx.check_overlaps
// ---------------------------------------------------------------------------

export const pptxCheckOverlapsTool: ToolDefinition = {
  name: 'pptx.check_overlaps',
  description:
    'Geometric QA for an unpacked PPTX: detect overlapping shapes and off-slide overflow in every ' +
    'slide, without rendering. Set `fix` to auto-adjust simple cases. Run before pptx.pack; pair ' +
    'with pptx.render_slides for visual confirmation.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    dir: { type: 'string', required: true, description: 'Unpacked PPTX directory.' },
    fix: { type: 'boolean', required: false, description: 'Attempt automatic fixes.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const dir = String(args['dir'] ?? '');
    const invalid = await validateUnpackedDir(dir);
    if (invalid) return fail('pptx.check_overlaps', invalid);

    try {
      const out = await py('check_overlaps.py', args['fix'] === true ? [dir, '--fix'] : [dir]);
      logger.info({ dir, fix: args['fix'] === true }, 'pptx.check_overlaps ok');
      return { success: true, output: out.trim() || 'No overlaps found', data: { dir } };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ dir, err: msg }, 'pptx.check_overlaps error');
      return fail('pptx.check_overlaps', msg);
    }
  },
};

// ---------------------------------------------------------------------------
// pptx.render_slides
// ---------------------------------------------------------------------------

export const pptxRenderSlidesTool: ToolDefinition = {
  name: 'pptx.render_slides',
  description:
    'Render a .pptx to individual slide images plus a contact sheet in one command (LibreOffice ' +
    '+ pdftoppm). The full-resolution visual-QA step after pptx.pack — inspect the images with ' +
    'vision before declaring a deck done. Paths under /tmp/ or data/pptx/.',
  category: 'content',
  timeout: 130_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .pptx to render.' },
    outputDir: { type: 'string', required: false, description: 'Where to write slide images (default: alongside input).' },
    dpi: { type: 'number', required: false, description: 'Render DPI (default 150).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    if (!inputPath) return fail('pptx.render_slides', 'inputPath is required');
    if (!/\.pptx$/i.test(inputPath)) return fail('pptx.render_slides', 'inputPath must end in .pptx');
    if (!isAllowedPath(inputPath)) return fail('pptx.render_slides', `inputPath ${ALLOWED_MSG}`);
    try {
      await stat(inputPath);
    } catch {
      return fail('pptx.render_slides', `file not found: ${inputPath}`);
    }
    if (!(await isRealPathAllowed(inputPath, 'input'))) {
      return fail('pptx.render_slides', `inputPath resolves outside allowed dirs: ${inputPath}`);
    }
    const cliArgs = [inputPath];
    const outputDir = args['outputDir'] ? String(args['outputDir']) : '';
    if (outputDir) {
      if (!isAllowedPath(outputDir)) return fail('pptx.render_slides', `outputDir ${ALLOWED_MSG}`);
      cliArgs.push('--outdir', outputDir);
    }
    const dpi = Number(args['dpi']);
    if (Number.isInteger(dpi) && dpi >= 50 && dpi <= 300) cliArgs.push('--dpi', String(dpi));

    try {
      const out = await py('render_slides.py', cliArgs, true);
      const dir = outputDir || path.dirname(path.resolve(inputPath));
      const created = (await readdir(dir).catch(() => []))
        .filter((f) => /\.(jpg|png)$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f));
      logger.info({ inputPath, outputDir: dir, images: created.length }, 'pptx.render_slides ok');
      return {
        success: true,
        output: out.trim() || `rendered ${created.length} image(s) → ${dir}`,
        data: { inputPath, outputDir: dir, created },
        artifacts: created.slice(0, 20).map((p) => ({ path: p, action: 'created' as const })),
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, err: msg }, 'pptx.render_slides error');
      return fail('pptx.render_slides', msg);
    }
  },
};
