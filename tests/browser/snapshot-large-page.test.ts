/**
 * @file snapshot-large-page.test.ts
 * @description Regression for the prod bug found by the live recovery test:
 *   (B) on a large page the ARIA tree pushed the stable-ref listing past the
 *       tool-output clamp, so the model never saw valid refs and guessed.
 *   (A) browser-recovery.defaultSnapshot (real deps, static imports) must return
 *       a fresh snapshot — the path #563 never exercised (it injected the dep).
 * Both need a real browser; skips when Chromium is absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { snapshotTool } from '../../src/core/tools/builtin/browser/snapshot.js';
import { BrowserManager } from '../../src/core/tools/builtin/browser/browser-manager.js';
import { clampToolOutput } from '../../src/core/agent/tool-output-clamp.js';
import { computeBrowserRecovery, resetBrowserRecovery } from '../../src/core/agent/browser-recovery.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const ctx = { sessionId: 'lg', workingDir: '.', config: null, logger: console } as unknown as ToolContext;

// A page big enough that the ARIA tree alone would blow the clamp head if placed first.
const LARGE_HTML =
  '<h1>Big directory</h1>' +
  Array.from({ length: 400 }, (_, i) =>
    `<a href="/item/${i}">Result number ${i} — a reasonably descriptive link label for item ${i}</a>`,
  ).join('');

describe.skipIf(!browserAvailable())('snapshot refs on a large page (real browser)', () => {
  beforeAll(async () => {
    const inst = await BrowserManager.getInstance().launch('default', true);
    const page = await inst.context.newPage();
    await page.setContent(LARGE_HTML, { waitUntil: 'load' });
  }, 40_000);

  afterAll(async () => {
    await BrowserManager.getInstance().close('default').catch(() => {});
  });

  it('(B) puts the ref listing FIRST and it survives the output clamp', async () => {
    const res = await snapshotTool.execute({}, ctx);
    expect(res.success).toBe(true);
    const refs = (res.data as { refs: unknown[] }).refs;
    expect(refs.length).toBeGreaterThanOrEqual(350); // genuinely large

    const out = String(res.output);
    // Refs come BEFORE the ARIA tree.
    expect(out.indexOf('Actionable elements')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('Actionable elements')).toBeLessThan(out.indexOf('ARIA tree'));
    // The tree is capped (large page).
    expect(out).toContain('ARIA tree truncated');

    // The critical regression: after the loop's clamp, early+mid refs SURVIVE
    // (they used to be truncated away when the tree came first).
    const clamped = clampToolOutput(out);
    expect(clamped).toContain('[1] ');
    expect(clamped).toContain('[150] ');
    expect(clamped).toContain('Actionable elements');
  }, 30_000);

  it('(A) recovery defaultSnapshot (real deps) returns a fresh-ref hint', async () => {
    resetBrowserRecovery('lg-probe');
    const rec = await computeBrowserRecovery({ toolName: 'browser.click', args: {}, sessionId: 'lg-probe' });
    expect(rec.escalated).toBe(false);
    expect(rec.hint).toBeTruthy();
    expect(rec.hint).toContain('FRESH page snapshot');
    expect(rec.hint).toMatch(/\[\d+\] /); // carries actual refs
  }, 30_000);
});
