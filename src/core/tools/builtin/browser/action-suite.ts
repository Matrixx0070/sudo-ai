/**
 * @file action-suite.ts
 * @description Composable browser action suite for SUDO-AI v4.
 *
 * Inspired by OpenClaw's comprehensive browser action set.  Each action is a
 * self-contained BrowserAction convertible to a ToolDefinition and
 * registerable into a ToolRegistry.  Wait conditions (waitFor*) are
 * first-class citizens that compose with navigation and interaction actions.
 */

import type { ToolDefinition, ToolParam, ToolResult, ToolContext } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';
import type { CDPManager } from './cdp-manager.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('browser:action-suite');

// -- Exported types ---------------------------------------------------------

/** ARIA snapshot result from the SnapshotEngine. */
export interface SnapshotResult { snapshot: string; url: string; title: string }

/** A single browser action that can be exposed as a tool. */
export interface BrowserAction {
  name: string; description: string;
  parameters: Record<string, ToolParam>;
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Composable wait condition — embeddable in any action. */
export interface WaitCondition {
  type: 'url' | 'selector' | 'loadState' | 'function'; value: string; timeout?: number;
}

/** Enriched result for actions that capture page state. */
export interface ActionResult {
  success: boolean; output: string; screenshot?: string; snapshot?: SnapshotResult;
}

/** Minimal contract for a snapshot engine (real impl in snapshot-engine.ts). */
export interface SnapshotEngine { capture(page: any): Promise<SnapshotResult> }

// -- Helpers ----------------------------------------------------------------

const W = 15_000; // default wait timeout ms
const CAT = 'browser' as const;
const ok = (o: string, d?: unknown): ToolResult => ({ success: true, output: o, ...(d ? { data: d } : {}) });
const fail = (m: string): ToolResult => ({ success: false, output: m });
const eStr = (e: unknown): string => e instanceof Error ? e.message : String(e);
const refLoc = (pg: any, r: string) => pg.locator(`[aria-ref="${r}"], [data-ref="${r}"]`).first();

/** Resolve the active Playwright Page from the CDP manager. */
async function pageOf(cdp: CDPManager): Promise<any> {
  const s = cdp.getActiveSession();
  if (!s) throw new Error('No active CDP session');
  const ctx = (cdp as any).context;
  if (!ctx) throw new Error('CDPManager context unavailable');
  for (const pg of ctx.pages()) {
    try {
      const c = await pg.context().newCDPSession(pg);
      const { target } = await c.send('Target.getTargetInfo') as any;
      await c.detach().catch(() => {});
      if (target?.targetId === s.targetId) return pg;
    } catch { continue; }
  }
  const pp = ctx.pages();
  if (pp.length) return pp[pp.length - 1];
  throw new Error(`No page for session ${s.id}`);
}

// -- BrowserActionSuite -----------------------------------------------------

/**
 * Centralised suite of 21 browser actions with composable wait support.
 *
 *   const suite = new BrowserActionSuite(cdp, snap);
 *   suite.registerAll(registry);  // register every action
 *   suite.getActions();           // BrowserAction[]
 *   suite.getStats();             // execution telemetry
 */
export class BrowserActionSuite {
  /** CDP manager — public so action closures can reach it. */
  readonly cdp: CDPManager;
  /** Snapshot engine — public so action closures can reach it. */
  readonly snap: SnapshotEngine;
  /** Per-action execution counts. */
  private readonly cnt = new Map<string, number>();
  /** Per-action cumulative latency (ms). */
  private readonly lat = new Map<string, number>();

  constructor(cdpManager: CDPManager, snapshotEngine: SnapshotEngine) {
    this.cdp = cdpManager; this.snap = snapshotEngine;
  }

  /** Return every action as a BrowserAction[]. */
  getActions(): BrowserAction[] { return ACTIONS.map(fn => fn(this)); }

  /** Register all actions into a ToolRegistry. */
  registerAll(registry: ToolRegistry): void {
    for (const a of this.getActions()) registry.register(toDef(a));
    log.info({ count: this.getActions().length }, 'All browser actions registered');
  }

  /** Return execution telemetry across all actions. */
  getStats(): { totalExecutions: number; byAction: Record<string, number>; avgLatencyMs: number } {
    let t = 0, ms = 0; const by: Record<string, number> = {};
    for (const [n, c] of this.cnt) { t += c; by[n] = c; ms += this.lat.get(n) ?? 0; }
    return { totalExecutions: t, byAction: by, avgLatencyMs: t ? Math.round(ms / t) : 0 };
  }

