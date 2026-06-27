/**
 * @file pdf-edit.ts
 * @description document.pdf-merge + document.pdf-extract-pages — page-level PDF
 * operations using poppler-utils (pdfunite / pdfseparate), the same toolkit behind
 * document.pdf-extract-*. No new dependency. Both shell out via execFile with an
 * args ARRAY (never string interpolation) and write a new PDF to /tmp, which the
 * loop's file-attachment extractor delivers (web download / telegram document).
 * These operate on EXISTING PDFs (e.g. files the user uploaded into data/uploads/).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('document:pdf-edit');
const execFileAsync = promisify(execFile);

const POPPLER_TIMEOUT_MS = 30_000;
const MAX_INPUTS = 50;
const MAX_PAGES = 2000;

/** Validate an absolute, existing .pdf path. Returns an error string or null. */
function validatePdfPath(p: string, label: string): string | null {
  if (!p.startsWith('/')) return `${label} must be an absolute path (got "${p}").`;
  if (!existsSync(p)) return `${label} not found: "${p}".`;
  if (!p.toLowerCase().endsWith('.pdf')) return `${label} is not a .pdf file: "${p}".`;
  return null;
}

/**
 * Coerce a `paths` argument into a clean string[] — the LLM may pass it as a JSON
 * string or a comma/newline-separated string (the slides/normalizeSlidesArg lesson).
 * Pure + exported for testing.
 */
export function normalizePathsArg(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = (arr as string).split(/[,\n]/); }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
}

export const pdfMergeTool: ToolDefinition = {
  name: 'document.pdf-merge',
  description:
    'Merge (combine / concatenate) two or more PDF files into a single PDF and deliver it to the chat. ' +
    'Use for "merge these PDFs", "combine the PDFs into one". Supply `inputs` as the list of absolute PDF ' +
    'paths in the order they should appear (e.g. files the user uploaded).',
  category: 'document',
  timeout: 35_000,
  parameters: {
    inputs: {
      type: 'array',
      required: true,
      description: 'Absolute paths of the PDFs to merge, in order.',
      items: { type: 'string', description: 'An absolute path to a .pdf file.' },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputs = normalizePathsArg(params['inputs']);
    if (inputs.length < 2) {
      return { success: false, output: 'inputs must list at least two absolute PDF paths to merge.' };
    }
    if (inputs.length > MAX_INPUTS) {
      return { success: false, output: `Too many inputs (max ${MAX_INPUTS}, got ${inputs.length}).` };
    }
    for (const p of inputs) {
      const err = validatePdfPath(p, 'input');
      if (err) return { success: false, output: err };
    }

    const outPath = `/tmp/merged-${Date.now()}.pdf`;
    logger.info({ session: ctx.sessionId, count: inputs.length }, 'document.pdf-merge invoked');
    try {
      // pdfunite in1.pdf in2.pdf ... out.pdf
      await execFileAsync('pdfunite', [...inputs, outPath], { timeout: POPPLER_TIMEOUT_MS });
      if (!existsSync(outPath)) return { success: false, output: 'pdf-merge: output was not created (is poppler-utils installed?).' };
      const size = statSync(outPath).size;
      logger.info({ outPath, size, count: inputs.length }, 'PDFs merged');
      return {
        success: true,
        output: `Merged PDF saved to: ${outPath} — ${inputs.length} files combined (${size} bytes).`,
        data: { path: outPath, merged: inputs.length, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'document.pdf-merge failed');
      return { success: false, output: `PDF merge failed: ${msg} (needs poppler-utils' pdfunite).` };
    }
  },
};

export const pdfExtractPagesTool: ToolDefinition = {
  name: 'document.pdf-extract-pages',
  description:
    'Extract a range of pages from a PDF into a new PDF and deliver it to the chat (a "split" / "keep just ' +
    'these pages"). Use for "extract pages 2-5", "split out the first 3 pages", "just give me page 7". Supply ' +
    'the absolute `input` PDF path and the 1-based `firstPage` / `lastPage`.',
  category: 'document',
  timeout: 35_000,
  parameters: {
    input: { type: 'string', required: true, description: 'Absolute path to the source .pdf file.' },
    firstPage: { type: 'number', required: true, description: 'First page to keep (1-based).' },
    lastPage: { type: 'number', required: true, description: 'Last page to keep (1-based, >= firstPage).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const input = typeof params['input'] === 'string' ? params['input'].trim() : '';
    const pathErr = validatePdfPath(input, 'input');
    if (pathErr) return { success: false, output: pathErr };

    const first = Math.trunc(Number(params['firstPage']));
    const last = Math.trunc(Number(params['lastPage']));
    if (!Number.isFinite(first) || !Number.isFinite(last) || first < 1 || last < first) {
      return { success: false, output: 'firstPage and lastPage must be 1-based integers with firstPage <= lastPage.' };
    }
    if (last - first + 1 > MAX_PAGES) {
      return { success: false, output: `Too many pages requested (max ${MAX_PAGES}).` };
    }

    const outPath = `/tmp/pages-${Date.now()}.pdf`;
    const dir = mkdtempSync(join(tmpdir(), 'pdfpages-'));
    logger.info({ session: ctx.sessionId, first, last }, 'document.pdf-extract-pages invoked');
    try {
      // pdfseparate -f F -l L in.pdf dir/p-%d.pdf → one file per page (named by original index)
      await execFileAsync('pdfseparate', ['-f', String(first), '-l', String(last), input, join(dir, 'p-%d.pdf')], { timeout: POPPLER_TIMEOUT_MS });
      const parts = readdirSync(dir)
        .filter((f) => /^p-\d+\.pdf$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
        .map((f) => join(dir, f));
      if (parts.length === 0) {
        return { success: false, output: `No pages extracted — does the PDF have pages ${first}-${last}?` };
      }
      // Re-unite the extracted pages (pdfseparate emits singletons even for one page).
      await execFileAsync('pdfunite', [...parts, outPath], { timeout: POPPLER_TIMEOUT_MS });
      if (!existsSync(outPath)) return { success: false, output: 'pdf-extract-pages: output was not created (is poppler-utils installed?).' };
      const size = statSync(outPath).size;
      logger.info({ outPath, size, pages: parts.length }, 'PDF pages extracted');
      return {
        success: true,
        output: `Extracted pages ${first}-${last} saved to: ${outPath} — ${parts.length} page(s) (${size} bytes).`,
        data: { path: outPath, pages: parts.length, firstPage: first, lastPage: last, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'document.pdf-extract-pages failed');
      return { success: false, output: `PDF page extraction failed: ${msg} (needs poppler-utils' pdfseparate/pdfunite).` };
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  },
};
