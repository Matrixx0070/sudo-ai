/**
 * Guards buildTreeSvg — the pure tree-layout core behind media.diagram. It must
 * emit one box per node, one connector per parent-child edge, escape user text,
 * size the canvas to the tree, and tolerate missing/self/forest parents — all
 * without a browser.
 */
import { describe, it, expect } from 'vitest';
import { buildTreeSvg } from '../../../../src/core/tools/builtin/media/tools/diagram.js';

const W = (s: string): number => parseInt(/width="(\d+)"/.exec(s)![1]!, 10);

describe('buildTreeSvg', () => {
  it('renders a box per node + a connector per parent-child edge', () => {
    const svg = buildTreeSvg(
      [{ id: 'a', label: 'CEO' }, { id: 'b', label: 'VP Eng', parent: 'a' }, { id: 'c', label: 'VP Sales', parent: 'a' }],
      'Org',
    );
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<rect/g) || []).length).toBeGreaterThanOrEqual(4); // bg + 3 node boxes
    expect((svg.match(/<path/g) || []).length).toBe(2); // 2 connectors
    expect(svg).toContain('CEO');
    expect(svg).toContain('VP Eng');
    expect(svg).toContain('Org');
  });

  it('treats a node with a missing or self parent as a root (no crash)', () => {
    const svg = buildTreeSvg([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', parent: 'zzz' }, // dangling parent → root
      { id: 'c', label: 'C', parent: 'c' }, // self parent → root
    ]);
    expect(svg).toContain('>A<');
    expect(svg).toContain('>B<');
    expect(svg).toContain('>C<');
  });

  it('escapes user-supplied labels and title', () => {
    const svg = buildTreeSvg([{ id: 'a', label: '<b>x</b>' }], 'a & "b"');
    expect(svg).not.toContain('<b>x</b>');
    expect(svg).toContain('&lt;b&gt;');
    expect(svg).toContain('&amp;');
  });

  it('grows the canvas width with the number of leaves', () => {
    const one = buildTreeSvg([{ id: 'a', label: 'A' }]);
    const four = buildTreeSvg([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', parent: 'a' },
      { id: 'c', label: 'C', parent: 'a' },
      { id: 'd', label: 'D', parent: 'a' },
    ]);
    expect(W(four)).toBeGreaterThan(W(one));
  });
});
