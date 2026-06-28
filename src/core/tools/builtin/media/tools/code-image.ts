/**
 * @file code-image.ts
 * @description media.code-image — render a source-code snippet as a polished,
 * syntax-highlighted "window card" PNG (Carbon / ray.so style), delivered inline.
 * Highlighting runs in Node via highlight.js (its output is HTML-escaped and
 * wrapped in `hljs-*` token spans); a hand-tuned theme + a line-number gutter are
 * applied, and the gradient-framed card is rasterised to PNG via playwright-core
 * chromium (its own headless instance — same stack as data.chart / media.diagram,
 * no CDP collision). The "Code image saved to: <path>.png" output is picked up by
 * the loop's file-attachment extractor → inline image (web) / sendPhoto (telegram).
 */

import { statSync } from 'node:fs';
import hljs from 'highlight.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('media:code-image');

const MAX_LINES = 160;
const MAX_CHARS = 10_000;
const FONT_SIZE = 14;
const LINE_H = 22;

export type CodeTheme = 'dark' | 'light';

export interface CodeImageOpts {
  highlighted: string; // already-highlighted, HTML-safe markup (hljs .value)
  lineCount: number;
  language: string;
  title?: string;
  theme?: CodeTheme;
}

function esc(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/**
 * Highlight code in Node. When `language` is given and recognised it is used
 * verbatim (illegal sequences ignored so partial snippets still render); otherwise
 * the language is auto-detected. highlight.js escapes the code itself, so the
 * returned `html` is safe to embed directly. Pure + exported for unit testing.
 */
export function highlightCode(code: string, language?: string): { html: string; language: string } {
  const lang = language && hljs.getLanguage(language) ? language : undefined;
  if (lang) {
    const r = hljs.highlight(code, { language: lang, ignoreIllegals: true });
    return { html: r.value, language: lang };
  }
  const r = hljs.highlightAuto(code);
  return { html: r.value, language: r.language ?? 'plaintext' };
}

/** Per-theme palette: maps highlight.js token classes to colours. */
const THEMES: Record<CodeTheme, { frame: string; bg: string; fg: string; gutter: string; title: string; css: string }> = {
  dark: {
    frame: 'linear-gradient(135deg, #6d28d9 0%, #2563eb 100%)',
    bg: '#1e1e2e',
    fg: '#cdd6f4',
    gutter: '#585b70',
    title: '#a6adc8',
    css: `
      .hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-link,.hljs-tag,.hljs-meta-keyword { color:#ff79c6; }
      .hljs-string,.hljs-attribute,.hljs-template-string,.hljs-regexp,.hljs-addition { color:#f1fa8c; }
      .hljs-comment,.hljs-quote { color:#6272a4; font-style:italic; }
      .hljs-number,.hljs-symbol,.hljs-bullet { color:#bd93f9; }
      .hljs-built_in,.hljs-class .hljs-title,.hljs-type,.hljs-namespace { color:#8be9fd; }
      .hljs-function .hljs-title,.hljs-title.function_,.hljs-attr { color:#50fa7b; }
      .hljs-variable,.hljs-name,.hljs-params { color:#f8f8f2; }
      .hljs-meta,.hljs-comment .hljs-doctag { color:#6272a4; }
      .hljs-deletion { color:#ff5555; }`,
  },
  light: {
    frame: 'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
    bg: '#ffffff',
    fg: '#24292e',
    gutter: '#b0b6c0',
    title: '#57606a',
    css: `
      .hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-link,.hljs-tag { color:#d73a49; }
      .hljs-string,.hljs-attribute,.hljs-template-string,.hljs-regexp,.hljs-addition { color:#032f62; }
      .hljs-comment,.hljs-quote { color:#6a737d; font-style:italic; }
      .hljs-number,.hljs-symbol,.hljs-bullet { color:#005cc5; }
      .hljs-built_in,.hljs-class .hljs-title,.hljs-type,.hljs-namespace { color:#e36209; }
      .hljs-function .hljs-title,.hljs-title.function_,.hljs-attr { color:#6f42c1; }
      .hljs-variable,.hljs-name,.hljs-params { color:#24292e; }
      .hljs-meta { color:#6a737d; }
      .hljs-deletion { color:#b31d28; }`,
  },
};

/**
 * Build the full HTML document for the code card. A flex row pairs a line-number
 * gutter (generated from `lineCount`, so the highlighted markup is never split and
 * multi-line tokens stay intact) with the highlighted `<pre><code>`. The outer
 * `#shot` element is the gradient frame the renderer clips to. Pure + exported.
 */
export function buildCodeImageHtml(opts: CodeImageOpts): string {
  const theme = THEMES[opts.theme ?? 'dark'];
  const gutter = Array.from({ length: Math.max(1, opts.lineCount) }, (_, i) => `<span>${i + 1}</span>`).join('');
  const titleText = opts.title ? esc(opts.title) : esc(opts.language);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0f172a; }
  #shot { display:inline-block; padding:44px 52px; background:${theme.frame}; }
  .window { background:${theme.bg}; border-radius:12px; box-shadow:0 22px 60px rgba(0,0,0,0.45); overflow:hidden; min-width:340px; }
  .titlebar { display:flex; align-items:center; gap:8px; padding:14px 18px; }
  .dot { width:13px; height:13px; border-radius:50%; display:inline-block; }
  .red{background:#ff5f56;} .yellow{background:#ffbd2e;} .green{background:#27c93f;}
  .title { margin-left:12px; color:${theme.title}; font:500 13px 'Segoe UI',Arial,sans-serif; }
  .body { display:flex; padding:6px 22px 22px; font-family:'SFMono-Regular','JetBrains Mono','Consolas','Menlo',monospace; font-size:${FONT_SIZE}px; line-height:${LINE_H}px; }
  .gutter { display:flex; flex-direction:column; text-align:right; padding-right:20px; color:${theme.gutter}; user-select:none; }
  pre.code { margin:0; }
  pre.code code { color:${theme.fg}; white-space:pre; tab-size:2; }
  ${theme.css}
  </style></head><body><div id="shot"><div class="window">
  <div class="titlebar"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span><span class="title">${titleText}</span></div>
  <div class="body"><div class="gutter">${gutter}</div><pre class="code"><code>${opts.highlighted}</code></pre></div>
  </div></div></body></html>`;
}

export const codeImageTool: ToolDefinition = {
  name: 'media.code-image',
  description:
    'Render a source-code snippet as a polished, syntax-highlighted PNG image (a "code screenshot" with a ' +
    'window frame and line numbers — Carbon / ray.so style) and deliver it to the chat. Use for "make an ' +
    'image of this code", "code screenshot", "pretty/shareable code snippet". Supply the code; language is ' +
    'auto-detected if omitted.',
  category: 'media',
  timeout: 30_000,
  parameters: {
    code: { type: 'string', required: true, description: 'The source code to render.' },
    language: { type: 'string', description: 'Language hint (e.g. "typescript", "python"). Auto-detected if omitted.' },
    title: { type: 'string', description: 'Optional title shown in the window bar (e.g. a filename).' },
    theme: { type: 'string', description: "Colour theme: 'dark' (default) or 'light'." },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const code = params['code'];
    if (typeof code !== 'string' || code.trim().length === 0) {
      return { success: false, output: 'code must be a non-empty string.' };
    }
    if (code.length > MAX_CHARS) {
      return { success: false, output: `Code too long (max ${MAX_CHARS} chars, got ${code.length}).` };
    }
    const lineCount = code.split('\n').length;
    if (lineCount > MAX_LINES) {
      return { success: false, output: `Too many lines (max ${MAX_LINES}, got ${lineCount}).` };
    }
    const language = typeof params['language'] === 'string' ? (params['language'] as string) : undefined;
    const title = typeof params['title'] === 'string' ? (params['title'] as string) : undefined;
    const theme: CodeTheme = params['theme'] === 'light' ? 'light' : 'dark';

    const { html: highlighted, language: detected } = highlightCode(code, language);
    const html = buildCodeImageHtml({ highlighted, lineCount, language: detected, title, theme });
    const outPath = `/tmp/code-${Date.now()}.png`;

    logger.info({ session: ctx.sessionId, language: detected, lines: lineCount, theme }, 'media.code-image invoked');

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const context = await browser.newContext({ deviceScaleFactor: 2 }); // 2× → crisp text
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      const shot = page.locator('#shot');
      await shot.screenshot({ path: outPath, type: 'png' });
      const size = statSync(outPath).size;
      logger.info({ outPath, size, language: detected, lines: lineCount }, 'Code image PNG rendered');
      return {
        success: true,
        output: `Code image saved to: ${outPath} — delivered to the chat as an image (${detected}, ${lineCount} lines, ${size} bytes).`,
        data: { path: outPath, language: detected, lines: lineCount, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.code-image render failed');
      return { success: false, output: `Code image render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }
  },
};

export default codeImageTool;
