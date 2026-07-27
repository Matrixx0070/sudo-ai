/**
 * Unit coverage for browser.snapshot's `selector` param (added to fix a live
 * doom-loop: ariaSnapshot() is DOM-order, not scroll-position-relative, so an
 * unscoped snapshot on a long page returns the identical truncated head no
 * matter how much the page has been scrolled — the model just kept retrying
 * scroll+re-snapshot forever). Mocks BrowserManager/resolveActivePage so this
 * exercises the tool's own param plumbing and messaging without a real browser
 * (the e2e large-page test already covers the clamp/ref-ordering behavior).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../../src/core/tools/types.js';

const ariaSnapshotMock = vi.fn().mockResolvedValue('- heading: Body root');
const mockPage = {
  locator: vi.fn().mockReturnValue({ ariaSnapshot: ariaSnapshotMock }),
  url: vi.fn().mockReturnValue('https://example.com'),
  title: vi.fn().mockResolvedValue('Example'),
  frames: vi.fn().mockReturnValue([]), // captureStableRefs: empty → no actionable elements
};

vi.mock('../../src/core/tools/builtin/browser/browser-manager.js', () => ({
  BrowserManager: { getInstance: () => ({ getOrConnect: vi.fn().mockResolvedValue({}) }) },
}));
vi.mock('../../src/core/tools/builtin/browser/active-page.js', () => ({
  resolveActivePage: vi.fn().mockResolvedValue(mockPage),
}));

const { snapshotTool } = await import('../../src/core/tools/builtin/browser/snapshot.js');

const ctx = { sessionId: 'test', workingDir: '.', config: null, logger: console } as ToolContext;

describe('browser.snapshot selector param', () => {
  it('defaults to locator("body") when no selector is given', async () => {
    await snapshotTool.execute({ refs: false }, ctx);
    expect(mockPage.locator).toHaveBeenLastCalledWith('body');
  });

  it('scopes the locator to the given selector', async () => {
    await snapshotTool.execute({ selector: '#pricing', refs: false }, ctx);
    expect(mockPage.locator).toHaveBeenLastCalledWith('#pricing');
  });

  it('labels the output with the scope when a selector was used', async () => {
    const res = await snapshotTool.execute({ selector: '#pricing', refs: false }, ctx);
    expect(String(res.output)).toContain('scoped to "#pricing"');
  });

  it('unscoped truncation message tells the model scrolling will NOT help, and names the escape hatch', async () => {
    ariaSnapshotMock.mockResolvedValueOnce('x'.repeat(7000)); // over ARIA_TREE_PREVIEW_CHARS (6000)
    const res = await snapshotTool.execute({}, ctx); // refs default true → hits the truncation branch
    const out = String(res.output);
    expect(out).toContain('ARIA tree truncated');
    expect(out).toMatch(/not scroll position/i);
    expect(out).toContain('"selector"');
  });

  it('a selector that matches nothing surfaces a targeted hint instead of a bare Playwright timeout', async () => {
    ariaSnapshotMock.mockRejectedValueOnce(new Error('Timeout 10000ms exceeded.'));
    const res = await snapshotTool.execute({ selector: '.does-not-exist' }, ctx);
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('may not match any element');
  });
});