  /** Record an execution for stats tracking. */
  record(name: string, ms: number): void {
    this.cnt.set(name, (this.cnt.get(name) ?? 0) + 1);
    this.lat.set(name, (this.lat.get(name) ?? 0) + ms);
  }
}

// -- 21 action factories (close over suite instance) ------------------------

type AF = (s: BrowserActionSuite) => BrowserAction;

const ACTIONS: AF[] = [

  // 1. navigate — go to URL
  (s): BrowserAction => ({
    name: 'browser.navigate', description: 'Navigate the active tab to a URL.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL.' },
      waitUntil: { type: 'string', required: false, enum: ['domcontentloaded', 'load', 'networkidle'], default: 'domcontentloaded', description: 'Load state to wait for.' },
    },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.goto(p['url'] as string, { waitUntil: (p['waitUntil'] as string) ?? 'domcontentloaded', timeout: W });
      s.record('browser.navigate', Date.now() - t0); return ok(`Navigated to ${p['url']}`);
    } catch (e) { return fail(`navigate: ${eStr(e)}`); } },
  }),

  // 2. click — click element by ARIA snapshot ref
  (s): BrowserAction => ({
    name: 'browser.click', description: 'Click an element by ARIA snapshot ref.',
    parameters: { ref: { type: 'string', required: true, description: 'Element ref (e.g. "ref=12").' } },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await refLoc(pg, p['ref'] as string).click({ timeout: W });
      s.record('browser.click', Date.now() - t0); return ok(`Clicked ${p['ref']}`);
    } catch (e) { return fail(`click: ${eStr(e)}`); } },
  }),

  // 3. type — type text into element
  (s): BrowserAction => ({
    name: 'browser.type', description: 'Type text into an element by ARIA ref. Clears existing text by default.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Element ref.' },
      text: { type: 'string', required: true, description: 'Text to type.' },
      clear: { type: 'boolean', required: false, default: true, description: 'Clear before typing.' },
    },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), loc = refLoc(pg, p['ref'] as string), t0 = Date.now();
      if (p['clear'] !== false) await loc.fill('', { timeout: W }).catch(() => {});
      await loc.fill(p['text'] as string, { timeout: W });
      s.record('browser.type', Date.now() - t0); return ok(`Typed "${p['text']}" into ${p['ref']}`);
    } catch (e) { return fail(`type: ${eStr(e)}`); } },
  }),

  // 4. scroll — scroll page by direction and amount
  (s): BrowserAction => ({
    name: 'browser.scroll', description: 'Scroll the page by direction and pixel amount.',
    parameters: {
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'], description: 'Direction.' },
      amount: { type: 'number', required: false, default: 300, description: 'Pixels (default: 300).' },
    },
    execute: async (p) => { try {
      const d = p['direction'] as string, a = (p['amount'] as number) ?? 300;
      const neg = d === 'up' || d === 'left', vert = d === 'up' || d === 'down';
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.mouse.wheel(vert ? 0 : neg ? -a : a, vert ? neg ? -a : a : 0);
      s.record('browser.scroll', Date.now() - t0); return ok(`Scrolled ${d} ${a}px`);
    } catch (e) { return fail(`scroll: ${eStr(e)}`); } },
  }),

  // 5. hover — hover over element
  (s): BrowserAction => ({
    name: 'browser.hover', description: 'Hover over an element by ARIA ref.',
    parameters: { ref: { type: 'string', required: true, description: 'Element ref.' } },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await refLoc(pg, p['ref'] as string).hover({ timeout: W });
      s.record('browser.hover', Date.now() - t0); return ok(`Hovered ${p['ref']}`);
    } catch (e) { return fail(`hover: ${eStr(e)}`); } },
  }),

  // 6. drag — drag element to target
  (s): BrowserAction => ({
    name: 'browser.drag', description: 'Drag an element to a target, both by ARIA ref.',
    parameters: {
      fromRef: { type: 'string', required: true, description: 'Source element ref.' },
      toRef: { type: 'string', required: true, description: 'Target element ref.' },
    },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await refLoc(pg, p['fromRef'] as string).dragTo(refLoc(pg, p['toRef'] as string), { timeout: W });
      s.record('browser.drag', Date.now() - t0); return ok(`Dragged ${p['fromRef']} to ${p['toRef']}`);
    } catch (e) { return fail(`drag: ${eStr(e)}`); } },
  }),

  // 7. keyPress — press keyboard key
  (s): BrowserAction => ({
    name: 'browser.keyPress', description: 'Press a keyboard key (e.g. "Enter", "Tab", "Escape").',
    parameters: { key: { type: 'string', required: true, description: 'Key name per Playwright.' } },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.keyboard.press(p['key'] as string);
      s.record('browser.keyPress', Date.now() - t0); return ok(`Pressed "${p['key']}"`);
    } catch (e) { return fail(`keyPress: ${eStr(e)}`); } },
  }),

  // 8. screenshot — capture screenshot as base64 PNG
  (s): BrowserAction => ({
    name: 'browser.screenshot', description: 'Capture a screenshot. Returns base64-encoded PNG.',
    parameters: { fullPage: { type: 'boolean', required: false, default: false, description: 'Full scrollable page.' } },
    execute: async (p) => { try {
      const buf = await s.cdp.screenshot({ fullPage: p['fullPage'] === true });
      s.record('browser.screenshot', 0);
      return ok(`Screenshot (${buf.length} bytes)`, { screenshot: buf.toString('base64') });
    } catch (e) { return fail(`screenshot: ${eStr(e)}`); } },
  }),

  // 9. selectOption — select dropdown option
  (s): BrowserAction => ({
    name: 'browser.selectOption', description: 'Select an option in a <select> by ARIA ref.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Select element ref.' },
      value: { type: 'string', required: true, description: 'Value or label to select.' },
    },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await refLoc(pg, p['ref'] as string).selectOption(p['value'] as string, { timeout: W });
      s.record('browser.selectOption', Date.now() - t0); return ok(`Selected "${p['value']}" in ${p['ref']}`);
    } catch (e) { return fail(`selectOption: ${eStr(e)}`); } },
  }),

  // 10. uploadFile — upload file to input
  (s): BrowserAction => ({
    name: 'browser.uploadFile', description: 'Upload a file to an <input type="file"> by ARIA ref.',
    parameters: {
      ref: { type: 'string', required: true, description: 'File input ref.' },
      filePath: { type: 'string', required: true, description: 'Absolute file path.' },
    },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await refLoc(pg, p['ref'] as string).setInputFiles(p['filePath'] as string, { timeout: W });
      s.record('browser.uploadFile', Date.now() - t0); return ok(`Uploaded "${p['filePath']}" to ${p['ref']}`);
    } catch (e) { return fail(`uploadFile: ${eStr(e)}`); } },
  }),

  // 11. download — download file
  (s): BrowserAction => ({
    name: 'browser.download', description: 'Download a file by clicking a download element, or from current URL.',
    parameters: { clickRef: { type: 'string', required: false, description: 'Element ref to click. Omit for current URL.' } },
    execute: async (p) => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      if (p['clickRef']) {
        const [dl] = await Promise.all([
          pg.waitForEvent('download', { timeout: W }),
          refLoc(pg, p['clickRef'] as string).click(),
        ]);
        s.record('browser.download', Date.now() - t0);
        return ok(`Downloaded to ${await dl.path() ?? '(temp)'}`);
      }
      await pg.evaluate(`window.location.href = '${pg.url()}'`);
      s.record('browser.download', Date.now() - t0); return ok(`Triggered download from ${pg.url()}`);
    } catch (e) { return fail(`download: ${eStr(e)}`); } },
  }),

  // 12. waitForUrl — wait for URL pattern match
  (s): BrowserAction => ({
    name: 'browser.waitForUrl', description: 'Wait until the page URL matches a string or glob pattern.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL or glob (e.g. "*/dashboard*").' },
      timeout: { type: 'number', required: false, default: W, description: `Max wait ms (default: ${W}).` },
    },
    execute: async (p) => { const to = (p['timeout'] as number) ?? W; try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.waitForURL(p['url'] as string, { timeout: to });
      s.record('browser.waitForUrl', Date.now() - t0); return ok(`URL matched: ${pg.url()}`);
    } catch { return fail(`waitForUrl timed out after ${to}ms`); } },
  }),

  // 13. waitForSelector — wait for element to appear
  (s): BrowserAction => ({
    name: 'browser.waitForSelector', description: 'Wait for an element matching a CSS selector to be attached.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector.' },
      timeout: { type: 'number', required: false, default: W, description: `Max wait ms (default: ${W}).` },
    },
    execute: async (p) => { const to = (p['timeout'] as number) ?? W; try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.waitForSelector(p['selector'] as string, { state: 'attached', timeout: to });
      s.record('browser.waitForSelector', Date.now() - t0); return ok(`Selector "${p['selector']}" appeared`);
    } catch { return fail(`waitForSelector timed out after ${to}ms`); } },
  }),

  // 14. waitForLoadState — wait for page load state
  (s): BrowserAction => ({
    name: 'browser.waitForLoadState', description: 'Wait for page load state (load, domcontentloaded, networkidle).',
    parameters: {
      state: { type: 'string', required: false, default: 'networkidle', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Load state.' },
      timeout: { type: 'number', required: false, default: W, description: `Max wait ms (default: ${W}).` },
    },
    execute: async (p) => { const st = (p['state'] as string) ?? 'networkidle', to = (p['timeout'] as number) ?? W; try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.waitForLoadState(st, { timeout: to });
      s.record('browser.waitForLoadState', Date.now() - t0); return ok(`Reached: ${st}`);
    } catch { return fail(`waitForLoadState timed out after ${to}ms`); } },
  }),

  // 15. waitForFunction — wait for JS function truthy
  (s): BrowserAction => ({
    name: 'browser.waitForFunction', description: 'Wait for a JS expression to return truthy in the page.',
    parameters: {
      fn: { type: 'string', required: true, description: 'JS expression or arrow function.' },
      timeout: { type: 'number', required: false, default: W, description: `Max wait ms (default: ${W}).` },
    },
    execute: async (p) => { const to = (p['timeout'] as number) ?? W; try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.waitForFunction(p['fn'] as string, { timeout: to });
      s.record('browser.waitForFunction', Date.now() - t0); return ok(`Condition met: ${p['fn']}`);
    } catch { return fail(`waitForFunction timed out after ${to}ms`); } },
  }),

  // 16. goBack — navigate back in history
  (s): BrowserAction => ({
    name: 'browser.goBack', description: 'Navigate to the previous page in browser history.',
    parameters: {},
    execute: async () => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.goBack({ waitUntil: 'domcontentloaded', timeout: W });
      s.record('browser.goBack', Date.now() - t0); return ok(`Back to ${pg.url()}`);
    } catch (e) { return fail(`goBack: ${eStr(e)}`); } },
  }),

  // 17. goForward — navigate forward in history
  (s): BrowserAction => ({
    name: 'browser.goForward', description: 'Navigate to the next page in browser history.',
    parameters: {},
    execute: async () => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.goForward({ waitUntil: 'domcontentloaded', timeout: W });
      s.record('browser.goForward', Date.now() - t0); return ok(`Forward to ${pg.url()}`);
    } catch (e) { return fail(`goForward: ${eStr(e)}`); } },
  }),

  // 18. refresh — reload current page
  (s): BrowserAction => ({
    name: 'browser.refresh', description: 'Reload the current page.',
    parameters: {},
    execute: async () => { try {
      const pg = await pageOf(s.cdp), t0 = Date.now();
      await pg.reload({ waitUntil: 'domcontentloaded', timeout: W });
      s.record('browser.refresh', Date.now() - t0); return ok(`Refreshed: ${pg.url()}`);
    } catch (e) { return fail(`refresh: ${eStr(e)}`); } },
  }),

  // 19. tabCreate — open a new tab
  (s): BrowserAction => ({
    name: 'browser.tabCreate', description: 'Open a new browser tab, optionally navigating to a URL.',
    parameters: { url: { type: 'string', required: false, description: 'URL (default: about:blank).' } },
    execute: async (p) => { const url = (p['url'] as string) ?? 'about:blank'; try {
      const t0 = Date.now(), sess = await s.cdp.createSession(url);
      s.record('browser.tabCreate', Date.now() - t0); return ok(`New tab (session ${sess.id}): ${url}`);
    } catch (e) { return fail(`tabCreate: ${eStr(e)}`); } },
  }),

  // 20. tabSwitch — switch to tab by index
  (s): BrowserAction => ({
    name: 'browser.tabSwitch', description: 'Switch the active browser tab by 0-based index.',
    parameters: { index: { type: 'number', required: true, description: '0-based tab index.' } },
    execute: async (p) => {
      const i = p['index'] as number, tabs = s.cdp.listSessions().filter(x => x.state === 'connected');
      if (i < 0 || i >= tabs.length) return fail(`Index ${i} out of range (0..${tabs.length - 1})`);
      try { const t0 = Date.now(); await s.cdp.switchSession(tabs[i]!.id);
        s.record('browser.tabSwitch', Date.now() - t0); return ok(`Switched to tab ${i}`);
      } catch (e) { return fail(`tabSwitch: ${eStr(e)}`); }
    },
  }),

  // 21. tabClose — close tab by index or active
  (s): BrowserAction => ({
    name: 'browser.tabClose', description: 'Close a browser tab by 0-based index (default: active tab).',
    parameters: { index: { type: 'number', required: false, description: '0-based tab index (default: active).' } },
    execute: async (p) => {
      const tabs = s.cdp.listSessions().filter(x => x.state === 'connected');
      let sid: string;
      if (p['index'] !== undefined) {
        const i = p['index'] as number;
        if (i < 0 || i >= tabs.length) return fail(`Index ${i} out of range (0..${tabs.length - 1})`);
        sid = tabs[i]!.id;
      } else { const a = s.cdp.getActiveSession(); if (!a) return fail('No active tab'); sid = a.id; }
      try { const t0 = Date.now(); await s.cdp.closeSession(sid);
        s.record('browser.tabClose', Date.now() - t0); return ok(`Closed tab (session ${sid})`);
      } catch (e) { return fail(`tabClose: ${eStr(e)}`); }
    },
  }),
];

// -- ToolDefinition converter -----------------------------------------------

function toDef(a: BrowserAction): ToolDefinition {
  return { name: a.name, description: a.description, category: CAT, parameters: a.parameters, execute: a.execute };
}