/**
 * @file pdf-forms.ts
 * @description document.pdf-form-fields + document.pdf-fill-form +
 * document.pdf-to-images — PDF form workflow, wrapping the vendored Python
 * scripts from grok's pdf skill (pypdf/pdfplumber/reportlab). form-fields
 * extracts every fillable field with id/page/type/state; fill-form writes
 * values back — `fillable` mode for real AcroForm fields, `annotations` mode
 * for flat forms (draws positioned text; see scripts/pdf/forms.md for the
 * positioning procedure). pdf-to-images renders per-page PNGs for visual QA.
 * Scripts import each other as siblings, so they run with cwd = scripts/pdf.
 * Follows document.* conventions: absolute existing input paths, outputs to
 * /tmp for the attachment extractor.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('document:pdf-forms');
const execFileAsync = promisify(execFile);

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pdf');
const PY_TIMEOUT = 60_000;

function validatePdfPath(p: string, label: string): string | null {
  if (!p) return `${label} is required`;
  if (!p.startsWith('/')) return `${label} must be an absolute path (got "${p}")`;
  if (!p.toLowerCase().endsWith('.pdf')) return `${label} is not a .pdf file: "${p}"`;
  if (!existsSync(p)) return `${label} not found: "${p}"`;
  return null;
}

async function py(script: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('python3', [path.join(SCRIPTS, script), ...args], {
    timeout: PY_TIMEOUT,
    maxBuffer: 16 * 1024 * 1024,
    cwd: SCRIPTS,
  });
  return stdout;
}

function errMsg(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
}

// ---------------------------------------------------------------------------
// document.pdf-form-fields
// ---------------------------------------------------------------------------

export const pdfFormFieldsTool: ToolDefinition = {
  name: 'document.pdf-form-fields',
  description:
    'Extract every fillable form field from a PDF as JSON: field_id, page, type (text/checkbox/' +
    'radio/choice), current value, and states for checkboxes. Run this FIRST before filling a ' +
    'form. An empty result means the PDF has no fillable fields (flat form) — fill it with ' +
    'document.pdf-fill-form mode "annotations" instead.',
  category: 'document',
  timeout: PY_TIMEOUT + 10_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Absolute path to an existing .pdf.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = validatePdfPath(inputPath, 'inputPath');
    if (invalid) return { success: false, output: `document.pdf-form-fields error: ${invalid}` };

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'pdffields-'));
    const outJson = path.join(tmp, 'fields.json');
    try {
      await py('extract_form_field_info.py', [inputPath, outJson]);
      const fields = JSON.parse(await readFile(outJson, 'utf8')) as unknown[];
      logger.info({ inputPath, fieldCount: fields.length }, 'document.pdf-form-fields ok');
      const summary =
        fields.length === 0
          ? 'No fillable fields — this is a flat form. Use document.pdf-fill-form with mode "annotations".'
          : `${fields.length} fillable field(s).`;
      return {
        success: true,
        output: `${summary}\n${JSON.stringify(fields, null, 2).slice(0, 12_000)}`,
        data: { inputPath, fieldCount: fields.length, fields },
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, err: msg }, 'document.pdf-form-fields error');
      return { success: false, output: `document.pdf-form-fields error: ${msg}` };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------
// document.pdf-fill-form
// ---------------------------------------------------------------------------

export const pdfFillFormTool: ToolDefinition = {
  name: 'document.pdf-fill-form',
  description:
    'Fill a PDF form and write a new PDF. Mode "fillable" (default): set real AcroForm fields — ' +
    'pass `fields` as the array from document.pdf-form-fields, adding a `value` to each field to ' +
    'set (text fields take a string; checkboxes take their `checked_value` or `unchecked_value`). ' +
    'Mode "annotations": for FLAT forms with no fillable fields — pass `form` as {form_fields: ' +
    '[{page_number, entry_bounding_box: [x0,y0,x1,y1], entry_text: {text, font_size?}}], pages: ' +
    '[{page_number, pdf_width, pdf_height}]}. Bounding boxes are TOP-LEFT-origin (y grows ' +
    'downward), in PDF points. READ scripts/pdf/forms.md first for the positioning procedure, ' +
    'and ALWAYS verify the result with document.pdf-to-images.',
  category: 'document',
  timeout: PY_TIMEOUT + 10_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Absolute path to an existing .pdf.' },
    fields: { type: 'array', required: false, description: 'Fillable mode: field array from document.pdf-form-fields with `value` set.' },
    form: { type: 'object', required: false, description: 'Annotations mode: {form_fields, pages} object (see description).' },
    outputPath: { type: 'string', required: false, description: 'Where to write the filled .pdf (default: /tmp/<stem>-filled.pdf).' },
    mode: { type: 'string', required: false, description: '"fillable" (default) or "annotations".' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = validatePdfPath(inputPath, 'inputPath');
    if (invalid) return { success: false, output: `document.pdf-fill-form error: ${invalid}` };
    const mode = args['mode'] === 'annotations' ? 'annotations' : 'fillable';
    const payload = mode === 'annotations' ? args['form'] : args['fields'];
    if (mode === 'fillable' && (!Array.isArray(payload) || payload.length === 0)) {
      return { success: false, output: 'document.pdf-fill-form error: fillable mode needs a non-empty `fields` array' };
    }
    if (mode === 'annotations' && (typeof payload !== 'object' || payload === null || !('form_fields' in (payload as object)))) {
      return { success: false, output: 'document.pdf-fill-form error: annotations mode needs a `form` object with form_fields + pages' };
    }
    const stem = path.basename(inputPath, '.pdf');
    const outputPath = args['outputPath'] ? String(args['outputPath']) : path.join(os.tmpdir(), `${stem}-filled.pdf`);
    if (!outputPath.startsWith('/') || !outputPath.toLowerCase().endsWith('.pdf')) {
      return { success: false, output: 'document.pdf-fill-form error: outputPath must be an absolute .pdf path' };
    }

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'pdffill-'));
    const fieldsJson = path.join(tmp, 'fields.json');
    try {
      await writeFile(fieldsJson, JSON.stringify(payload), 'utf8');
      const script = mode === 'annotations' ? 'fill_pdf_form_with_annotations.py' : 'fill_fillable_fields.py';
      const out = await py(script, [inputPath, fieldsJson, outputPath]);
      if (!existsSync(outputPath)) {
        return { success: false, output: `document.pdf-fill-form error: output not created: ${out.trim().slice(0, 400)}` };
      }
      const fieldCount = Array.isArray(payload)
        ? payload.length
        : ((payload as { form_fields?: unknown[] }).form_fields?.length ?? 0);
      logger.info({ inputPath, outputPath, mode, fieldCount }, 'document.pdf-fill-form ok');
      return {
        success: true,
        output: (out.trim() ? out.trim() + '\n' : '') + `Filled (${mode}) → ${outputPath}`,
        data: { inputPath, outputPath, mode },
        artifacts: [{ path: outputPath, action: 'created' as const }],
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, mode, err: msg }, 'document.pdf-fill-form error');
      return { success: false, output: `document.pdf-fill-form error: ${msg}` };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------
// document.pdf-to-images
// ---------------------------------------------------------------------------

export const pdfToImagesTool: ToolDefinition = {
  name: 'document.pdf-to-images',
  description:
    'Render each page of a PDF as a PNG image (pdfplumber). Use for visual QA — especially to ' +
    'verify a filled form before delivering it. Writes page-N.png files into outputDir ' +
    '(default: a fresh /tmp dir) and returns their paths.',
  category: 'document',
  timeout: PY_TIMEOUT + 10_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Absolute path to an existing .pdf.' },
    outputDir: { type: 'string', required: false, description: 'Directory for page PNGs (created if missing).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = validatePdfPath(inputPath, 'inputPath');
    if (invalid) return { success: false, output: `document.pdf-to-images error: ${invalid}` };
    const outputDir = args['outputDir']
      ? String(args['outputDir'])
      : await mkdtemp(path.join(os.tmpdir(), 'pdfpages-'));
    if (!outputDir.startsWith('/')) {
      return { success: false, output: 'document.pdf-to-images error: outputDir must be an absolute path' };
    }

    try {
      await mkdir(outputDir, { recursive: true });
      const out = await py('convert_pdf_to_images.py', [inputPath, outputDir]);
      const created = (await readdir(outputDir))
        .filter((f) => /\.png$/i.test(f))
        .sort()
        .map((f) => path.join(outputDir, f));
      if (created.length === 0) {
        return { success: false, output: `document.pdf-to-images error: no images produced: ${out.trim().slice(0, 400)}` };
      }
      logger.info({ inputPath, outputDir, pages: created.length }, 'document.pdf-to-images ok');
      return {
        success: true,
        output: `${created.length} page image(s):\n${created.join('\n')}`,
        data: { inputPath, outputDir, created },
        artifacts: created.map((p) => ({ path: p, action: 'created' as const })),
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, err: msg }, 'document.pdf-to-images error');
      return { success: false, output: `document.pdf-to-images error: ${msg}` };
    }
  },
};
