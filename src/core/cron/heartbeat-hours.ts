/**
 * Active hours helpers for HeartbeatRunner.
 *
 * Exported separately to keep heartbeat.ts under the 250-line limit.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cron:heartbeat-hours');

/**
 * Parse an "HH" or "HH:MM" string into fractional hours (e.g. "09:30" → 9.5).
 * Returns null when the input is absent or unparseable.
 */
export function parseHour(raw: string | undefined): number | null {
  if (!raw) return null;
  const parts = raw.trim().split(':');
  const h = parseInt(parts[0] ?? '0', 10);
  const m = parseInt(parts[1] ?? '0', 10);
  if (isNaN(h) || h < 0 || h > 23) return null;
  return h + m / 60;
}

/**
 * Return true if `now` (evaluated in the given IANA timezone) falls within
 * the half-open interval [startHour, endHour).
 *
 * When either bound is null the window is treated as unbounded (always active).
 * Supports windows that wrap midnight (e.g. startHour=22, endHour=6).
 *
 * @param now       - Current wall-clock time.
 * @param timezone  - IANA timezone string (e.g. "Asia/Kolkata").
 * @param startHour - Fractional hour for window open, or null for no restriction.
 * @param endHour   - Fractional hour for window close, or null for no restriction.
 */
export function isWithinActiveHours(
  now: Date,
  timezone: string,
  startHour: number | null,
  endHour: number | null,
): boolean {
  if (startHour === null || endHour === null) return true;

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    const current = h + m / 60;

    if (startHour <= endHour) {
      return current >= startHour && current < endHour;
    }
    // Window wraps midnight (e.g. 22:00–06:00).
    return current >= startHour || current < endHour;
  } catch (err) {
    log.warn(
      { err: String(err), timezone },
      'isWithinActiveHours: timezone evaluation failed — defaulting to active',
    );
    return true;
  }
}
