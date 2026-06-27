/**
 * Guards buildChartSvg — the pure chart-geometry builder behind data.chart.
 * It must emit valid SVG with the right primitives per type, label/value text,
 * escaped user strings, and graceful edge handling — all without a browser.
 */
import { describe, it, expect } from 'vitest';
import { buildChartSvg } from '../../../../src/core/tools/builtin/media/tools/chart.js';

describe('buildChartSvg', () => {
  it('renders a bar chart with rects, labels, values and title', () => {
    const svg = buildChartSvg({ type: 'bar', labels: ['Jan', 'Feb'], values: [10, 20], title: 'Sales' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="800"');
    expect(svg).toContain('<rect'); // bars
    expect(svg).toContain('Jan');
    expect(svg).toContain('Feb');
    expect(svg).toContain('Sales');
    expect(svg).toContain('>20<'); // value label
  });

  it('renders a line chart with a polyline + point markers', () => {
    const svg = buildChartSvg({ type: 'line', labels: ['a', 'b', 'c'], values: [1, 5, 3] });
    expect(svg).toContain('<polyline');
    expect(svg).toContain('<circle');
  });

  it('renders a pie chart with slice paths and legend percentages', () => {
    const svg = buildChartSvg({ type: 'pie', labels: ['X', 'Y'], values: [1, 3] });
    expect(svg).toContain('<path'); // arc slices
    expect(svg).toContain('(25%)');
    expect(svg).toContain('(75%)');
  });

  it('draws a full circle for a single-slice pie (degenerate arc)', () => {
    const svg = buildChartSvg({ type: 'pie', labels: ['only'], values: [42] });
    expect(svg).toContain('<circle');
  });

  it('handles an all-zero pie without crashing', () => {
    const svg = buildChartSvg({ type: 'pie', labels: ['a', 'b'], values: [0, 0] });
    expect(svg).toContain('No positive values');
  });

  it('escapes user-supplied label/title text (no raw markup injection)', () => {
    const svg = buildChartSvg({ type: 'bar', labels: ['<b>x</b>'], values: [1], title: 'a & "b"' });
    expect(svg).not.toContain('<b>x</b>');
    expect(svg).toContain('&lt;b&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&quot;');
  });

  it('only plots as many points as the shorter of labels/values', () => {
    const svg = buildChartSvg({ type: 'bar', labels: ['a', 'b', 'c'], values: [1] });
    expect(svg).toContain('>a<');
    expect(svg).not.toContain('>b<'); // dropped (no matching value)
  });
});
