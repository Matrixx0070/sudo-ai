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
 * trimming either the head cut or the tail ring, so rendered output is always
 * valid UTF-16.
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
 * Largest cut index `<= max` that does not split a surrogate pair, i.e. never
 * leaves a lone high surrogate as the last retained code unit. Mirrors
 * `keepLast` for the head side of the buffer.
 */
function safeHeadCut(s: string, max: number): number {
  if (max >= s.length) return s.length;
  const last = s.charCodeAt(max - 1);
  // A high surrogate at the boundary would be split from its low half — step back.
  return last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
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
      const cut = safeHeadCut(chunk, room);
      this.head += chunk.slice(0, cut);
      chunk = chunk.slice(cut);
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

/** Default model-facing tool-output budget, matching system.exec's MAX_OUTPUT. */
const DEFAULT_TOOL_OUTPUT_MAX = 8_000;

/**
 * Clamp a tool's model-facing output string to `maxChars` with a 50/50
 * head/tail split and a marker reporting the original size. Identity for
 * text within budget. `maxChars` is measured in UTF-16 code units
 * (String.length), not bytes.
 */
export function clampToolOutput(
  text: string,
  maxChars: number = DEFAULT_TOOL_OUTPUT_MAX,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const half = Math.floor(maxChars / 2);
  const { text: clamped, truncated } = clampHeadTail(text, {
    headBudget: half,
    tailBudget: maxChars - half,
    elisionMarker: `...[truncated — ${text.length} total chars, {n} elided]...`,
  });
  return { text: clamped, truncated };
}
