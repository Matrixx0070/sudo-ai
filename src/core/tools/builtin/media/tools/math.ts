/**
 * @file math.ts
 * @description media.math — render a LaTeX math expression (equation, formula)
 * to a clean inline PNG. KaTeX renders the markup in Node (renderToString); its
 * stylesheet is made fully self-contained by base64-embedding the woff2 web fonts
 * (so the headless page needs no network / file access), then the equation card is
 * rasterised to PNG via playwright-core chromium (its own headless instance — same
 * stack as data.chart / media.code-image, no CDP collision). The "Equation saved
 * to: <path>.png" output is picked up by the loop's file-attachment extractor →
 * inline image (web) / sendPhoto (telegram).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import katex from 'katex';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('media:math');

const MAX_LATEX = 2_000;

export type MathTheme = 'light' | 'dark';

export interface MathHtmlOpts {
  mathHtml: string; // katex.renderToString output
  theme?: MathTheme;
}

/**
 * KaTeX's CSS references its web fonts by relative URL. Inline the woff2 files as
 * base64 data URIs once (module-cached) so a setContent page with no origin can
 * still load the math fonts — without this, glyphs (√, ∫, fractions, Greek) fall
 * back to system fonts and render wrong.
 */
let _cssCache: string | null = null;
function getEmbeddedKatexCss(): string {
  if (_cssCache !== null) return _cssCache;
  const require = createRequire(import.meta.url);
  const cssPath = require.resolve('katex/dist/katex.min.css');
  const fontsDir = join(dirname(cssPath), 'fonts');
  const raw = readFileSync(cssPath, 'utf8');
  _cssCache = raw.replace(/url\((['"]?)fonts\/([^'")]+\.woff2)\1\)/g, (_m, _q, file: string) => {
    try {
      const b64 = readFileSync(join(fontsDir, file)).toString('base64');
      return `url(data:font/woff2;base64,${b64})`;
    } catch {
      return `url(fonts/${file})`; // leave as-is if a font is missing
    }
  });
  return _cssCache;
}

/**
 * Render the LaTeX to KaTeX HTML. `throwOnError:false` makes KaTeX render invalid
 * input as red error text instead of throwing, so the tool always returns an image
 * the user can read (and see what was wrong). Thin wrapper, exported for testing.
 */
export function renderMathToHtml(latex: string, displayMode = true): string {
  return katex.renderToString(latex, { displayMode, throwOnError: false, output: 'html' });
}

/**
 * Build the self-contained HTML document for the equation card. Pure (takes the
 * pre-rendered KaTeX HTML) + exported so structure/theme are unit-tested without a
 * browser. The `#shot` element is the padded card the renderer clips to.
 */
export function buildMathHtml(opts: MathHtmlOpts): string {
  const dark = opts.theme === 'dark';
  const bg = dark ? '#0f172a' : '#ffffff';
  const fg = dark ? '#f1f5f9' : '#1a1a1a';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${getEmbeddedKatexCss()}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${dark ? '#1e293b' : '#e2e8f0'}; }
  #shot { display:inline-block; background:${bg}; color:${fg}; padding:40px 56px; border-radius:14px;
          box-shadow:0 16px 44px rgba(0,0,0,${dark ? '0.5' : '0.14'}); }
  #shot .katex { font-size:34px; color:${fg}; }
  </style></head><body><div id="shot">${opts.mathHtml}</div></body></html>`;
}

export const mathTool: ToolDefinition = {
  name: 'media.equation',
  description:
    'Render a mathematical EQUATION or formula (written in LaTeX) as a clean PNG image and deliver it to the ' +
    'chat — properly typeset math notation: fractions, √, ∫, Σ, Greek letters, matrices. Use for ' +
    '"render this equation", "show the quadratic formula", "make an image of this math". Supply the LaTeX ' +
    'without $ delimiters, e.g. "x = \\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}".',
  category: 'media',
  timeout: 30_000,
  parameters: {
    latex: { type: 'string', required: true, description: 'The LaTeX math expression (no $ delimiters).' },
    displayMode: { type: 'boolean', description: 'Block/centered display style (default true); false = inline style.' },
    theme: { type: 'string', description: "Colour theme: 'light' (default) or 'dark'." },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const latex = params['latex'];
    if (typeof latex !== 'string' || latex.trim().length === 0) {
      return { success: false, output: 'latex must be a non-empty LaTeX math string (no $ delimiters).' };
    }
    if (latex.length > MAX_LATEX) {
      return { success: false, output: `LaTeX too long (max ${MAX_LATEX} chars, got ${latex.length}).` };
    }
    const displayMode = params['displayMode'] !== false;
    const theme: MathTheme = params['theme'] === 'dark' ? 'dark' : 'light';

    let mathHtml: string;
    try {
      mathHtml = renderMathToHtml(latex, displayMode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Could not parse the LaTeX: ${msg}` };
    }
    const html = buildMathHtml({ mathHtml, theme });
    const outPath = `/tmp/equation-${Date.now()}.png`;

    logger.info({ session: ctx.sessionId, len: latex.length, displayMode, theme }, 'media.math invoked');

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const context = await browser.newContext({ deviceScaleFactor: 2 }); // 2× → crisp glyphs
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      await page.locator('#shot').screenshot({ path: outPath, type: 'png' });
      const { statSync } = await import('node:fs');
      const size = statSync(outPath).size;
      logger.info({ outPath, size }, 'Equation PNG rendered');
      return {
        success: true,
        output: `Equation saved to: ${outPath} — delivered to the chat as an image (${size} bytes).`,
        data: { path: outPath, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.math render failed');
      return { success: false, output: `Equation render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }
  },
};

export default mathTool;
