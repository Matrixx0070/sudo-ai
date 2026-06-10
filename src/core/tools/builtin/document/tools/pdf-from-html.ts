/**
 * document.pdf-from-html — Generate a PDF from raw HTML using Playwright Chromium.
 *
 * Launches a headless Chromium instance, sets page content, emits PDF to the
 * specified output path, and cleans up the browser on finish or error.
 *
 * Output paths are restricted to /tmp/ or <project-root>/data/documents/.
 */

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const log = createLogger('document:pdf-from-html');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_PREFIXES = ['/tmp/', `${dataPath('documents')}/`];
const DEFAULT_DATA_DIR = dataPath('documents');
const FORMAT_SIZES: Record<string, { width: string; height: string }> = {
  A4: { width: '210mm', height: '297mm' },
  Letter: { width: '216mm', height: '279mm' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Margins {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

function validateOutputPath(rawPath: string): string | null {
  const absPath = rawPath.startsWith('/') ? rawPath : resolve(DEFAULT_DATA_DIR, rawPath);
  for (const prefix of ALLOWED_PREFIXES) {
    if (absPath.startsWith(prefix)) {
      return absPath;
    }
  }
  return null;
}

function buildMarginStr(margins: Margins, field: keyof Margins, fallback: string): string {
  const val = margins[field];
  return typeof val === 'number' && Number.isFinite(val) ? `${val}mm` : fallback;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const pdfFromHtmlTool: ToolDefinition = {
  name: 'document.pdf-from-html',
  description:
    'Generate a PDF document from raw HTML using Playwright Chromium. ' +
    'Supports A4/Letter formats, landscape orientation, and custom margins. ' +
    `Output path must be under /tmp/ or ${PROJECT_ROOT}/data/documents/. ` +
    'Returns the saved path, file size in bytes, and estimated page count.',
  category: 'document',
  timeout: 30_000,
  safety: 'readonly',
  parameters: {
    html: {
      type: 'string',
      required: true,
      description: 'Full HTML string to render as a PDF. Should include <html><body>...</body></html>.',
    },
    outputPath: {
      type: 'string',
      required: true,
      description:
        'Absolute path where the PDF will be saved. Must start with /tmp/ or ' +
        `${PROJECT_ROOT}/data/documents/. Example: /tmp/report.pdf`,
    },
    format: {
      type: 'string',
      required: false,
      default: 'A4',
      enum: ['A4', 'Letter'],
      description: 'Paper format. "A4" (default) or "Letter".',
    },
    landscape: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'When true, render in landscape orientation. Default is portrait (false).',
    },
    margins: {
      type: 'object',
      required: false,
      description: 'Page margins in millimetres. All fields optional (defaults to 10mm each side).',
      properties: {
        top: { type: 'number', description: 'Top margin in mm.' },
        right: { type: 'number', description: 'Right margin in mm.' },
        bottom: { type: 'number', description: 'Bottom margin in mm.' },
        left: { type: 'number', description: 'Left margin in mm.' },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    // --- Input validation ---
    const html = typeof params['html'] === 'string' ? params['html'] : '';
    if (!html.trim()) {
      return { success: false, output: 'document.pdf-from-html: "html" must be a non-empty string.' };
    }

    const rawPath = typeof params['outputPath'] === 'string' ? params['outputPath'].trim() : '';
    if (!rawPath) {
      return { success: false, output: 'document.pdf-from-html: "outputPath" is required.' };
    }

    const outputPath = validateOutputPath(rawPath);
    if (!outputPath) {
      return {
        success: false,
        output:
          `document.pdf-from-html: outputPath must be under /tmp/ or ` +
          `${PROJECT_ROOT}/data/documents/. Got: "${rawPath}"`,
      };
    }

    const format = typeof params['format'] === 'string' ? params['format'] : 'A4';
    const sizeConfig = FORMAT_SIZES[format] ?? FORMAT_SIZES['A4']!;
    const landscape = params['landscape'] === true;

    const marginsRaw = typeof params['margins'] === 'object' && params['margins'] !== null
      ? (params['margins'] as Margins)
      : {};

    const marginTop = buildMarginStr(marginsRaw, 'top', '10mm');
    const marginRight = buildMarginStr(marginsRaw, 'right', '10mm');
    const marginBottom = buildMarginStr(marginsRaw, 'bottom', '10mm');
    const marginLeft = buildMarginStr(marginsRaw, 'left', '10mm');

    // Ensure output directory exists
    mkdirSync(dirname(outputPath), { recursive: true });

    // --- Launch browser and generate PDF ---
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      await page.setContent(html, { waitUntil: 'networkidle', timeout: 20_000 });

      await page.pdf({
        path: outputPath,
        width: landscape ? sizeConfig.height : sizeConfig.width,
        height: landscape ? sizeConfig.width : sizeConfig.height,
        printBackground: true,
        margin: {
          top: marginTop,
          right: marginRight,
          bottom: marginBottom,
          left: marginLeft,
        },
      });

      if (!existsSync(outputPath)) {
        return { success: false, output: 'document.pdf-from-html: PDF was not created on disk.' };
      }

      const stats = statSync(outputPath);
      const sizeBytes = stats.size;

      // Rough page count: estimate based on file size (heuristic; Playwright doesn't expose count)
      // A typical A4 page PDF ~50-150KB. We'll return 1 as minimum.
      const pageCount = Math.max(1, Math.round(sizeBytes / 75_000));

      log.info(
        { sessionId: ctx.sessionId, outputPath, sizeBytes, format, landscape },
        'PDF generated from HTML',
      );
      ctxLog.info({ tool: 'document.pdf-from-html', outputPath, sizeBytes }, 'PDF created');

      return {
        success: true,
        output: `PDF created: ${outputPath} (${sizeBytes} bytes, ~${pageCount} page(s))`,
        data: { path: outputPath, sizeBytes, pageCount },
        artifacts: [{ path: outputPath, action: 'created', size: sizeBytes }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, outputPath, err }, 'PDF generation failed');
      return { success: false, output: `document.pdf-from-html error: ${msg}` };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  },
};

export default pdfFromHtmlTool;
