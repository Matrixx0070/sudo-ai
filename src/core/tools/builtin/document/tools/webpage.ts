/**
 * @file webpage.ts
 * @description document.webpage — turn agent-authored HTML into a self-contained,
 * INTERACTIVE webpage the user can open (the "artifact" capability). Unlike
 * document.pdf-from-html (which flattens HTML to a static PDF), this saves a real
 * .html file — buttons, forms, inline <script> all work — and also renders a PNG
 * preview via playwright-core chromium so the chat shows what it looks like. Both
 * "saved to:" paths are picked up by the loop's file-attachment extractor → the
 * .html as a download (web link / telegram document) and the .png inline.
 */

import { writeFileSync, statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('document:webpage');

const MAX_HTML = 200_000;

function escAttr(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c));
}

/**
 * Ensure the model's HTML is a complete, standalone document. A full document
 * (has <!doctype> or <html>) is trusted and returned as-is; a bare fragment is
 * wrapped with a doctype, UTF-8 charset, a responsive viewport, a <title>, and a
 * clean default body style. Pure + exported so the wrapping is unit-tested.
 */
export function ensureHtmlDocument(html: string, title?: string): string {
  const isFull = /<!doctype/i.test(html) || /<html[\s>]/i.test(html);
  if (isFull) return html;
  const safeTitle = escAttr((title ?? 'Webpage').trim() || 'Webpage');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:0;padding:32px;line-height:1.55;color:#1a1a1a;background:#fff;max-width:920px;margin-inline:auto}
  h1,h2,h3{line-height:1.2}
  a{color:#2563eb}
  button{font:inherit;cursor:pointer}
</style></head><body>
${html}
</body></html>`;
}

export const webpageTool: ToolDefinition = {
  name: 'document.webpage',
  description:
    'Build a self-contained INTERACTIVE webpage from HTML and deliver it to the chat as an openable .html file ' +
    'plus an inline preview image. Use for "make me a webpage / landing page / website", an interactive widget, ' +
    'calculator, quiz, or mini web app — anything the user should be able to open and click. Buttons, forms and ' +
    'inline <script> work (unlike a PDF). Supply complete, self-contained `html` (inline the CSS/JS; avoid ' +
    'external CDNs so it works offline); a bare fragment is auto-wrapped in a responsive document.',
  category: 'document',
  timeout: 30_000,
  parameters: {
    html: { type: 'string', required: true, description: 'The page HTML. A full document or a bare fragment (auto-wrapped). Inline CSS/JS.' },
    title: { type: 'string', description: 'Optional page title (used for the <title> and the filename).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const html = typeof params['html'] === 'string' ? params['html'] : '';
    if (!html.trim()) {
      return { success: false, output: 'html must be a non-empty string (the page content).' };
    }
    if (html.length > MAX_HTML) {
      return { success: false, output: `html too long (max ${MAX_HTML} chars, got ${html.length}).` };
    }
    const title = typeof params['title'] === 'string' ? (params['title'] as string) : undefined;
    const doc = ensureHtmlDocument(html, title);

    const stamp = Date.now();
    const htmlPath = `/tmp/webpage-${stamp}.html`;
    const pngPath = `/tmp/webpage-${stamp}.png`;
    writeFileSync(htmlPath, doc, 'utf8');
    const htmlSize = statSync(htmlPath).size;

    logger.info({ session: ctx.sessionId, htmlSize, hasTitle: !!title }, 'document.webpage invoked');

    // Render a preview image — best-effort: the .html is the primary deliverable,
    // so a preview failure (e.g. a script error in the page) still returns success.
    let previewOk = false;
    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.setContent(doc, { waitUntil: 'load', timeout: 12_000 });
      await page.screenshot({ path: pngPath, type: 'png' });
      previewOk = statSync(pngPath).size > 0;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'webpage preview render failed (delivering .html only)');
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }

    const artifacts = [{ path: htmlPath, action: 'created' as const, size: htmlSize }];
    let output = `Interactive webpage saved to: ${htmlPath} (${htmlSize} bytes) — open it to interact.`;
    if (previewOk) {
      const pngSize = statSync(pngPath).size;
      artifacts.push({ path: pngPath, action: 'created', size: pngSize });
      output += ` A preview image saved to: ${pngPath}.`;
    }

    return { success: true, output, data: { htmlPath, ...(previewOk ? { previewPath: pngPath } : {}), bytes: htmlSize }, artifacts };
  },
};

export default webpageTool;
