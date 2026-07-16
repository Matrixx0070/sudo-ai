/**
 * @file gdrive/backoff.ts
 * @description Exponential backoff with full jitter for retryable Drive errors.
 *
 * Retries only kinds classified retryable by errors.ts (rate / server /
 * network). Base 500ms doubling per attempt, full jitter, 30s cap, max
 * attempts configurable (default 5 retries = 6 calls total).
 */

import { mapGdriveError } from './errors.js';

export interface BackoffOptions {
  maxRetries?: number;
  baseMs?: number;
  capMs?: number;
  /** Injectable RNG for deterministic tests. */
  random?: () => number;
  /** Injectable sleeper for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry — used for audit/log hooks. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

export function backoffDelayMs(
  attempt: number,
  baseMs = 500,
  capMs = 30_000,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/** Run `fn`, retrying retryable Drive errors. Rethrows a GdriveApiError. */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const mapped = mapGdriveError(err);
      if (!mapped.retryable || attempt >= maxRetries) throw mapped;
      const delay = backoffDelayMs(attempt, opts.baseMs, opts.capMs, opts.random);
      opts.onRetry?.(attempt + 1, delay, mapped);
      await sleep(delay);
    }
  }
}
