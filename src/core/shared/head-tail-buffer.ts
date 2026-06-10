/**
 * @file shared/head-tail-buffer.ts
 * @description Bounded output capture that keeps the HEAD and the TAIL of a
 * stream while shedding the middle.
 *
 * Motivation
 * ----------
 * Naive output capture for shell/process tools keeps only the first N characters
 * (head-only truncation). For command output that is the wrong end to keep: the
 * most diagnostically useful bytes are at BOTH ends — the head carries the
 * command's initial output (what it set out to do) and the tail carries the
 * error message and exit status (why it stopped). Dropping the tail routinely
 * discards the single most important line the model needs to recover.
 *
 * HeadTailBuffer keeps a configurable budget of head characters and tail
 * characters, sheds the middle once both fill, and renders a single elision
 * marker noting how much was dropped. Modeled on the OpenAI Codex CLI
 * `head_tail_buffer.rs` pattern (50/50 split by default).
 *
 * Units
 * -----
 * This buffer operates on JavaScript string length (UTF-16 code units), not raw
 * bytes, because its primary consumer is model-facing tool output measured
 * against a token budget. It never splits in the middle of a surrogate pair when
 * trimming the tail ring, so rendered output is always valid UTF-16.
 *
 * Memory
 * ------
 * The buffer retains at most `headBudget + tailBudget` characters regardless of
 * how much is pushed, so it is safe to stream arbitrarily large output through
 * it. The tail is kept in a single rolling string that is trimmed whenever it
 * exceeds its budget.
 */

export interface HeadTailBufferOptions {
  /** Max characters retained from the start of the stream. Default 4000. */
  headBudget?: number;
  /** Max characters retained from the end of the stream. Default 4000. */
  tailBudget?: number;
  /**
   * Marker template inserted between head and tail when content is shed.
   * `{n}` is replaced with the number of dropped characters. A trailing and
   * leading newline are added automatically so the marker sits on its own line.
   */
  elisionMarker?: string;
}

const DEFAULT_HEAD = 4000;
const DEFAULT_TAIL = 4000;
const DEFAULT_MARKER = '...[{n} characters elided]...';

/** Trim a string to its last `max` chars without splitting a surrogate pair. */
function keepLast(s: string, max: number): string {
  if (s.length <= max) return s;
  let start = s.length - max;
  // If the cut point lands on the low half of a surrogate pair, step forward
  // one so we never emit a lone surrogate.
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return s.slice(start);
}

/**
 * Streaming bounded buffer that preserves the head and tail of pushed content.
 *
 * Usage:
 * ```ts
 * const buf = new HeadTailBuffer();
 * buf.push(chunkA);
 * buf.push(chunkB);
 * const text = buf.toString();      // head + elision + tail
 * const { totalChars, droppedChars } = buf.stats();
 * ```
 */
export class HeadTailBuffer {
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private readonly marker: string;

  private head = '';
  /** Rolling tail; trimmed to tailBudget on every push once head is full. */
  private tail = '';
  private total = 0;

  constructor(opts: HeadTailBufferOptions = {}) {
    this.headBudget = Math.max(0, opts.headBudget ?? DEFAULT_HEAD);
    this.tailBudget = Math.max(0, opts.tailBudget ?? DEFAULT_TAIL);
    this.marker = opts.elisionMarker ?? DEFAULT_MARKER;
  }

  /** Append a chunk. Safe to call with arbitrarily large strings. */
  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;

    // Fill the head budget first.
    if (this.head.length < this.headBudget) {
      const room = this.headBudget - this.head.length;
      if (chunk.length <= room) {
        this.head += chunk;
        return;
      }
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }

    // Everything past the head feeds the rolling tail.
    this.tail = keepLast(this.tail + chunk, this.tailBudget);
  }

  /** Total characters pushed across the buffer's lifetime. */
  get length(): number {
    return this.total;
  }

  /** Number of characters shed from the middle (0 when nothing was dropped). */
  private dropped(): number {
    const kept = this.head.length + this.tail.length;
    return Math.max(0, this.total - kept);
  }

  /** Whether any content was elided from the middle. */
  get truncated(): boolean {
    return this.dropped() > 0;
  }

  /** Structured stats for logging/metrics. */
  stats(): { totalChars: number; keptChars: number; droppedChars: number; truncated: boolean } {
    const dropped = this.dropped();
    return {
      totalChars: this.total,
      keptChars: this.head.length + this.tail.length,
      droppedChars: dropped,
      truncated: dropped > 0,
    };
  }

  /** Render head + (elision marker) + tail. */
  toString(): string {
    const dropped = this.dropped();
    if (dropped === 0) return this.head + this.tail;
    const marker = this.marker.replace('{n}', String(dropped));
    return `${this.head}\n${marker}\n${this.tail}`;
  }
}

/**
 * One-shot convenience: clamp an already-materialized string to a head+tail
 * budget. Equivalent to pushing the whole string through a HeadTailBuffer.
 *
 * @returns the clamped text and whether any middle content was elided.
 */
export function clampHeadTail(
  text: string,
  opts: HeadTailBufferOptions = {},
): { text: string; truncated: boolean; droppedChars: number } {
  const buf = new HeadTailBuffer(opts);
  buf.push(text);
  const { droppedChars } = buf.stats();
  return { text: buf.toString(), truncated: droppedChars > 0, droppedChars };
}
