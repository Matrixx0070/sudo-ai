/**
 * General-purpose utility functions for SUDO-AI v3.
 * All functions are pure or have clearly documented side effects.
 */

import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe unique identifier (21 characters by default).
 *
 * @returns A collision-resistant random string.
 */
export function genId(): string {
  return nanoid();
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of a UTF-8 string.
 * Used for content-addressable storage and deduplication.
 *
 * @param text - Input string to hash.
 * @returns 64-character lowercase hex string.
 */
export function contentHash(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError('contentHash: input must be a string');
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Async control
// ---------------------------------------------------------------------------

/**
 * Retry an async operation with configurable attempts and per-attempt backoff.
 *
 * @param fn          - Async factory that may throw.
 * @param maxAttempts - Total number of attempts (default 3).
 * @param backoffMs   - Array of wait durations in ms between attempts.
 *                      If the array is shorter than `maxAttempts - 1` the last
 *                      entry is reused for remaining gaps.
 * @returns Resolved value of `fn` on first success.
 * @throws The last error if all attempts are exhausted.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  backoffMs: number[] = [1_000, 2_000, 4_000],
): Promise<T> {
  if (maxAttempts < 1) throw new RangeError('retry: maxAttempts must be >= 1');

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt < maxAttempts) {
        const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1_000;
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Sleep for a given number of milliseconds.
 *
 * @param ms - Duration in milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  if (ms < 0) ms = 0;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a debounced version of a function.
 * The returned function delays invocation until `ms` milliseconds have elapsed
 * since the last call.
 *
 * @param fn - Function to debounce.
 * @param ms - Quiet period in milliseconds.
 * @returns Debounced wrapper with the same signature as `fn`.
 */
export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  if (ms < 0) throw new RangeError('debounce: ms must be >= 0');

  let timer: ReturnType<typeof setTimeout> | undefined;

  const wrapped = (...args: unknown[]): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };

  return wrapped as T;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Truncate `text` to at most `maxChars` characters, breaking at a word
 * boundary when possible and appending an ellipsis.
 *
 * @param text     - Input string.
 * @param maxChars - Maximum character count (inclusive of ellipsis).
 * @returns Truncated string, or the original if it already fits.
 */
export function truncate(text: string, maxChars: number): string {
  if (typeof text !== 'string') return '';
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const ellipsis = '…';
  const limit = maxChars - ellipsis.length;
  if (limit <= 0) return ellipsis.slice(0, maxChars);

  // Try to break at the last whitespace within limit.
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > limit * 0.5 ? slice.slice(0, lastSpace) : slice;

  return cut + ellipsis;
}

/**
 * Rough token count estimate (4 characters ≈ 1 token).
 * Suitable for quick budget checks; not a substitute for a real tokenizer.
 *
 * @param text - Input string.
 * @returns Estimated token count.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Date / time
// ---------------------------------------------------------------------------

/**
 * Return today's date as an ISO-8601 date string (YYYY-MM-DD, UTC).
 *
 * @returns e.g. `"2026-03-26"`
 */
export function todayISO(): string {
  return new Date().toISOString().split('T')[0] as string;
}

/**
 * Calculate the number of days elapsed since an ISO date string.
 *
 * @param isoDate - Date string parseable by `new Date()` (e.g. `"2026-01-01"`).
 * @returns Fractional number of days since `isoDate` (may be negative if future).
 */
export function ageInDays(isoDate: string): number {
  const ms = Date.now() - new Date(isoDate).getTime();
  return ms / (1_000 * 60 * 60 * 24);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string, returning `fallback` on any parse error.
 *
 * @param json     - Raw JSON string.
 * @param fallback - Value to return if parsing fails.
 * @returns Parsed value or fallback.
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
