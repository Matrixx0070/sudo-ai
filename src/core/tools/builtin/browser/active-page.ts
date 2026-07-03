/**
 * @file active-page.ts
 * @description Single source of truth for "which page do the browser tools act on".
 *
 * Every browser leaf tool previously resolved the active page inline as
 * `pages[pages.length - 1]` — "the newest page". That has one correctness bug:
 * `browser.tabs switch` calls `page.bringToFront()`, which does NOT reorder
 * `context.pages()`, so after switching to an earlier tab the other tools still
 * acted on the newest one. For an unattended agent driving multi-tab flows that
 * silently targets the wrong tab.
 *
 * This module tracks the active page per BrowserContext:
 *  - `browser.tabs switch/open` calls `setActivePage` to make its tab active.
 *  - New tabs/popups (context 'page' event) become active automatically, which
 *    preserves the previous "newest page" behaviour for click-opens-popup flows.
 *  - `resolveActivePage` returns the tracked page (if still open), else falls back
 *    to the newest page, else opens a blank one — matching the old contract.
 */

import type { Page, BrowserContext } from 'playwright-core';
import type { BrowserInstance } from './browser-manager.js';

/** Active page per context. WeakMap so closed contexts are GC'd automatically. */
const activeByContext = new WeakMap<BrowserContext, Page>();
/** Contexts we've already attached the auto-follow 'page' listener to. */
const trackedContexts = new WeakSet<BrowserContext>();

/**
 * Attach a one-time listener so newly-opened tabs/popups become the active page,
 * preserving the historical "act on the newest page" behaviour.
 */
function ensureTracking(context: BrowserContext): void {
  if (trackedContexts.has(context)) return;
  trackedContexts.add(context);
  context.on('page', (page) => setActivePage(context, page));
}

/**
 * Mark `page` as the active page for `context`. Clears the marker automatically
 * when the page closes so `resolveActivePage` falls back cleanly.
 */
export function setActivePage(context: BrowserContext, page: Page): void {
  activeByContext.set(context, page);
  page.once('close', () => {
    if (activeByContext.get(context) === page) activeByContext.delete(context);
  });
}

/**
 * Resolve the page browser tools should operate on for a given instance.
 * Tracked active page → newest open page → a fresh blank page.
 */
export async function resolveActivePage(instance: BrowserInstance): Promise<Page> {
  const context = instance.context;
  ensureTracking(context);

  const tracked = activeByContext.get(context);
  if (tracked && !tracked.isClosed()) return tracked;

  const pages = context.pages();
  const page = pages.length > 0 ? pages[pages.length - 1]! : await context.newPage();
  activeByContext.set(context, page);
  return page;
}
