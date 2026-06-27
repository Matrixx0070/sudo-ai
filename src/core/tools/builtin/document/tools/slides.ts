/**
 * @file slides.ts
 * @description document.slides — render a slide deck (title + bullet slides) into
 * a styled 16:9 multi-page PDF, delivered inline. Complements
 * content.presentation-builder (which only returns a TEXT outline): the agent
 * supplies slide content, this renders the deck. Each slide is a full 1280×720
 * page; the HTML is rasterised to a multi-page PDF via playwright-core chromium
 * (its own headless instance — same stack as document.pdf-from-html / data.chart).
 * "Presentation saved to: <path>.pdf" is picked up by the file-attachment extractor.
 */

import { statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('document:slides');

export interface SlideInput {
  title: string;
  bullets?: string[];
}

const SLIDE_W = 1280;
const SLIDE_H = 720;
const MAX_SLIDES = 40;
const MAX_BULLETS = 8;
const ACCENT = '#2563eb';

function esc(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/**
 * Build the deck HTML. Pure + exported so the slide structure is unit-tested
 * without launching a browser. Each slide is a page-breaking 1280×720 section.
 */
export function buildSlidesHtml(slides: SlideInput[], deckTitle?: string, subtitle?: string): string {
  const sections: string[] = [];

  if (deckTitle) {
    sections.push(
      `<section class="slide title-slide"><div><h1>${esc(deckTitle)}</h1>` +
      (subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : '') +
      `</div></section>`,
    );
  }

  slides.forEach((s, i) => {
    const bullets = (s.bullets ?? []).slice(0, MAX_BULLETS).filter((b) => String(b).trim().length > 0);
    const list = bullets.length ? `<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
    sections.push(
      `<section class="slide"><div class="accent"></div>` +
      `<h2>${esc(s.title)}</h2>${list}` +
      `<div class="footer"><span>${deckTitle ? esc(deckTitle) : ''}</span><span>${i + 1} / ${slides.length}</span></div></section>`,
    );
  });

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; color: #0f172a; }
  .slide { width: ${SLIDE_W}px; height: ${SLIDE_H}px; page-break-after: always; position: relative;
           padding: 72px 88px; overflow: hidden; background: #ffffff; display: flex; flex-direction: column; }
  .slide:last-child { page-break-after: auto; }
  .title-slide { background: linear-gradient(135deg, ${ACCENT}, #1e3a8a); color: #fff;
                 align-items: center; justify-content: center; text-align: center; }
  .title-slide h1 { font-size: 68px; font-weight: 800; line-height: 1.1; }
  .title-slide .subtitle { font-size: 30px; margin-top: 28px; opacity: 0.9; font-weight: 400; }
  .accent { position: absolute; top: 0; left: 0; width: 100%; height: 12px; background: ${ACCENT}; }
  .slide h2 { font-size: 46px; font-weight: 700; color: ${ACCENT}; margin: 18px 0 36px; }
  .slide ul { list-style: none; }
  .slide li { font-size: 30px; line-height: 1.5; margin-bottom: 22px; padding-left: 40px; position: relative; }
  .slide li::before { content: '▸'; color: ${ACCENT}; position: absolute; left: 0; }
  .footer { position: absolute; bottom: 34px; left: 88px; right: 88px; display: flex;
            justify-content: space-between; font-size: 16px; color: #94a3b8; }
  </style></head><body>${sections.join('')}</body></html>`;
}

/**
 * Coerce the model's `slides` argument into a clean SlideInput[]. LLMs frequently
 * pass a deeply-nested array (objects containing a nested `bullets` array) as a
 * JSON STRING, and sometimes pass `bullets` itself as a string — normalise both,
 * skipping malformed entries. Returns [] when nothing usable is found.
 */
export function normalizeSlidesArg(raw: unknown): SlideInput[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];

  const out: SlideInput[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['title'] !== 'string' || !o['title'].trim()) continue;
    let b: unknown = o['bullets'];
    if (typeof b === 'string') {
      try { b = JSON.parse(b); } catch { b = (b as string).split('\n'); }
    }
    const bullets = Array.isArray(b) ? b.map((x) => String(x)).filter((x) => x.trim().length > 0) : [];
    out.push({ title: o['title'], bullets });
  }
  return out;
}

export const slidesTool: ToolDefinition = {
  name: 'document.slides',
  description:
    'Render a slide deck / presentation as a multi-page 16:9 PDF and deliver it to the chat. ' +
    'Use for "make a presentation", "slide deck", "slides about X". Supply the slide content as an array of ' +
    '{ title, bullets[] }; an optional deck title becomes a styled title slide. (Pair with ' +
    'content.presentation-builder to draft the outline first.)',
  category: 'document',
  timeout: 45_000,
  parameters: {
    slides: {
      type: 'array',
      required: true,
      description: 'The content slides, in order.',
      items: {
        type: 'object',
        description: 'A slide: { title, bullets[] }.',
        properties: {
          title: { type: 'string', description: 'Slide heading.' },
          bullets: { type: 'array', description: 'Bullet points (≤8).', items: { type: 'string', description: 'A bullet point.' } },
        },
      },
    },
    title: { type: 'string', description: 'Optional deck title — becomes a styled title slide.' },
    subtitle: { type: 'string', description: 'Optional subtitle for the title slide.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const deckTitle = typeof params['title'] === 'string' ? (params['title'] as string) : undefined;
    const subtitle = typeof params['subtitle'] === 'string' ? (params['subtitle'] as string) : undefined;

    const slides = normalizeSlidesArg(params['slides']);
    if (slides.length === 0) {
      return { success: false, output: 'slides must be a non-empty array of { title, bullets[] } (a JSON string of that array is also accepted).' };
    }
    if (slides.length > MAX_SLIDES) {
      return { success: false, output: `Too many slides (max ${MAX_SLIDES}, got ${slides.length}).` };
    }

    logger.info({ session: ctx.sessionId, slides: slides.length }, 'document.slides invoked');

    const html = buildSlidesHtml(slides, deckTitle, subtitle);
    const totalPages = slides.length + (deckTitle ? 1 : 0);
    const outPath = `/tmp/slides-${Date.now()}.pdf`;

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
      await page.pdf({ path: outPath, width: `${SLIDE_W}px`, height: `${SLIDE_H}px`, printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
      const size = statSync(outPath).size;
      logger.info({ outPath, size, pages: totalPages }, 'Slide deck PDF rendered');
      return {
        success: true,
        output: `Presentation saved to: ${outPath} — delivered to the chat as a ${totalPages}-slide PDF (${size} bytes).`,
        data: { path: outPath, pages: totalPages, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'document.slides render failed');
      return { success: false, output: `Slide render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }
  },
};

export default slidesTool;
