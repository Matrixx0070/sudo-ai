/**
 * Regression test for a live-observed doom loop: browser.scrape's per-key
 * text/html extraction used `page.locator(sel).first().innerText().catch(() =>
 * null)` with no explicit timeout, so a wrong selector guess silently ate
 * Playwright's ~30s actionability default AND the tool still reported
 * `success: true` with every field null — the model had no signal about which
 * selector was wrong, so it just kept guessing new selectors and retrying,
 * each attempt burning ~30 real seconds (see RepairFlywheel HARNESS-BUG log,
 * 2026-07-27 ~06:51-06:57 against nokycvoip.com pricing).
 *
 * Mocks BrowserManager/resolveActivePage — no real browser needed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../../src/core/tools/types.js';

function makeLocator(behavior: 'resolve' | 'reject') {
  const innerText = behavior === 'resolve'
    ? vi.fn().mockResolvedValue('Bronze — $9/mo')
    : vi.fn().mockRejectedValue(new Error('Timeout 5000ms exceeded waiting for locator'));
  const innerHTML = behavior === 'resolve'
    ? vi.fn().mockResolvedValue('<b>Bronze</b>')
    : vi.fn().mockRejectedValue(new Error('Timeout 5000ms exceeded waiting for locator'));
  return { first: () => ({ innerText, innerHTML }), _innerText: innerText, _innerHTML: innerHTML };
}

vi.mock('../../src/core/tools/builtin/browser/browser-manager.js', () => ({
  BrowserManager: { getInstance: () => ({ getOrConnect: vi.fn().mockResolvedValue({}) }) },
}));
vi.mock('../../src/core/tools/builtin/browser/active-page.js', () => ({
  resolveActivePage: vi.fn(),
}));

const { scrapeTool } = await import('../../src/core/tools/builtin/browser/scrape.js');
const { resolveActivePage } = await import('../../src/core/tools/builtin/browser/active-page.js');

const ctx = { sessionId: 'test', workingDir: '.', config: null, logger: console } as ToolContext;

describe('browser.scrape — honest failure signal on non-matching selectors', () => {
  it('all selectors miss: success:false, names the failed keys, no silent-null "success"', async () => {
    const badLocator = makeLocator('reject');
    const page = { locator: vi.fn().mockReturnValue(badLocator), url: () => 'https://example.com' };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ selectors: { price: '.price', name: '.plan-name' } }, ctx);

    expect(res.success).toBe(false);
    expect(res.output).toContain('none of the 2 selector(s) matched');
    expect(res.output).toContain('price');
    expect(res.output).toContain('name');
    expect((res.data as { failedKeys: string[] }).failedKeys).toEqual(['price', 'name']);
    expect((res.data as { results: Record<string, unknown> }).results).toEqual({ price: null, name: null });
  });

  it('passes a bounded timeout to innerText/innerHTML instead of Playwright\'s ~30s default', async () => {
    const locator = makeLocator('reject');
    const page = { locator: vi.fn().mockReturnValue(locator), url: () => 'https://example.com' };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    await scrapeTool.execute({ selectors: { price: '.price' } }, ctx);
    expect(locator._innerText).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5_000 }));
  });

  it('partial match: success:true but still names which fields failed', async () => {
    const goodLocator = makeLocator('resolve');
    const badLocator = makeLocator('reject');
    const page = {
      locator: vi.fn((sel: string) => (sel === '.price' ? goodLocator : badLocator)),
      url: () => 'https://example.com',
    };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ selectors: { price: '.price', name: '.plan-name' } }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('1/2 fields');
    expect(res.output).toContain('name');
    expect((res.data as { results: Record<string, unknown> }).results['price']).toBe('Bronze — $9/mo');
    expect((res.data as { failedKeys: string[] }).failedKeys).toEqual(['name']);
  });

  it('all selectors match: unchanged happy-path message, no failedKeys', async () => {
    const goodLocator = makeLocator('resolve');
    const page = { locator: vi.fn().mockReturnValue(goodLocator), url: () => 'https://example.com' };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ selectors: { price: '.price' } }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toBe('Extracted 1 fields (mode: text).');
    expect((res.data as { failedKeys: string[] }).failedKeys).toEqual([]);
  });
});
