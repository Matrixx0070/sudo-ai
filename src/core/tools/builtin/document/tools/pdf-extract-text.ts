/**
 * document.pdf-extract-text — Extract text from a PDF using pdftotext (poppler-utils).
 *
 * Shells out to `pdftotext` via execFile (args as array, never string interpolation).
 * Supports:
 *   - `-layout` flag for structure-preserving output
 *   - Page ranges via `-f` (first page) and `-l` (last page)
 *   - Output as plain text or JSON (pages split on form-feed character)
 *
 * pdftotext must be installed (part of poppler-utils package).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const log = createLogger('document:pdf-extract-text');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PDFTOTEXT_BINARY = 'pdftotext';
const PDFTOTEXT_TIMEOUT_MS = 15_000;
const PAGE_RANGE_RE = /^(\d+)-(\d+)$|^(\d+)$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PageRange {
  first: number;
  last: number;
}

function parsePageRange(pages: string): PageRange | null {
  const match = PAGE_RANGE_RE.exec(pages.trim());
  if (!match) return null;

  if (match[3] !== undefined) {
    // Single page "5"
    const n = parseInt(match[3], 10);
    return { first: n, last: n };
  }
  // Range "1-5"
  return {
    first: parseInt(match[1]!, 10),
    last: parseInt(match[2]!, 10),
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const pdfExtractTextTool: ToolDefinition = {
  name: 'document.pdf-extract-text',
  description:
    'Extract text from a PDF file using pdftotext (poppler-utils). ' +
    'Preserves layout structure. Supports page ranges. ' +
    'Returns extracted text, character count, and estimated page count. ' +
    'pdftotext must be installed (apt: poppler-utils).',
  category: 'document',
  timeout: 15_000,
  safety: 'readonly',
  parameters: {
    pdfPath: {
      type: 'string',
      required: true,
      description: 'Absolute path to the PDF file to extract text from.',
    },
    pages: {
      type: 'string',
      required: false,
      description:
        'Optional page range. Format: "1-5" for pages 1 to 5, or "3" for page 3 only. ' +
        'Omit to extract all pages.',
    },
    format: {
      type: 'string',
      required: false,
      default: 'text',
      enum: ['text', 'json'],
      description:
        '"text" (default) returns a single string. "json" returns an array of per-page strings.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    // --- Input validation ---
    const pdfPath = typeof params['pdfPath'] === 'string' ? params['pdfPath'].trim() : '';
    if (!pdfPath) {
      return { success: false, output: 'document.pdf-extract-text: "pdfPath" is required.' };
    }
    if (!pdfPath.startsWith('/')) {
      return { success: false, output: 'document.pdf-extract-text: "pdfPath" must be an absolute path.' };
    }
    if (!existsSync(pdfPath)) {
      return { success: false, output: `document.pdf-extract-text: file not found: "${pdfPath}"` };
    }
    if (!pdfPath.toLowerCase().endsWith('.pdf')) {
      return { success: false, output: `document.pdf-extract-text: file does not appear to be a PDF: "${pdfPath}"` };
    }

    const pagesRaw = typeof params['pages'] === 'string' ? params['pages'].trim() : '';
    const outputFormat = typeof params['format'] === 'string' ? params['format'] : 'text';

    // Build pdftotext args
    const args: string[] = ['-layout'];

    if (pagesRaw) {
      const range = parsePageRange(pagesRaw);
      if (!range) {
        return {
          success: false,
          output: `document.pdf-extract-text: invalid "pages" format "${pagesRaw}". Use "1-5" or "3".`,
        };
      }
      if (range.first < 1 || range.last < range.first) {
        return {
          success: false,
          output: `document.pdf-extract-text: invalid page range ${pagesRaw} (first must be >= 1 and <= last).`,
        };
      }
      args.push('-f', String(range.first), '-l', String(range.last));
    }

    // Output to stdout (-) so we don't need a temp file
    args.push(pdfPath, '-');

    try {
      const { stdout } = await execFileAsync(PDFTOTEXT_BINARY, args, {
        timeout: PDFTOTEXT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024, // 50 MB
      });

      const text = stdout;
      const characters = text.length;

      // Pages are separated by form-feed character (\f) in pdftotext output
      const pages = text.split('\f').filter((p) => p.trim().length > 0);
      const pageCount = pages.length;

      log.info(
        { sessionId: ctx.sessionId, pdfPath, pageCount, characters, format: outputFormat },
        'PDF text extracted',
      );
      ctxLog.info({ tool: 'document.pdf-extract-text', pdfPath, pageCount, characters }, 'Text extracted');

      if (outputFormat === 'json') {
        return {
          success: true,
          output: `Extracted ${characters} characters across ${pageCount} page(s) from "${pdfPath}".`,
          data: { pages, pageCount, characters },
        };
      }

      return {
        success: true,
        output: text,
        data: { text, pageCount, characters },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, pdfPath, err }, 'pdftotext failed');
      return { success: false, output: `document.pdf-extract-text error: ${msg}` };
    }
  },
};

export default pdfExtractTextTool;
