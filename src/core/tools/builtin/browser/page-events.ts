/**
 * @file page-events.ts
 * @description Per-context ring buffers of network responses and console messages,
 * exposing what Playwright MCP surfaces via browser_network_requests /
 * browser_console_messages — capabilities Sudo's browser toolset previously lacked.
 *
 * Capture is attached lazily the first time any tool resolves the active page
 * (see active-page.ts), and to every future page/popup via the context 'page'
 * event. That means capture is live BEFORE browser.navigate's goto, so the common
 * "navigate then inspect" flow records the whole page load. Buffers are bounded
 * ring buffers so a long-running session cannot grow memory without bound.
 */

import type { BrowserContext, Page } from 'playwright-core';

/** Max entries retained per context, per stream. Oldest are dropped. */
const MAX_ENTRIES = 500;

/** A captured network response. */
export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  failed?: boolean;
  failureText?: string;
}

/** A captured console message / page error. */
export interface ConsoleEntry {
  type: string; // log|info|warn|error|debug|pageerror
  text: string;
}

interface Buffers {
  network: NetworkEntry[];
  console: ConsoleEntry[];
}

const buffersByContext = new WeakMap<BrowserContext, Buffers>();
const capturingContexts = new WeakSet<BrowserContext>();

function getBuffers(context: BrowserContext): Buffers {
  let b = buffersByContext.get(context);
  if (!b) {
    b = { network: [], console: [] };
    buffersByContext.set(context, b);
  }
  return b;
}

function push<T>(arr: T[], entry: T): void {
  arr.push(entry);
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
}

/** Attach network + console listeners to a single page. */
function attachToPage(context: BrowserContext, page: Page): void {
  const b = getBuffers(context);

  page.on('response', (res) => {
    const req = res.request();
    push(b.network, {
      method: req.method(),
      url: res.url(),
      status: res.status(),
      resourceType: req.resourceType(),
    });
  });
  page.on('requestfailed', (req) => {
    push(b.network, {
      method: req.method(),
      url: req.url(),
      status: 0,
      resourceType: req.resourceType(),
      failed: true,
      failureText: req.failure()?.errorText ?? 'failed',
    });
  });
  page.on('console', (msg) => {
    push(b.console, { type: msg.type(), text: msg.text().slice(0, 2000) });
  });
  page.on('pageerror', (err) => {
    push(b.console, { type: 'pageerror', text: (err?.message ?? String(err)).slice(0, 2000) });
  });
}

/**
 * Ensure network/console capture is active for a context. Idempotent — safe to
 * call on every tool invocation. Attaches to existing pages and all future ones.
 */
export function ensureCapture(context: BrowserContext): void {
  if (capturingContexts.has(context)) return;
  capturingContexts.add(context);
  for (const page of context.pages()) attachToPage(context, page);
  context.on('page', (page) => attachToPage(context, page));
}

/** Read captured network entries (most recent last), optionally filtered. */
export function getNetwork(
  context: BrowserContext,
  opts?: { urlIncludes?: string; onlyFailed?: boolean; onlyStatusGte?: number; limit?: number },
): NetworkEntry[] {
  let out = getBuffers(context).network.slice();
  if (opts?.urlIncludes) out = out.filter((e) => e.url.includes(opts.urlIncludes!));
  if (opts?.onlyFailed) out = out.filter((e) => e.failed || e.status >= 400);
  if (opts?.onlyStatusGte !== undefined) out = out.filter((e) => e.status >= opts.onlyStatusGte!);
  if (opts?.limit && out.length > opts.limit) out = out.slice(-opts.limit);
  return out;
}

/** Read captured console entries (most recent last), optionally filtered. */
export function getConsole(
  context: BrowserContext,
  opts?: { onlyErrors?: boolean; limit?: number },
): ConsoleEntry[] {
  let out = getBuffers(context).console.slice();
  if (opts?.onlyErrors) out = out.filter((e) => e.type === 'error' || e.type === 'pageerror');
  if (opts?.limit && out.length > opts.limit) out = out.slice(-opts.limit);
  return out;
}
