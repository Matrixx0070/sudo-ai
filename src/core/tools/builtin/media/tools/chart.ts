/**
 * @file chart.ts
 * @description data.chart — render a bar/line/pie chart from inline data to a PNG
 * image and deliver it to the chat. Distinct from spreadsheet.chart (which only
 * records chart *metadata* into an .xlsx). The chart is drawn as a self-contained
 * inline SVG (no external/CDN dependency, deterministic) and rasterised to PNG via
 * playwright-core's chromium (its own headless instance — the same stack as
 * document.pdf-from-html). The "Chart saved to: <path>.png" output is picked up by
 * the agent loop's file-attachment extractor → delivered inline as an image.
 */

import { statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('media:chart');

export type ChartType = 'bar' | 'line' | 'pie';

export interface ChartSpec {
  type: ChartType;
  labels: string[];
  values: number[];
  title?: string;
}

const CHART_W = 800;
const CHART_H = 500;
const PAD_L = 64;
const PAD_R = 32;
const PAD_T = 56;
const PAD_B = 72;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;
const PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'];

function esc(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** Round to a tidy 2-dp string (drops trailing zeros). */
function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function barOrLine(type: 'bar' | 'line', labels: string[], values: number[]): string {
  const n = values.length;
  const maxV = Math.max(0, ...values);
  const scale = maxV > 0 ? PLOT_H / maxV : 0;
  const baseY = PAD_T + PLOT_H;
  const parts: string[] = [];

  // Axes + a few horizontal gridlines with value ticks.
  parts.push(`<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${baseY}" stroke="#cbd5e1"/>`);
  parts.push(`<line x1="${PAD_L}" y1="${baseY}" x2="${PAD_L + PLOT_W}" y2="${baseY}" stroke="#cbd5e1"/>`);
  for (let g = 1; g <= 4; g++) {
    const y = PAD_T + (PLOT_H * g) / 4;
    const val = maxV * (1 - g / 4);
    parts.push(`<line x1="${PAD_L}" y1="${y}" x2="${PAD_L + PLOT_W}" y2="${y}" stroke="#eef2f7"/>`);
    parts.push(`<text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#64748b">${esc(fmt(val))}</text>`);
  }

  if (type === 'bar') {
    const slot = PLOT_W / n;
    const bw = slot * 0.62;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, values[i]!);
      const h = v * scale;
      const x = PAD_L + i * slot + (slot - bw) / 2;
      const y = baseY - h;
      parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(bw)}" height="${fmt(h)}" rx="3" fill="${PALETTE[i % PALETTE.length]}"/>`);
      parts.push(`<text x="${fmt(x + bw / 2)}" y="${fmt(y - 6)}" text-anchor="middle" font-size="11" fill="#334155">${esc(fmt(values[i]!))}</text>`);
      parts.push(`<text x="${fmt(x + bw / 2)}" y="${baseY + 18}" text-anchor="middle" font-size="12" fill="#475569">${esc(labels[i] ?? '')}</text>`);
    }
  } else {
    const stepX = n > 1 ? PLOT_W / (n - 1) : 0;
    const pts = values.map((v, i) => `${fmt(PAD_L + i * stepX)},${fmt(baseY - Math.max(0, v) * scale)}`);
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${PALETTE[0]}" stroke-width="2.5"/>`);
    for (let i = 0; i < n; i++) {
      const cx = PAD_L + i * stepX;
      const cy = baseY - Math.max(0, values[i]!) * scale;
      parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="3.5" fill="${PALETTE[0]}"/>`);
      parts.push(`<text x="${fmt(cx)}" y="${fmt(cy - 8)}" text-anchor="middle" font-size="11" fill="#334155">${esc(fmt(values[i]!))}</text>`);
      parts.push(`<text x="${fmt(cx)}" y="${baseY + 18}" text-anchor="middle" font-size="12" fill="#475569">${esc(labels[i] ?? '')}</text>`);
    }
  }
  return parts.join('\n');
}

function pie(labels: string[], values: number[]): string {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  const cx = PAD_L + PLOT_W * 0.36;
  const cy = PAD_T + PLOT_H / 2;
  const r = Math.min(PLOT_W * 0.32, PLOT_H / 2 - 6);
  const parts: string[] = [];
  if (total <= 0) return `<text x="${CHART_W / 2}" y="${cy}" text-anchor="middle" font-size="14" fill="#64748b">No positive values to plot</text>`;

  let a0 = 0;
  for (let i = 0; i < values.length; i++) {
    const frac = Math.max(0, values[i]!) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const x0 = cx + r * Math.sin(a0), y0 = cy - r * Math.cos(a0);
    const x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const color = PALETTE[i % PALETTE.length];
    // A full single slice would degenerate the arc — draw a circle instead.
    if (frac >= 0.999) {
      parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${color}"/>`);
    } else {
      parts.push(`<path d="M ${fmt(cx)} ${fmt(cy)} L ${fmt(x0)} ${fmt(y0)} A ${fmt(r)} ${fmt(r)} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)} Z" fill="${color}"/>`);
    }
    // Legend entry.
    const ly = PAD_T + 8 + i * 22;
    const lx = PAD_L + PLOT_W * 0.72;
    parts.push(`<rect x="${lx}" y="${ly}" width="14" height="14" rx="2" fill="${color}"/>`);
    parts.push(`<text x="${lx + 20}" y="${ly + 12}" font-size="12" fill="#334155">${esc(labels[i] ?? '')} (${fmt(frac * 100)}%)</text>`);
    a0 = a1;
  }
  return parts.join('\n');
}

