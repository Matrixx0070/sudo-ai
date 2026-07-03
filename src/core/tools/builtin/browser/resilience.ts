/**
 * @file resilience.ts
 * @description Self-healing primitives for autonomous browser actions.
 *
 * Anthropic's Playwright MCP performs an action once and errors if it fails,
 * leaving recovery to the model or a human. For an unattended agent that is the
 * top reliability gap. These helpers let each action recover in-harness:
 *   - withRetry: retry transient Playwright failures with exponential backoff.
 *   - robustFill: fill(), verify the value stuck, and fall back to sequential
 *     key entry for contenteditable / rich (React/Slate) editors where fill()
 *     silently no-ops.
 *
 * Retry is on by default; SUDO_BROWSER_RETRY=0 disables it (single attempt),
 * SUDO_BROWSER_RETRY_ATTEMPTS overrides the attempt count.
 */

import type { Locator } from 'playwright-core';

/** Sleep helper (uses a timer; deterministic delays only, no Date.now). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the configured attempt count, honoring the kill-switch. */
export function configuredAttempts(): number {
  if (process.env['SUDO_BROWSER_RETRY'] === '0') return 1;
  const raw = process.env['SUDO_BROWSER_RETRY_ATTEMPTS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 3;
}

/**
 * Classify an error as a transient, worth-retrying browser failure. Conservative:
 * timeouts, detached/destroyed contexts, navigations mid-action, pointer
 * interception, and transient visibility/stability failures.
 */
export function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('detached') ||
    msg.includes('not attached') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('target closed') ||
    msg.includes('target crashed') ||
    msg.includes('navigating') ||
    msg.includes('navigation') ||
    msg.includes('intercepts pointer events') ||
    msg.includes('element is not stable') ||
    msg.includes('element is not visible') ||
    msg.includes('connection closed')
  );
}

export interface RetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  retryable?: (err: unknown) => boolean;
  /** Called before each retry (not before the first attempt). */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff. Non-retryable
 * errors (and the final attempt) rethrow immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> {
  const attempts = opts?.attempts ?? configuredAttempts();
  const base = opts?.baseDelayMs ?? 150;
  const retryable = opts?.retryable ?? isRetryableError;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !retryable(err)) throw err;
      opts?.onRetry?.(i + 1, err);
      await sleep(base * 2 ** i);
    }
  }
  throw lastErr;
}

/** Result of a robustFill — which strategy actually set the value. */
export interface FillResult {
  method: 'fill' | 'sequential';
}

/**
 * Fill an input reliably. For plain inputs/textarea, use fill() and verify the
 * value stuck; if it didn't (or the target is contenteditable / a rich editor
 * where fill() no-ops), clear and type the text key-by-key. This closes the
 * silent-no-op class the audit found in browser.type.
 */
export async function robustFill(
  locator: Locator,
  text: string,
  opts?: { timeout?: number },
): Promise<FillResult> {
  const timeout = opts?.timeout;
  const editable = await locator.evaluate((el) => (el as HTMLElement).isContentEditable).catch(() => false);

  if (!editable) {
    try {
      await locator.fill(text, { timeout });
      // Verify for form controls. inputValue throws on non-inputs — treat as "no
      // read-back available" and trust the fill.
      const val = await locator.inputValue({ timeout: 1000 }).catch(() => null);
      if (val === null || val === text) return { method: 'fill' };
      // fill() reported success but the value did not stick — fall through.
    } catch (err) {
      if (!isRetryableError(err)) throw err;
      // transient — fall through to sequential entry
    }
  }

  // contenteditable, rich editor, or fill mismatch: focus, clear, type sequentially.
  await locator.click({ timeout }).catch(() => {});
  await locator.press('ControlOrMeta+a', { timeout }).catch(() => {});
  await locator.press('Delete', { timeout }).catch(() => {});
  await locator.pressSequentially(text, { timeout });
  return { method: 'sequential' };
}
