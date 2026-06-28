/**
 * @file diagram.ts
 * @description media.diagram — render a tree / hierarchy diagram (org chart, mind
 * map, decision tree, file tree…) from a flat node list as a PNG image, delivered
 * inline. Layout is a leaf-count tree placement (each subtree reserves slots equal
 * to its leaf count → no overlap), drawn as a self-contained inline SVG and
 * rasterised to PNG via playwright-core chromium (its own headless instance, the
 * same stack as data.chart / media.qr — no CDP collision). The "Diagram saved to:
 * <path>.png" output is picked up by the loop's file-attachment extractor.
 */

import { statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('media:diagram');

export interface DiagramNodeInput {
  id: string;
  label: string;
  parent?: string | null;
}

interface LaidNode {
  id: string;
  label: string;
  children: LaidNode[];
  x: number; // slot units (leaf index space)
  depth: number;
}

const MAX_NODES = 60;
const MAX_DEPTH = 8;
const SLOT_W = 168;
const LEVEL_H = 92;
const BOX_H = 40;
const MAX_BOX_W = 150;
const PAD = 28;
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

function esc(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** ~7px per char at 13px; truncate to fit a box. */
function clip(label: string): string {
  const max = Math.floor((MAX_BOX_W - 16) / 7);
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

/**
 * Build the laid-out forest (roots) from a flat node list. Cycles and dangling
 * parents are tolerated (a node whose parent is missing/self/cyclic becomes a
 * root). Returns the roots plus the total leaf count + max depth used for sizing.
 */
function layout(nodes: DiagramNodeInput[]): { roots: LaidNode[]; leaves: number; maxDepth: number } {
  const byId = new Map<string, LaidNode>();
  for (const n of nodes) byId.set(n.id, { id: n.id, label: n.label, children: [], x: 0, depth: 0 });

  const hasParent = new Set<string>();
  for (const n of nodes) {
    const parent = n.parent && n.parent !== n.id ? byId.get(n.parent) : undefined;
    const self = byId.get(n.id)!;
    if (parent) { parent.children.push(self); hasParent.add(n.id); }
  }
  // Roots = nodes with no resolvable parent (preserve input order).
  const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => byId.get(n.id)!);

  let cursor = 0;
  let maxDepth = 0;
  const seen = new Set<string>();
  const assign = (node: LaidNode, depth: number): void => {
    if (seen.has(node.id)) { node.x = cursor++; return; } // cycle guard
    seen.add(node.id);
    node.depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    if (depth >= MAX_DEPTH || node.children.length === 0) {
      node.x = cursor++;
    } else {
      for (const c of node.children) assign(c, depth + 1);
      node.x = (node.children[0]!.x + node.children[node.children.length - 1]!.x) / 2;
    }
  };
  for (const r of roots) assign(r, 0);
  return { roots, leaves: Math.max(1, cursor), maxDepth };
}

/** Pure: render a tree/hierarchy to a self-contained SVG string. */
export function buildTreeSvg(nodes: DiagramNodeInput[], title?: string): string {
  const { roots, leaves, maxDepth } = layout(nodes);
  const titleH = title ? 40 : 0;
  const width = PAD * 2 + leaves * SLOT_W;
  const height = PAD * 2 + titleH + (maxDepth + 1) * LEVEL_H;
  const cx = (n: LaidNode): number => PAD + n.x * SLOT_W + SLOT_W / 2;
  const cy = (n: LaidNode): number => PAD + titleH + n.depth * LEVEL_H;

  const lines: string[] = [];
  const boxes: string[] = [];
  let idx = 0;
  const walk = (node: LaidNode): void => {
    const x = cx(node), y = cy(node);
    const label = clip(node.label);
    const bw = Math.min(MAX_BOX_W, label.length * 7 + 22);
    const color = PALETTE[node.depth % PALETTE.length]!;
    for (const c of node.children) {
      lines.push(`<path d="M ${x.toFixed(1)} ${y + BOX_H} C ${x.toFixed(1)} ${y + BOX_H + LEVEL_H / 2}, ${cx(c).toFixed(1)} ${cy(c) - LEVEL_H / 2}, ${cx(c).toFixed(1)} ${cy(c)}" fill="none" stroke="#94a3b8" stroke-width="1.5"/>`);
    }
    boxes.push(
      `<g><rect x="${(x - bw / 2).toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${BOX_H}" rx="7" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="1.5"/>` +
      `<text x="${x.toFixed(1)}" y="${y + BOX_H / 2 + 4}" text-anchor="middle" font-size="13" fill="#0f172a">${esc(label)}</text></g>`,
    );
    if (++idx > MAX_NODES) return;
    for (const c of node.children) walk(c);
  };
  for (const r of roots) walk(r);

  const titleEl = title
    ? `<text x="${width / 2}" y="28" text-anchor="middle" font-size="20" font-weight="bold" fill="#0f172a">${esc(title)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${titleEl}
  ${lines.join('\n')}
  ${boxes.join('\n')}
</svg>`;
}

export const diagramTool: ToolDefinition = {
  name: 'media.diagram',
  description:
    'Render a tree/hierarchy DIAGRAM as a PNG image and deliver it to the chat — org charts, mind maps, ' +
    'hierarchies, decision trees, file trees. Use for "org chart", "mind map", "tree diagram", "hierarchy". ' +
    'Pass a flat list of nodes; each node has an id, a label, and (except roots) the parent node id.',
  category: 'media',
  timeout: 30_000,
  parameters: {
    nodes: {
      type: 'array',
      required: true,
      description: 'Flat node list. A node with no parent (or an unknown parent) is a root.',
      items: {
        type: 'object',
        description: 'A node: { id, label, parent? }.',
        properties: {
          id: { type: 'string', description: 'Unique node id.' },
          label: { type: 'string', description: 'Text shown in the node box.' },
          parent: { type: 'string', description: "Parent node's id (omit for a root)." },
        },
      },
    },
    title: { type: 'string', description: 'Optional diagram title.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = params['nodes'];
    const title = typeof params['title'] === 'string' ? (params['title'] as string) : undefined;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { success: false, output: 'nodes must be a non-empty array of { id, label, parent? }.' };
    }
    if (raw.length > MAX_NODES) {
      return { success: false, output: `Too many nodes (max ${MAX_NODES}, got ${raw.length}).` };
    }
    const nodes: DiagramNodeInput[] = [];
    for (const r of raw as Array<Record<string, unknown>>) {
      const id = r?.['id'];
      const label = r?.['label'];
      if (typeof id !== 'string' || typeof label !== 'string') {
        return { success: false, output: 'each node needs a string id and a string label.' };
      }
      nodes.push({ id, label, ...(typeof r['parent'] === 'string' ? { parent: r['parent'] } : {}) });
    }

    logger.info({ session: ctx.sessionId, nodes: nodes.length }, 'media.diagram invoked');

    const svg = buildTreeSvg(nodes, title);
    const wMatch = /width="(\d+)"/.exec(svg);
    const hMatch = /height="(\d+)"/.exec(svg);
    const w = Math.min(2400, wMatch ? parseInt(wMatch[1]!, 10) : 800);
    const h = Math.min(1600, hMatch ? parseInt(hMatch[1]!, 10) : 600);
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#fff">${svg}</body></html>`;
    const outPath = `/tmp/diagram-${Date.now()}.png`;

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setViewportSize({ width: w, height: h });
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      await page.screenshot({ path: outPath, type: 'png' });
      const size = statSync(outPath).size;
      logger.info({ outPath, size, nodes: nodes.length }, 'Diagram PNG rendered');
      return {
        success: true,
        output: `Diagram saved to: ${outPath} — delivered to the chat as an image (${nodes.length} nodes, ${size} bytes).`,
        data: { path: outPath, nodes: nodes.length, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.diagram render failed');
      return { success: false, output: `Diagram render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }
  },
};

export default diagramTool;
