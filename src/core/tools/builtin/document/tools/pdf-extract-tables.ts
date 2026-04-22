/**
 * document.pdf-extract-tables — Extract HTML tables from a PDF using pdftohtml (poppler-utils).
 *
 * Workflow:
 *   1. Shell out to `pdftohtml -s -i -p <pdfPath> <outputBase>` (single HTML file, ignore images)
 *   2. Parse the resulting HTML for <table> elements
 *   3. Extract rows and cells into a structured array
 *   4. Clean up temp files
 *
 * If no tables are found, returns an empty array (not an error).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const log = createLogger('document:pdf-extract-tables');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PDFTOHTML_BINARY = 'pdftohtml';
const PDFTOHTML_TIMEOUT_MS = 15_000;
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
    const n = parseInt(match[3], 10);
    return { first: n, last: n };
  }
  return {
    first: parseInt(match[1]!, 10),
    last: parseInt(match[2]!, 10),
  };
}

/** Strip HTML tags, decode basic entities, and trim whitespace from a cell string. */
function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse <table>…</table> elements from an HTML string.
 * Returns a 3D array: tables[ tableIndex ][ rowIndex ][ cellIndex ] = cellText
 */
function parseTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tablePattern.exec(html)) !== null) {
    const tableHtml = tableMatch[1] ?? '';
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    rowPattern.lastIndex = 0;
    while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1] ?? '';
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      cellPattern.lastIndex = 0;
      while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
        cells.push(cleanCell(cellMatch[1] ?? ''));
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }
    if (rows.length > 0) {
      tables.push(rows);
    }
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const pdfExtractTablesTool: ToolDefinition = {
  name: 'document.pdf-extract-tables',
  description:
    'Extract tables from a PDF file using pdftohtml (poppler-utils). ' +
    'Returns structured table data as arrays of rows and cells. ' +
    'If no tables are found, returns an empty array (not an error). ' +
    'pdftohtml must be installed (apt: poppler-utils).',
  category: 'document',
  timeout: 15_000,
  safety: 'readonly',
  parameters: {
    pdfPath: {
      type: 'string',
      required: true,
      description: 'Absolute path to the PDF file to extract tables from.',
    },
    pages: {
      type: 'string',
      required: false,
      description:
        'Optional page range. Format: "1-5" for pages 1 to 5, or "3" for page 3 only. ' +
        'Omit to extract from all pages.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    // --- Input validation ---
    const pdfPath = typeof params['pdfPath'] === 'string' ? params['pdfPath'].trim() : '';
    if (!pdfPath) {
      return { success: false, output: 'document.pdf-extract-tables: "pdfPath" is required.' };
    }
    if (!pdfPath.startsWith('/')) {
      return { success: false, output: 'document.pdf-extract-tables: "pdfPath" must be an absolute path.' };
    }
    if (!existsSync(pdfPath)) {
      return { success: false, output: `document.pdf-extract-tables: file not found: "${pdfPath}"` };
    }
    if (!pdfPath.toLowerCase().endsWith('.pdf')) {
      return {
        success: false,
        output: `document.pdf-extract-tables: file does not appear to be a PDF: "${pdfPath}"`,
      };
    }

    const pagesRaw = typeof params['pages'] === 'string' ? params['pages'].trim() : '';

    // Page range validation
    let range: PageRange | null = null;
    if (pagesRaw) {
      range = parsePageRange(pagesRaw);
      if (!range) {
        return {
          success: false,
          output: `document.pdf-extract-tables: invalid "pages" format "${pagesRaw}". Use "1-5" or "3".`,
        };
      }
      if (range.first < 1 || range.last < range.first) {
        return {
          success: false,
          output: `document.pdf-extract-tables: invalid page range "${pagesRaw}" (first >= 1 and first <= last required).`,
        };
      }
    }

    // Create a temp directory for pdftohtml output
    const tmpBase = resolve(tmpdir(), `sudo-ai-pdftables-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
    const outputBase = join(tmpBase, 'output');

    // Build pdftohtml args: -s (single HTML), -i (ignore images), -p (page numbers)
    const args: string[] = ['-s', '-i', '-p'];
    if (range) {
      args.push('-f', String(range.first), '-l', String(range.last));
    }
    args.push(pdfPath, outputBase);

    let html = '';
    try {
      await execFileAsync(PDFTOHTML_BINARY, args, {
        timeout: PDFTOHTML_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024, // 50 MB
      });

      // pdftohtml creates <outputBase>.html
      const htmlFile = `${outputBase}.html`;
      if (!existsSync(htmlFile)) {
        // Some versions create just the first file, scan for any .html
        const created = readdirSync(tmpBase).filter((f) => f.endsWith('.html'));
        if (created.length === 0) {
          return {
            success: false,
            output: `document.pdf-extract-tables: pdftohtml produced no HTML output for "${pdfPath}"`,
          };
        }
        html = readFileSync(join(tmpBase, created[0]!), 'utf8');
      } else {
        html = readFileSync(htmlFile, 'utf8');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, pdfPath, err }, 'pdftohtml failed');
      return { success: false, output: `document.pdf-extract-tables error: ${msg}` };
    } finally {
      // Cleanup temp directory
      try {
        rmSync(tmpBase, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup failure
      }
    }

    // Parse tables from HTML
    const tables = parseTables(html);

    // Count <page> elements as rough page count estimate
    const pageCountMatch = (html.match(/<a name=\d+>/g) ?? []).length;
    const pageCount = pageCountMatch > 0 ? pageCountMatch : (range ? range.last - range.first + 1 : 1);

    log.info(
      { sessionId: ctx.sessionId, pdfPath, tableCount: tables.length, pageCount },
      'PDF tables extracted',
    );
    ctxLog.info({ tool: 'document.pdf-extract-tables', pdfPath, tableCount: tables.length }, 'Tables extracted');

    if (tables.length === 0) {
      return {
        success: true,
        output: `No tables found in "${pdfPath}".`,
        data: { tables: [], pageCount },
      };
    }

    const summary = tables
      .map((t, i) => `Table ${i + 1}: ${t.length} row(s), ${(t[0] ?? []).length} col(s)`)
      .join('; ');

    return {
      success: true,
      output: `Found ${tables.length} table(s) in "${pdfPath}": ${summary}`,
      data: { tables, pageCount },
    };
  },
};

export default pdfExtractTablesTool;
