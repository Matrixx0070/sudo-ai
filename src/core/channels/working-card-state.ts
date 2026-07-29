/**
 * @file working-card-state.ts
 * @description TX3 — in-process registry linking a live working card (the
 * turn's placeholder message) to its per-turn render state.
 *
 * The render closure lives in cli.ts (`handleTelegramTurn`); the inline-button
 * callback lands in the Telegram adapter. This registry is the seam between
 * them: cli registers `{ getDetail, setDetail, rerender }` for the duration of
 * a turn (and unregisters in its `finally`), the adapter's `tx3:` callback
 * looks the token up and flips it.
 *
 * Pure module — no telegram / grammy imports, fully unit-testable. Tokens are
 * short random ids sized to fit Telegram's 64-byte callback_data budget.
 */

import { randomBytes } from 'node:crypto';

/** Per-turn working-card handle registered by the turn owner (cli.ts). */
export interface WorkingCardEntry {
  /** Current detail mode for THIS turn's card. */
  getDetail: () => boolean;
  /** Flip the turn's detail mode (the render closure reads it next render). */
  setDetail: (detail: boolean) => void;
  /**
   * Push an immediate card re-render through the turn's existing edit
   * throttle (e.g. `streamSink.status(timeline.render(...))`). Must not throw.
   */
  rerender: () => void;
}

/**
 * Bounded registry: a missed unregister (crashed turn) must not leak forever.
 * At the cap the oldest entry is evicted — its card simply stops toggling.
 */
const MAX_ENTRIES = 128;

const registry = new Map<string, WorkingCardEntry>();

/**
 * Register a live working card. Returns the token to embed in the card's
 * `tx3:t:<token>` callback data. Caller MUST `unregisterWorkingCard(token)`
 * when the turn ends (finally block).
 */
export function registerWorkingCard(entry: WorkingCardEntry): string {
  const token = randomBytes(9).toString('base64url'); // 12 chars, callback-safe
  if (registry.size >= MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  registry.set(token, entry);
  return token;
}

/** Look up a live card by token (undefined once the turn has ended). */
export function getWorkingCard(token: string): WorkingCardEntry | undefined {
  return registry.get(token);
}

/**
 * Flip the detail mode of the card identified by `token` and trigger its
 * re-render. Returns the NEW detail value, or null when the token is unknown
 * (turn already finished / evicted) so the caller can answer accordingly.
 */
export function toggleWorkingCardDetail(token: string): boolean | null {
  const entry = registry.get(token);
  if (!entry) return null;
  const next = !entry.getDetail();
  entry.setDetail(next);
  try {
    entry.rerender();
  } catch {
    /* rerender is best-effort — state already flipped */
  }
  return next;
}

/** Remove a card at end of turn. Idempotent. */
export function unregisterWorkingCard(token: string): void {
  registry.delete(token);
}

/** Number of live entries (test/introspection helper). */
export function workingCardCount(): number {
  return registry.size;
}
