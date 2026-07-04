/**
 * @file index.ts
 * @description Browser toolkit — registers all browser tools into the ToolRegistry.
 *
 * Tools registered:
 *   browser.launch      — Launch/close/list/connect named Chromium instances (CDP)
 *   browser.navigate    — Navigate to a URL
 *   browser.interact    — Click, type, scroll, select, press, hover
 *   browser.scrape      — Extract structured data from the page
 *   browser.screenshot  — Capture page or element screenshots
 *   browser.auth        — Login, check session, save/load cookies
 *   browser.fill-form   — Fill forms from a data map
 *   browser.captcha     — Detect CAPTCHA presence
 *   browser.download    — Download files via URL or element click
 *   browser.tabs        — Open, close, switch, list browser tabs
 *   browser.profiles    — Create, list, delete browser profile directories
 *   browser.vision      — Analyze screenshots/images with GPT-4o vision
 *   browser.snapshot    — Accessibility tree snapshot of the current page
 *   browser.click       — Click an element by CSS or text selector
 *   browser.type        — Type text into an input field
 *   browser.file_upload — Upload files to a file input element
 *   browser.wait        — Wait for text, selector, or fixed time
 *   browser.mouse       — Coordinate-based mouse actions (click x/y, drag, scroll, keypress)
 *   browser.network     — Inspect captured network responses (status, URL, failures)
 *   browser.console     — Read captured console messages and page errors
 *   browser.history     — Session history navigation (back, forward, reload)
 */

import type { ToolRegistry } from '../../registry.js';
import { browserManagerTool } from './browser-manager.js';
import { navigateTool } from './navigate.js';
import { interactTool } from './interact.js';
import { scrapeTool } from './scrape.js';
import { screenshotTool } from './screenshot.js';
import { authTool } from './auth.js';
import { formFillerTool } from './form-filler.js';
import { captchaTool } from './captcha.js';
import { downloadTool } from './download.js';
import { tabManagerTool } from './tab-manager.js';
import { profilesTool } from './profiles.js';
import { visionTool } from './vision.js';
import { searchTool } from './search.js';
import { fetchUrlTool } from './fetch-url.js';
import { snapshotTool } from './snapshot.js';
import { clickTool } from './click.js';
import { typeTool } from './type.js';
import { fileUploadTool } from './file-upload.js';
import { waitTool } from './wait.js';
import { mouseTool } from './mouse.js';
import { networkTool } from './network.js';
import { consoleTool } from './console-log.js';
import { historyTool } from './history.js';
import { registerComputerUseTools } from './computer-use-tool.js';

/** All browser tools in stable registration order. */
export const BROWSER_TOOLS = [
  browserManagerTool,
  navigateTool,
  interactTool,
  scrapeTool,
  screenshotTool,
  authTool,
  formFillerTool,
  captchaTool,
  downloadTool,
  tabManagerTool,
  profilesTool,
  visionTool,
  searchTool,
  fetchUrlTool,
  snapshotTool,
  clickTool,
  typeTool,
  fileUploadTool,
  waitTool,
  mouseTool,
  networkTool,
  consoleTool,
  historyTool,
] as const;

/**
 * Register all browser tools with the given registry.
 * Called once during application startup by the tool loader.
 */
export function registerBrowserTools(registry: ToolRegistry): void {
  for (const tool of BROWSER_TOOLS) {
    registry.register(tool);
  }
  registerComputerUseTools(registry);
}

// Upgrade 57: Computer Use Agent
export { executeComputerAction } from './computer-use.js';
export type { ScreenAction, ComputerUseResult } from './computer-use.js';

// Phase 6: CDP Browser Integration
export { CDPManager } from './cdp-manager.js';
export { SnapshotEngine } from './snapshot-engine.js';
export type { SnapshotStyle, SnapshotResult, SnapshotElement } from './snapshot-engine.js';
export { SSRFGuard } from './ssrf-guard.js';
export type { SSRFResult, SSRFConfig } from './ssrf-guard.js';
