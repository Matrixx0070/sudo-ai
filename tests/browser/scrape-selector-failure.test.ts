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
    expect(res.output).toContain('Extracted 1 fields (mode: text).');
    // The VALUE must be in output — the model never sees result.data.
    expect(res.output).toContain('price: Bronze — $9/mo');
    expect((res.data as { failedKeys: string[] }).failedKeys).toEqual([]);
  });
});

/**
 * 2026-07-29: asked "open the Apollo 11 page and tell me the launch date", the
 * model called browser.scrape with the invented selector `launchDate`, matched
 * nothing, and then answered from the page title anyway — a correct answer
 * built on no evidence. Root cause was a missing capability, not a bad guess:
 * selector-less whole-page extraction worked for links/table but HARD-FAILED
 * for text/html, and browser.snapshot returns an ARIA tree for FINDING
 * selectors rather than prose. Nothing could answer "what does this page say",
 * so guessing selectors was the only move available.
 */
describe('browser.scrape — selector-less whole-page read', () => {
  const pageWith = (value: string | null) => ({
    evaluate: vi.fn().mockResolvedValue(value),
    locator: vi.fn(),
    url: () => 'https://en.wikipedia.org/wiki/Apollo_11',
  });

  it('no selectors + text returns the page text instead of refusing', async () => {
    const page = pageWith('Apollo 11 was the American spaceflight that first landed humans on the Moon.');
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ extractAs: 'text' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('first landed humans on the Moon');
    expect((res.data as { text: string }).text).toContain('Apollo 11');
    expect((res.data as { truncated: boolean }).truncated).toBe(false);
  });

  it('defaults to text mode, so bare {} reads the page', async () => {
    const page = pageWith('hello world');
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({}, ctx);
    expect(res.success).toBe(true);
    expect((res.data as { text: string }).text).toBe('hello world');
  });

  it('an empty page still fails LOUDLY — not a 0-field silent success', async () => {
    const page = pageWith('   ');
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ extractAs: 'text' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/contained no text/);
  });

  it('a missing containerSelector fails loudly', async () => {
    const page = pageWith(null);
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ extractAs: 'text', containerSelector: '#nope' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/matched no element/);
  });

  it('oversized pages truncate and SAY they truncated', async () => {
    const page = pageWith('x'.repeat(50_000));
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ extractAs: 'text' }, ctx);
    expect(res.success).toBe(true);
    expect((res.data as { truncated: boolean }).truncated).toBe(true);
    expect((res.data as { text: string }).text).toHaveLength(40_000);
    expect((res.data as { chars: number }).chars).toBe(50_000);
    expect(res.output).toMatch(/truncated to 40000/);
  });

  it('explicit selectors still take the field-extraction path (unchanged)', async () => {
    const goodLocator = makeLocator('resolve');
    const page = {
      evaluate: vi.fn(),
      locator: vi.fn().mockReturnValue(goodLocator),
      url: () => 'https://example.com',
    };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ selectors: { price: '.price' } }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('Extracted 1 fields (mode: text).');
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

/**
 * 2026-07-29, the bug underneath the Apollo 11 miss: a SUCCESSFUL scrape
 * returned exactly "Extracted 1 fields (mode: text)." — 32 chars, matching the
 * logged resultLen — while the scraped text sat in data.results. The agent loop
 * feeds the model result.output and nothing else (tool-exec.ts:532 clamps
 * result.output; result.data never reaches it), so the model saw a success with
 * no content, said so, and answered from the page title instead.
 * A tool that succeeds while showing the caller nothing is worse than one that
 * fails: the failure is at least visible.
 */
describe('browser.scrape — extracted values reach the model', () => {
  it('a successful scrape is never just the summary line', async () => {
    const goodLocator = makeLocator('resolve');
    const page = { locator: vi.fn().mockReturnValue(goodLocator), url: () => 'https://example.com' };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ selectors: { plan: '.plan' } }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).not.toBe('Extracted 1 fields (mode: text).');
    expect(res.output.length).toBeGreaterThan(32);
    expect(res.output).toContain('Bronze — $9/mo');
  });

  it('partial success shows the values that DID match, not just the failures', async () => {
    const innerText = vi.fn()
      .mockResolvedValueOnce('July 16, 1969')
      .mockRejectedValueOnce(new Error('Timeout 5000ms exceeded waiting for locator'));
    const page = {
      locator: vi.fn().mockReturnValue({ first: () => ({ innerText, innerHTML: vi.fn() }) }),
      url: () => 'https://en.wikipedia.org/wiki/Apollo_11',
    };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ selectors: { launched: '.launch', crew: '.nope' } }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('launched: July 16, 1969');
    expect(res.output).toContain('No match for: crew');
  });

  it('an oversized field is truncated per-field, not dropped', async () => {
    const innerText = vi.fn().mockResolvedValue('y'.repeat(9_000));
    const page = {
      locator: vi.fn().mockReturnValue({ first: () => ({ innerText, innerHTML: vi.fn() }) }),
      url: () => 'https://example.com',
    };
    vi.mocked(resolveActivePage).mockResolvedValue(page as never);

    const res = await scrapeTool.execute({ selectors: { body: '.body' } }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('(truncated)');
    expect(res.output.length).toBeLessThan(6_000);
  });
});
