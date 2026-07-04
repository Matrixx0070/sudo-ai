/**
 * @file browser-recovery.ts
 * @description Live-loop self-heal + escalation for browser actions.
 *
 * The browser tools already retry transient failures in-process (resilience.ts).
 * This closes the loop ACROSS tool calls: when a browser action still fails, the
 * agent loop augments the model-facing result with a FRESH stable-ref snapshot so
 * the model can immediately retry with current refs — instead of spending a turn
 * calling browser.snapshot itself or reusing a stale ref. After repeated failures
 * on the same task it escalates: notifies the operator and tells the model to stop
 * repeating the action.
 *
 * Wired into executeSingleToolCall as a separate `recoveryHint` field (mirroring
 * errorHint/preventionHint) so the recorded outcome / trace stay the raw output.
 * Fail-open. Kill-switch SUDO_BROWSER_RECOVERY=0; escalation threshold via
 * SUDO_BROWSER_RECOVERY_ESCALATE (default 3).
 */

import { createLogger } from '../shared/logger.js';
// STATIC imports (not dynamic import()) so this module shares the exact same
// module instance / singleton as the browser tools. A dynamic import under the
// tsx prod runtime could resolve BrowserManager to a SECOND module instance with
// an empty `instances` map → get('default') undefined → snapshot silently null.
// (The "vitest masks prod" ESM landmine class.) These modules do not import from
// agent/, so static imports are cycle-safe.
import type { Page } from 'playwright-core';
import { BrowserManager } from '../tools/builtin/browser/browser-manager.js';
import { resolveActivePage } from '../tools/builtin/browser/active-page.js';
import { captureStableRefs } from '../tools/builtin/browser/stable-ref.js';
import { notify as proactiveNotify } from '../awareness/proactive-notifier.js';

const log = createLogger('browser-recovery');

/** Browser ACTION tools whose failures trigger recovery. Read tools excluded. */
const BROWSER_ACTION_TOOLS = new Set([
  'browser.click',
  'browser.type',
  'browser.interact',
  'browser.navigate',
  'browser.mouse',
  'browser.fill-form',
  'browser.file_upload',
]);

/** True if the tool is a browser action (not a read/inspect tool). */
export function isBrowserActionTool(name: string): boolean {
  return BROWSER_ACTION_TOOLS.has(name);
}

/** Recovery is on by default; SUDO_BROWSER_RECOVERY=0 disables it. */
export function isBrowserRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_BROWSER_RECOVERY'] !== '0';
}

/** Consecutive-failure count that triggers operator escalation. */
function escalateThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SUDO_BROWSER_RECOVERY_ESCALATE']);
  return Number.isInteger(n) && n >= 2 && n <= 20 ? n : 3;
}

/** Per-session consecutive browser-action failure counters. */
const failureCounts = new Map<string, number>();

/** Clear the failure counter for a session (call on a successful browser action). */
export function resetBrowserRecovery(sessionId: string): void {
  failureCounts.delete(sessionId);
}

/** Injectable side-effects so the controller unit-tests without a real browser. */
export interface BrowserRecoveryDeps {
  /** Fresh stable-ref snapshot listing for the browser, or null if unavailable. */
  snapshot?: (browserName: string) => Promise<string | null>;
  /** Operator hand-off notification. */
  notify?: (title: string, message: string) => void;
}

export interface BrowserRecoveryOutcome {
  /** Text to append to the model-facing tool message (fresh refs or a stop directive). */
  hint?: string;
  /** True when this failure crossed the escalation threshold. */
  escalated: boolean;
}

/**
 * Compute recovery guidance for a FAILED browser action. Increments the session's
 * consecutive-failure counter; below threshold it returns a fresh snapshot to retry
 * with, at/after threshold it escalates (operator notify + stop directive) and resets.
 * Returns no hint for non-browser-action tools.
 */
export async function computeBrowserRecovery(
  input: { toolName: string; args: Record<string, unknown>; sessionId: string },
  deps: BrowserRecoveryDeps = {},
): Promise<BrowserRecoveryOutcome> {
  const { toolName, args, sessionId } = input;
  if (!isBrowserActionTool(toolName)) return { escalated: false };

  const n = (failureCounts.get(sessionId) ?? 0) + 1;
  failureCounts.set(sessionId, n);

  const browserName = typeof args['browser'] === 'string' ? (args['browser'] as string) : 'default';
  const notify = deps.notify ?? defaultNotify;

  if (n >= escalateThreshold()) {
    failureCounts.set(sessionId, 0);
    try {
      notify(
        'Browser task stuck',
        `${n} consecutive browser-action failures (last: ${toolName}). The agent has paused this ` +
          `browser task for operator review.`,
      );
    } catch (err) {
      log.warn({ err: String(err) }, 'recovery notify failed');
    }
    return {
      escalated: true,
      hint:
        `[BROWSER RECOVERY] ${n} consecutive browser-action failures on this task — operator notified. ` +
        `Stop repeating the same action. Re-plan: try a different element or approach, or await human input.`,
    };
  }

  // Below threshold: hand the model a fresh snapshot so it retries with current refs.
  const snapshot = deps.snapshot ?? defaultSnapshot;
  let snap: string | null = null;
  try {
    snap = await snapshot(browserName);
  } catch (err) {
    log.warn({ err: String(err) }, 'recovery snapshot failed');
  }
  if (snap && snap.trim()) {
    return {
      escalated: false,
      hint:
        `[BROWSER RECOVERY] The action failed. Below is a FRESH page snapshot with CURRENT stable refs — ` +
        `retry using an appropriate ref=N (refs change every snapshot; do not reuse old ones):\n${snap}`,
    };
  }
  return { escalated: false };
}

// --- default side-effects (real browser + notifier), lazily imported ---------

async function defaultSnapshot(browserName: string): Promise<string | null> {
  const mgr = BrowserManager.getInstance();
  const inst = mgr.get(browserName) ?? mgr.get('default');
  if (!inst) {
    // No live browser session to snapshot. Logged (not silent) so a genuine
    // "recovery couldn't perceive" is diagnosable instead of vanishing.
    log.warn({ browserName }, 'recovery: no browser instance available to snapshot');
    return null;
  }
  try {
    const page = await resolveActivePage(inst);
    return await captureFreshSnapshot(page);
  } catch (err) {
    log.warn({ browserName, err: String(err) }, 'recovery: fresh snapshot capture failed');
    return null;
  }
}

/**
 * Capture a fresh stable-ref snapshot for recovery, letting the page SETTLE first.
 *
 * A failed browser action often triggered a navigation, so at recovery time the
 * page can be blank/transitioning — capturing then yields "(no actionable elements
 * found)" and the fresh refs are useless. So: wait for the in-flight navigation to
 * reach domcontentloaded (bounded), and if the first capture still finds nothing,
 * give it a brief moment and retry once. All waits are fail-open.
 */
export async function captureFreshSnapshot(page: Page): Promise<string> {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  let captured = await captureStableRefs(page);
  if (captured.refs.length === 0) {
    await page.waitForTimeout(600).catch(() => {});
    captured = await captureStableRefs(page);
  }
  return captured.render;
}

function defaultNotify(title: string, message: string): void {
  try {
    proactiveNotify('warning', title, message, 'high');
  } catch (err) {
    log.warn({ err: String(err) }, 'recovery: operator notify failed');
  }
}
