/**
 * @file qr.ts
 * @description media.qr — generate a QR code from text/URL as a PNG image and
 * deliver it to the chat. The QR matrix is computed by the `qrcode` lib's SVG
 * output (pure-JS, no native canvas) and rasterised to PNG via playwright-core
 * chromium (its own headless instance — the same stack as document.pdf-from-html
 * and data.chart, so no CDP collision). The "QR code saved to: <path>.png" output
 * is picked up by the agent loop's file-attachment extractor → delivered inline.
 */

import { statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('media:qr');

/** QR can technically hold ~2953 bytes; cap below that for a scannable, sane image. */
const MAX_QR_CHARS = 1500;
const QR_PX = 420;

export const qrTool: ToolDefinition = {
  name: 'media.qr',
  description:
    'Generate a QR code from text or a URL as a PNG IMAGE and deliver it to the user in the chat. ' +
    'Use this for "make a QR code", "QR for this link/wifi/text". Pass the exact content to encode.',
  category: 'media',
  timeout: 30_000,
  parameters: {
    text: {
      type: 'string',
      required: true,
      description: 'The exact text or URL to encode in the QR code.',
    },
    errorCorrection: {
      type: 'string',
      description: 'Error-correction level (higher tolerates more damage but is denser). Default M.',
      enum: ['L', 'M', 'Q', 'H'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = typeof params['text'] === 'string' ? (params['text'] as string) : '';
    const ecRaw = params['errorCorrection'];
    const ec = (['L', 'M', 'Q', 'H'].includes(ecRaw as string) ? ecRaw : 'M') as 'L' | 'M' | 'Q' | 'H';

    if (!text.trim()) return { success: false, output: 'text is required.' };
    if (text.length > MAX_QR_CHARS) {
      return { success: false, output: `text too long for a QR code (max ${MAX_QR_CHARS} chars, got ${text.length}).` };
    }

    logger.info({ session: ctx.sessionId, chars: text.length, ec }, 'media.qr invoked');

    let svg: string;
    try {
      const qrcode = (await import('qrcode')).default;
      svg = await qrcode.toString(text, { type: 'svg', margin: 2, width: QR_PX, errorCorrectionLevel: ec });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.qr encode failed');
      return { success: false, output: `QR encode failed: ${msg}` };
    }

    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#fff">${svg}</body></html>`;
    const outPath = `/tmp/qr-${Date.now()}.png`;

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setViewportSize({ width: QR_PX, height: QR_PX });
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      await page.screenshot({ path: outPath, type: 'png' });
      const size = statSync(outPath).size;
      logger.info({ outPath, size, chars: text.length }, 'QR PNG rendered');
      return {
        success: true,
        output: `QR code saved to: ${outPath} — delivered to the chat as an image (encodes ${text.length} chars, EC level ${ec}).`,
        data: { path: outPath, chars: text.length, errorCorrection: ec, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.qr render failed');
      return { success: false, output: `QR render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }
  },
};

export default qrTool;
