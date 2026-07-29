/**
 * @file channels/stream-fold.ts
 * @description TX5 — stream into the fold (flag `SUDO_TG_STREAM_FOLD`, default OFF).
 *
 * Today a long reply streams full-height in the working bubble and only
 * collapses behind "Read More" at finalize. With the flag on, once the
 * streamed content passing through the sink's edit callback exceeds the
 * Read More threshold, mid-stream edits render with format 'md-collapse'
 * instead of 'md' — the bubble stays compact WHILE writing and the tail
 * keeps growing inside the expandable blockquote.
 *
 * Design:
 *   - Pure decision logic, zero Telegram dependency. The cli sink wiring
 *     calls the latch on every edit body and passes the result straight to
 *     `telegram.editText(..., { format })`.
 *   - LATCH semantics: flip-flopping between 'md' and 'md-collapse' across
 *     edits causes visible flicker (the blockquote appears/disappears), so
 *     once a message folds it stays folded for the rest of that stream.
 *     One latch per message — construct a fresh latch per turn.
 *   - Status renders (ActivityTimeline working card) must NEVER collapse:
 *     the caller flags them via `isStatus` and they always render 'md'.
 *     A status render can never set the latch either.
 *   - Threshold reuses the Read More semantics: `SUDO_TG_READMORE_MIN`
 *     (default 900 source chars, same default as the delivery path) and
 *     `SUDO_TG_READMORE=0` is the master off-switch for all folding.
 */

/** Mid-stream render format for the sink edit callback. */
export type StreamFormat = 'md' | 'md-collapse';

export interface StreamFoldOptions {
  /** Fold mid-stream at all? (flag + Read More master switch). */
  enabled: boolean;
  /** Fold once the edit body exceeds this many source chars. */
  minChars: number;
}

/** Default fold threshold — mirrors the Read More delivery default in cli.ts. */
export const DEFAULT_STREAM_FOLD_MIN = 900;

/**
 * Resolve TX5 options from an env map. Enabled only when
 * `SUDO_TG_STREAM_FOLD=1` AND Read More is not master-disabled
 * (`SUDO_TG_READMORE=0`). Threshold from `SUDO_TG_READMORE_MIN`
 * (positive finite number), default {@link DEFAULT_STREAM_FOLD_MIN}.
 */
export function resolveStreamFoldOptions(
  env: Record<string, string | undefined> = process.env,
): StreamFoldOptions {
  const enabled = env['SUDO_TG_STREAM_FOLD'] === '1' && env['SUDO_TG_READMORE'] !== '0';
  const rawMin = Number(env['SUDO_TG_READMORE_MIN']);
  const minChars = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : DEFAULT_STREAM_FOLD_MIN;
  return { enabled, minChars };
}

/**
 * Per-message fold latch. Returns the render format for one edit body.
 *
 *   - disabled → always 'md' (byte-identical to pre-TX5 behavior).
 *   - `isStatus` → always 'md', never sets the latch.
 *   - content body longer than `minChars` → 'md-collapse' and latch ON.
 *   - once latched, every subsequent content edit stays 'md-collapse'.
 */
export function createStreamFoldLatch(
  opts: StreamFoldOptions,
): (text: string, isStatus: boolean) => StreamFormat {
  let folded = false;
  return (text: string, isStatus: boolean): StreamFormat => {
    if (!opts.enabled) return 'md';
    if (isStatus) return 'md';
    if (!folded && typeof text === 'string' && text.length > opts.minChars) folded = true;
    return folded ? 'md-collapse' : 'md';
  };
}
