/**
 * @file _browser-available.ts
 * @description Helper for real-browser tests. CI does not install Playwright
 * browser binaries (the repo's integration tests skip gracefully when Chromium
 * is absent), so suites that launch a real browser gate on this and skip rather
 * than hard-fail. Underscore prefix + no `.test` suffix keeps vitest from
 * collecting this file as a suite.
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

/** True when a launchable Chromium binary exists on this machine. */
export function browserAvailable(): boolean {
  try {
    const p = chromium.executablePath();
    return typeof p === 'string' && p.length > 0 && existsSync(p);
  } catch {
    return false;
  }
}
