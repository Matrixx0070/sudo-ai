/**
 * @file history-and-wait.test.ts
 * @description Real-browser e2e for the capabilities salvaged from the removed
 * BrowserActionSuite orphan: browser.history (back/forward/reload) and the new
 * browser.wait modes (url / loadState / function).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { historyTool } from '../../src/core/tools/builtin/browser/history.js';
import { waitTool } from '../../src/core/tools/builtin/browser/wait.js';
import { BrowserManager } from '../../src/core/tools/builtin/browser/browser-manager.js';
import type { BrowserInstance } from '../../src/core/tools/builtin/browser/browser-manager.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const ctx = { sessionId: 'hw', workingDir: '.', config: null, logger: console } as unknown as ToolContext;

describe.skipIf(!browserAvailable())('salvaged browser.history + wait modes (real browser)', () => {
  let inst: BrowserInstance;

  beforeAll(async () => {
    inst = await BrowserManager.getInstance().launch('default', true);
  }, 40_000);

  afterAll(async () => {
    await BrowserManager.getInstance().close('default').catch(() => {});
  });

  it('browser.history navigates back / forward / reload', async () => {
    const page = await inst.context.newPage();
    await page.goto('data:text/html,<title>Alpha</title><h1>A</h1>', { waitUntil: 'load' });
    await page.goto('data:text/html,<title>Beta</title><h1>B</h1>', { waitUntil: 'load' });

    const back = await historyTool.execute({ operation: 'back' }, ctx);
    expect(back.success).toBe(true);
    expect(back.output).toContain('Alpha');

    const fwd = await historyTool.execute({ operation: 'forward' }, ctx);
    expect(fwd.success).toBe(true);
    expect(fwd.output).toContain('Beta');

    const reload = await historyTool.execute({ operation: 'reload' }, ctx);
    expect(reload.success).toBe(true);
    expect(reload.output).toContain('Beta');
  }, 30_000);

  it('browser.history back with no prior entry reports a clean failure', async () => {
    // A brand-new page sits at about:blank with no prior history entry.
    await inst.context.newPage();
    const back = await historyTool.execute({ operation: 'back' }, ctx);
    expect(back.success).toBe(false);
    expect(back.output).toMatch(/nothing to go back/i);
  }, 20_000);

  it('browser.wait supports loadState, function, and url modes', async () => {
    const page = await inst.context.newPage();
    await page.goto('data:text/html,<ul><li>a</li><li>b</li><li>c</li></ul>', { waitUntil: 'load' });

    const ls = await waitTool.execute({ loadState: 'domcontentloaded' }, ctx);
    expect(ls.success).toBe(true);
    expect((ls.data as { waited?: string }).waited).toBe('loadState');

    const fn = await waitTool.execute({ function: 'document.querySelectorAll("li").length >= 3' }, ctx);
    expect(fn.success).toBe(true);
    expect((fn.data as { waited?: string }).waited).toBe('function');

    const u = await waitTool.execute({ url: page.url() }, ctx);
    expect(u.success).toBe(true);
    expect((u.data as { waited?: string }).waited).toBe('url');
  }, 30_000);

  it('browser.wait still rejects when no condition is given', async () => {
    const res = await waitTool.execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/at least one of/i);
  });
});
