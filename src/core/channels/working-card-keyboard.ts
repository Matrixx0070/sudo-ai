/**
 * @file working-card-keyboard.ts
 * @description Pure builder for the inline keyboard attached to the live
 * "working card" (the BufferedEditSink placeholder message on Telegram).
 *
 * TX1 (⏹ Stop) and TX3 (Details ↔ Compact toggle) both hang buttons off the
 * same card; this module is the single place that composes those rows so the
 * two features share one keyboard at integration time. It is deliberately
 * channel-agnostic — no grammy / Telegram imports — returning plain
 * `{ text, callbackData }` button descriptors that the caller converts into
 * its platform keyboard type (grammY `InlineKeyboard` accepts
 * `new InlineKeyboard(rows.map(r => r.map(b => ({ text: b.text,
 * callback_data: b.callbackData }))))`).
 *
 * Callback-data prefixes (Telegram caps callback_data at 64 bytes):
 *   - TX1 stop:   `tx1:stop:<runKey>` (must match telegram-run-controls
 *     STOP_CALLBACK_PREFIX — the live tx1: handler parses that format)
 *   - TX3 detail: `tx3:t:<token>`  (token from working-card-state registry)
 */

/** One inline button: display label + raw callback data. */
export interface WorkingCardButton {
  text: string;
  callbackData: string;
}

/** Options describing which buttons the current turn's card should carry. */
export interface WorkingCardKeyboardOptions {
  /** TX1: include a ⏹ Stop button that aborts the run identified by `token`. */
  stop?: { token: string };
  /**
   * TX3: include the per-turn detail toggle. `detailNow` is the CURRENT
   * rendering mode; the button label advertises the NEXT state (tap target),
   * i.e. detailNow=false → "🔎 Details", detailNow=true → "▪ Compact".
   */
  detail?: { token: string; detailNow: boolean };
}

/** Callback-data prefix owned by the TX3 detail toggle. */
export const TX3_CALLBACK_PREFIX = 'tx3:';

/** Build the `tx3:t:<token>` callback data for a detail-toggle tap. */
export function tx3CallbackData(token: string): string {
  return `tx3:t:${token}`;
}

/** Parse `tx3:t:<token>` → token, or null if the data is not a TX3 toggle. */
export function parseTx3CallbackData(data: string): string | null {
  const m = /^tx3:t:([A-Za-z0-9_-]+)$/.exec(data);
  return m?.[1] ?? null;
}

/**
 * Compose the working-card keyboard rows from the requested options.
 * Returns [] when no buttons are requested — callers should then skip
 * attaching a keyboard entirely (Telegram rejects some empty-markup edits).
 */
export function buildWorkingCardRows(opts: WorkingCardKeyboardOptions): WorkingCardButton[][] {
  const row: WorkingCardButton[] = [];
  if (opts.stop) {
    // Format owned by telegram-run-controls (STOP_CALLBACK_PREFIX).
    row.push({ text: '⏹ Stop', callbackData: `tx1:stop:${opts.stop.token}` });
  }
  if (opts.detail) {
    row.push({
      text: opts.detail.detailNow ? '▪ Compact' : '🔎 Details',
      callbackData: tx3CallbackData(opts.detail.token),
    });
  }
  return row.length > 0 ? [row] : [];
}
