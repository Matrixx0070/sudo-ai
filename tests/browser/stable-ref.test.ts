/**
 * @file stable-ref.test.ts
 * @description Real-browser e2e for the stable-ref layer. Launches headless
 * Chromium and proves that refs target the EXACT element even when several share
 * the same accessible name (the wrong-element bug the old role+name `.first()`
 * targeting suffered), and that refs resolve across iframes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  captureStableRefs,
  resolveStableRef,
  parseRefParam,
  REF_ATTR,
} from '../../src/core/tools/builtin/browser/stable-ref.js';

const PAGE_HTML = `<!doctype html><html><body>
  <h1>Cart</h1>
  <ul>
    <li>Apple    <button data-item="apple">Delete</button></li>
    <li>Banana   <button data-item="banana">Delete</button></li>
    <li>Cherry   <button data-item="cherry">Delete</button></li>
  </ul>
  <label for="email">Email</label>
  <input id="email" type="email" />
  <input aria-label="Coupon code" placeholder="ENTER CODE" />
  <a href="/checkout">Checkout</a>
  <span role="button" tabindex="0" id="rolebtn">Custom Action</span>
  <div style="display:none"><button>Hidden Delete</button></div>
  <iframe srcdoc='&lt;button id="framed"&gt;Frame Button&lt;/button&gt;'></iframe>
</body></html>`;

describe('stable-ref (real browser)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(PAGE_HTML, { waitUntil: 'load' });
    // Give the iframe a tick to attach.
    await page.waitForTimeout(100);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('parseRefParam accepts number and numeric string, rejects junk', () => {
    expect(parseRefParam(5)).toBe(5);
    expect(parseRefParam('12')).toBe(12);
    expect(parseRefParam(' 3 ')).toBe(3);
    expect(parseRefParam(0)).toBeNull();
    expect(parseRefParam(-1)).toBeNull();
    expect(parseRefParam('abc')).toBeNull();
    expect(parseRefParam(undefined)).toBeNull();
  });

  it('captures actionable elements, skips hidden ones, infers roles/names', async () => {
    const snap = await captureStableRefs(page);
    const names = snap.refs.map((r) => `${r.role}:${r.name}`);

    // Three same-named Delete buttons all captured distinctly.
    expect(snap.refs.filter((r) => r.name === 'Delete' && r.role === 'button')).toHaveLength(3);
    // Link, inferred email textbox (labelled), coupon (aria-label), custom role=button.
    expect(names).toContain('link:Checkout');
    expect(names).toContain('textbox:Email');
    expect(names).toContain('textbox:Coupon code');
    expect(names).toContain('button:Custom Action');
    // Hidden button is excluded.
    expect(names).not.toContain('button:Hidden Delete');
    // Every ref is unique.
    const refNums = snap.refs.map((r) => r.ref);
    expect(new Set(refNums).size).toBe(refNums.length);
    // Render is non-empty and ref-annotated.
    expect(snap.render).toMatch(/^\[\d+\] /m);
  });

  it('resolves a ref to the EXACT element among duplicate names', async () => {
    const snap = await captureStableRefs(page);
    const deletes = snap.refs.filter((r) => r.name === 'Delete');
    expect(deletes).toHaveLength(3);

    // The 2nd Delete button in document order must be Banana's.
    const bananaRef = deletes[1]!.ref;
    const loc = await resolveStableRef(page, bananaRef);
    expect(loc).not.toBeNull();
    expect(await loc!.getAttribute('data-item')).toBe('banana');

    // Clicking by ref hits exactly that element.
    await loc!.click();
    const clicked = await page.getAttribute(`[${REF_ATTR}="${bananaRef}"]`, 'data-item');
    expect(clicked).toBe('banana');
  });

  it('type-by-ref fills the intended input', async () => {
    const snap = await captureStableRefs(page);
    const coupon = snap.refs.find((r) => r.name === 'Coupon code')!;
    const loc = await resolveStableRef(page, coupon.ref);
    expect(loc).not.toBeNull();
    await loc!.fill('SAVE20');
    // The email input must remain untouched — proves no cross-targeting.
    expect(await page.inputValue('#email')).toBe('');
    // Read back via the ref itself.
    const val = await page.inputValue(`[${REF_ATTR}="${coupon.ref}"]`);
    expect(val).toBe('SAVE20');
  });

  it('captures and resolves elements inside iframes', async () => {
    const snap = await captureStableRefs(page);
    const framed = snap.refs.find((r) => r.name === 'Frame Button');
    expect(framed, 'iframe button should be captured').toBeTruthy();
    const loc = await resolveStableRef(page, framed!.ref);
    expect(loc).not.toBeNull();
    expect(await loc!.getAttribute('id')).toBe('framed');
  });

  it('returns null for an unknown ref', async () => {
    await captureStableRefs(page);
    expect(await resolveStableRef(page, 99999)).toBeNull();
  });
});
