/**
 * @file channels/long-reply.ts
 * @description Long-reply delivery planning for chat surfaces.
 *
 * Telegram hard-caps message bodies at 4096 chars. Before this module the
 * streamed path simply truncated the final edit with `…[truncated]`, losing
 * content. The planner picks one of three delivery modes:
 *
 *   - 'single' — fits in one bubble (the common case, unchanged).
 *   - 'chunks' — split on newline boundaries into ≤chunkLimit pieces; the
 *     first piece edits the working bubble in place, the rest follow as
 *     ordinary messages.
 *   - 'file'   — very long replies ship as an attached .md document with a
 *     short preview in the bubble, instead of a wall of 5+ bubbles.
 *
 * Pure and total: no I/O, no clock, never throws. The channel owns actual
 * delivery (and timestamps for filenames).
 */

/** One-bubble Telegram body cap (Bot API limit). */
export const TELEGRAM_CHUNK_LIMIT = 4096;

/**
 * Default per-chunk limit for multi-bubble delivery. Deliberately under the
 * 4096 wire cap so a chunk survives the stream sink's 4080 clamp and any
 * marker suffixes without re-truncation.
 */
export const DEFAULT_CHUNK_LIMIT = 4000;

/** Default char count above which a reply ships as a file (≈4+ bubbles). */
export const DEFAULT_FILE_THRESHOLD = 12_000;

/** Max preview chars shown in the bubble when the reply ships as a file. */
const PREVIEW_CHARS = 600;

/**
 * Split text into chunks of at most `limit` characters, splitting on
 * newlines where possible to avoid mid-sentence breaks.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakAt = slice.lastIndexOf('\n');
    let cut = breakAt > limit * 0.5 ? breakAt : limit;
    // CH-5: don't split a UTF-16 surrogate pair at the boundary — that mangles an
    // emoji into two U+FFFD replacement chars. Move the whole pair to the next chunk.
    if (cut < remaining.length) {
      const c = remaining.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface LongReplyPlan {
  mode: 'single' | 'chunks' | 'file';
  /** Delivery bodies. single → [text]; chunks → the pieces; file → [preview]. */
  chunks: string[];
  /** file mode only: suggested filename (caller may prefix a timestamp). */
  filename?: string;
}

export interface LongReplyOptions {
  /** Per-bubble char limit for chunked delivery. Default 4000. */
  chunkLimit?: number;
  /** Chars above which the reply ships as a file. 0 disables file mode. Default 12000. */
  fileThreshold?: number;
}

/** Cut at a word boundary near `max`, appending an ellipsis when cut. */
function previewOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const space = slice.lastIndexOf(' ');
  return `${slice.slice(0, space > max * 0.6 ? space : max).trimEnd()}…`;
}

/** Decide how a reply should be delivered given channel size limits. */
export function planLongReply(text: string, options: LongReplyOptions = {}): LongReplyPlan {
  const body = typeof text === 'string' ? text : String(text ?? '');
  const chunkLimit = Math.max(1, Math.min(options.chunkLimit ?? DEFAULT_CHUNK_LIMIT, TELEGRAM_CHUNK_LIMIT));
  const rawThreshold = options.fileThreshold ?? DEFAULT_FILE_THRESHOLD;
  const fileThreshold = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? rawThreshold : DEFAULT_FILE_THRESHOLD;

  if (body.length <= chunkLimit) return { mode: 'single', chunks: [body] };

  if (fileThreshold > 0 && body.length > fileThreshold) {
    const preview = `${previewOf(body, PREVIEW_CHARS)}\n\n📄 Full reply attached (${body.length.toLocaleString('en-US')} chars).`;
    return { mode: 'file', chunks: [preview], filename: 'reply.md' };
  }

  return { mode: 'chunks', chunks: chunkText(body, chunkLimit) };
}
