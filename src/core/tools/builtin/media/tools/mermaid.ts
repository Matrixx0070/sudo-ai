/**
 * @file mermaid.ts
 * @description media.mermaid — render a Mermaid diagram (flowchart, sequence, class,
 * state, ER, gantt, pie, mindmap, timeline, gitgraph…) to a PNG and deliver it
 * inline. The agent writes Mermaid DSL (which LLMs author fluently); we load
 * mermaid's self-contained browser bundle (mermaid.min.js, a UMD that exposes
 * window.mermaid) into a playwright-core chromium page, render the DSL to SVG with
 * securityLevel 'strict', and screenshot it. Far more expressive than media.diagram
 * (which only lays out a tree from a node list). "Diagram saved to: <path>.png" is
 * picked up by the loop's file-attachment extractor → inline image.
 */

import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('media:mermaid');

const MAX_DSL = 20_000;
const THEMES = new Set(['default', 'dark', 'forest', 'neutral']);

export type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral';

/** Validate the requested theme, defaulting to 'default'. Pure + exported. */
export function normalizeMermaidTheme(raw: unknown): MermaidTheme {
  return typeof raw === 'string' && THEMES.has(raw) ? (raw as MermaidTheme) : 'default';
}

/** Page background behind the diagram — dark for the dark theme, white otherwise. */
export function mermaidBackground(theme: MermaidTheme): string {
  return theme === 'dark' ? '#1e1e2e' : '#ffffff';
}

export const mermaidTool: ToolDefinition = {
  name: 'media.mermaid',
  description:
    'Render a Mermaid diagram as a PNG image and deliver it to the chat. Use for a FLOWCHART, sequence ' +
    'diagram, class diagram, state diagram, entity-relationship (ER) diagram of a database schema, gantt chart, ' +
    'pie chart, mindmap, timeline, user journey, or gitgraph — anything expressible in Mermaid syntax. Supply the Mermaid DSL in ' +
    '`diagram` (e.g. "flowchart TD\\n A-->B"). For a simple org-chart/tree from a flat node list, use ' +
    'media.diagram instead.',
  category: 'media',
  timeout: 30_000,
  parameters: {
    diagram: { type: 'string', required: true, description: 'The Mermaid diagram definition (DSL), e.g. "sequenceDiagram\\n Alice->>Bob: Hi".' },
    theme: { type: 'string', description: "Mermaid theme: 'default' (default), 'dark', 'forest', or 'neutral'." },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const diagram = typeof params['diagram'] === 'string' ? params['diagram'] : '';
    if (!diagram.trim()) {
      return { success: false, output: 'diagram must be a non-empty Mermaid definition (e.g. "flowchart TD\\n A-->B").' };
    }
    if (diagram.length > MAX_DSL) {
      return { success: false, output: `diagram too long (max ${MAX_DSL} chars, got ${diagram.length}).` };
    }
    const theme = normalizeMermaidTheme(params['theme']);
    const bg = mermaidBackground(theme);
    const outPath = `/tmp/mermaid-${Date.now()}.png`;

    let mermaidPath: string;
    try {
      mermaidPath = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');
    } catch {
      return { success: false, output: 'Mermaid renderer is unavailable (mermaid package not found).' };
    }

    logger.info({ session: ctx.sessionId, len: diagram.length, theme }, 'media.mermaid invoked');

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"></head>` +
        `<body style="margin:0;background:${bg}"><div id="wrap" style="display:inline-block;padding:24px;background:${bg}"><div id="out"></div></div></body></html>`,
        { waitUntil: 'load', timeout: 10_000 },
      );
      await page.addScriptTag({ path: mermaidPath });

      const result = await page.evaluate(
        async ({ dsl, themeName }) => {
          const mermaid = (window as unknown as { mermaid?: { initialize: (c: unknown) => void; render: (id: string, t: string) => Promise<{ svg: string }> } }).mermaid;
          if (!mermaid) return { ok: false, err: 'mermaid bundle did not load' };
          try {
            mermaid.initialize({ startOnLoad: false, theme: themeName, securityLevel: 'strict' });
            const { svg } = await mermaid.render('graphDiv', dsl);
            const out = document.getElementById('out');
            if (out) out.innerHTML = svg;
            return { ok: true };
          } catch (e) {
            return { ok: false, err: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
          }
        },
        { dsl: diagram, themeName: theme },
      );

      if (!result.ok) {
        return { success: false, output: `Mermaid could not parse the diagram: ${result.err}. Check the syntax (e.g. the diagram type on line 1).` };
      }

      await page.locator('#wrap').screenshot({ path: outPath, type: 'png' });
      const size = statSync(outPath).size;
      logger.info({ outPath, size, theme }, 'Mermaid diagram rendered');
      return {
        success: true,
        output: `Diagram saved to: ${outPath} — delivered to the chat as an image (${size} bytes).`,
        data: { path: outPath, theme, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.mermaid render failed');
      return { success: false, output: `Mermaid render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }
  },
};

export default mermaidTool;