/**
 * Build a self-contained SVG string for the chart. Pure + exported so the chart
 * geometry is unit-tested without launching a browser.
 */
export function buildChartSvg(spec: ChartSpec): string {
  const n = Math.min(spec.labels.length, spec.values.length);
  const labels = spec.labels.slice(0, n);
  const values = spec.values.slice(0, n);
  const body = spec.type === 'pie' ? pie(labels, values) : barOrLine(spec.type, labels, values);
  const title = spec.title
    ? `<text x="${CHART_W / 2}" y="34" text-anchor="middle" font-size="22" font-weight="bold" fill="#0f172a">${esc(spec.title)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_W}" height="${CHART_H}" viewBox="0 0 ${CHART_W} ${CHART_H}" font-family="Arial, Helvetica, sans-serif">
  <rect width="${CHART_W}" height="${CHART_H}" fill="#ffffff"/>
  ${title}
  ${body}
</svg>`;
}

export const chartTool: ToolDefinition = {
  name: 'data.chart',
  description:
    'Render a bar, line, or pie chart from inline data as a PNG IMAGE and deliver it to the user in the chat. ' +
    'Use this to "chart", "plot", "graph", or "visualize" numbers. Pass parallel `labels` and `values` arrays. ' +
    '(Distinct from spreadsheet.chart, which only records chart metadata into an .xlsx file.)',
  category: 'data',
  timeout: 30_000,
  parameters: {
    chartType: {
      type: 'string',
      required: true,
      description: 'Chart type.',
      enum: ['bar', 'line', 'pie'],
    },
    labels: {
      type: 'array',
      required: true,
      description: 'Category labels, one per data point (e.g. ["Jan","Feb","Mar"]).',
      items: { type: 'string', description: 'A category label.' },
    },
    values: {
      type: 'array',
      required: true,
      description: 'Numeric values, parallel to labels (e.g. [10, 20, 15]).',
      items: { type: 'number', description: 'A numeric value.' },
    },
    title: {
      type: 'string',
      description: 'Optional chart title.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const chartType = params['chartType'] as ChartType | undefined;
    const labels = params['labels'] as unknown;
    const rawValues = params['values'] as unknown;
    const title = typeof params['title'] === 'string' ? (params['title'] as string) : undefined;

    if (!chartType || !['bar', 'line', 'pie'].includes(chartType)) {
      return { success: false, output: 'chartType must be one of: bar, line, pie.' };
    }
    if (!Array.isArray(labels) || !Array.isArray(rawValues)) {
      return { success: false, output: 'labels and values must both be arrays.' };
    }
    const values = (rawValues as unknown[]).map((v) => Number(v));
    if (values.some((v) => !Number.isFinite(v))) {
      return { success: false, output: 'values must all be finite numbers.' };
    }
    const labelStrs = (labels as unknown[]).map((l) => String(l));
    const n = Math.min(labelStrs.length, values.length);
    if (n === 0) {
      return { success: false, output: 'Provide at least one (label, value) pair.' };
    }
    if (n > 40) {
      return { success: false, output: 'Too many data points (max 40 for a readable chart).' };
    }

    logger.info({ session: ctx.sessionId, chartType, points: n }, 'data.chart invoked');

    const svg = buildChartSvg({ type: chartType, labels: labelStrs, values, ...(title ? { title } : {}) });
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0">${svg}</body></html>`;
    const outPath = `/tmp/chart-${Date.now()}.png`;

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setViewportSize({ width: CHART_W, height: CHART_H });
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      await page.screenshot({ path: outPath, type: 'png' });
      const size = statSync(outPath).size;
      logger.info({ outPath, size, chartType }, 'Chart PNG rendered');
      return {
        success: true,
        output: `Chart saved to: ${outPath} — delivered to the chat as an image (${chartType} chart, ${n} data points, ${size} bytes).`,
        data: { path: outPath, chartType, points: n, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'data.chart render failed');
      return { success: false, output: `Chart render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
    }
  },
};

export default chartTool;
