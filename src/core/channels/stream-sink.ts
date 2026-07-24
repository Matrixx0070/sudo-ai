/**
 * @file stream-sink.ts
 * @description Channel-streaming primitive (gap #19).
 *
 * Today only the HTTP/SSE/WebSocket channels deliver tokens during
 * generation; Telegram / Discord / Slack etc. buffer the full reply and
 * send it once. The agent loop already emits `{ type: 'stream-chunk',
 * chunk }` events during generation (loop.ts:2119), but no chat-channel
 * consumer hooks them.
 *
 * `BufferedEditSink` is the smallest useful streaming surface: it opens a
 * placeholder message via a caller-supplied `open()` callback, accumulates
 * incoming chunks into a single rolling buffer, and edits the placeholder
 * via `edit()` at most once per `intervalMs` (default 800 ms — Telegram's
 * `editMessageText` rate-limits at ~1 edit per second per chat). The
 * caller's `finalize(text)` flushes the final text with one last edit so
 * the user sees the complete reply even if the rate limiter dropped the
 * last in-flight edit.
 *
 * Design choices:
 *
 *   - Pure primitive — no Telegram (or any other) dependency. The two
 *     callbacks (`open`, `edit`) are the only seam. This keeps the module
 *     unit-testable without spinning up a real bot.
 *   - Same-text suppression — if the buffer has not changed since the last
 *     edit, we skip the API call. Telegram returns 400 on a noop edit.
 *   - One in-flight edit at a time. While an edit is awaited, incoming
 *     chunks are merged into the buffer; the next edit fires after the
 *     in-flight one settles AND the debounce window has elapsed.
 *   - Cancel semantics — `cancel()` aborts pending edits. The placeholder
 *     stays in place with whatever the last successful edit wrote; the
 *     caller decides whether to send a separate error message or to fold
 *     in a marker via one final `edit()` of its own.
 *
 * Granularity note: the agent loop emits `stream-chunk` once per LLM
 * round-trip (loop.ts:2119, gated on `response.content`), NOT per-token.
 * With a single-shot non-tool turn this sink receives exactly one chunk
 * and a `finalize()`; with a tool-using agent, chunks arrive between
 * tool calls. Sub-token granularity requires brain-level streaming —
 * separate gap.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:stream-sink');

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Callback that opens a placeholder message and returns its
 * channel-specific id. The id will be passed back to `edit` on each
 * subsequent edit and on `finalize`.
 */
export type OpenFn = (placeholder: string) => Promise<string | number>;

/**
 * Callback that edits a previously-opened message in place. Implementations
 * should be idempotent on the same text — `BufferedEditSink` already
 * suppresses same-text edits, but a defensive impl protects against races.
 */
export type EditFn = (messageId: string | number, text: string) => Promise<void>;

export interface BufferedEditSinkOptions {
  /** Minimum ms between two edits. Default 800 ms (Telegram-safe). */
  intervalMs?: number;
  /** Placeholder text shown immediately, before any chunks arrive. */
  placeholder?: string;
  /**
   * Optional max chars for intermediate streaming edits — channels with
   * their own limits (Telegram: 4096) truncate-with-marker during the
   * progressive update phase. finalize() never clamps; the channel
   * edit() impl is expected to chunk overflow itself.
   */
  maxChars?: number;
  /**
   * Optional logger label so a long-running session can identify which
   * sink the timings came from. Default 'sink'.
   */
  label?: string;
}

export interface StreamSink {
  /** Append a chunk of generated text to the buffer. */
  chunk(text: string): void;
  /**
   * Flush the final text with a single edit, regardless of the debounce
   * window. Returns once the final edit has settled (or failed silently).
   */
  finalize(finalText: string): Promise<void>;
  /**
   * Abort the stream. Suppresses any pending edit; the caller is
   * responsible for sending an error message if desired.
   */
  cancel(): Promise<void>;
  /** Total chars accumulated so far. */
  readonly bufferLength: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a buffered, edit-throttled streaming sink.
 *
 * Lifecycle:
 *   1. The factory calls `open(placeholder)` once to obtain a messageId.
 *   2. Each `chunk(text)` appends to the rolling buffer. If we're not
 *      already mid-edit and the debounce window has elapsed, schedule the
 *      next edit on the next macrotask.
 *   3. `finalize(text)` overwrites the buffer with the final text and
 *      forces one last edit, awaited.
 *   4. `cancel()` cancels any scheduled edit; pending in-flight edit is
 *      still awaited to completion to keep the message in a consistent
 *      state.
 *
 * `open()` is awaited synchronously inside this factory before any chunks
 * can be processed; if it rejects, the returned sink is a NOOP that logs.
 */
export async function createBufferedEditSink(
  open: OpenFn,
  edit: EditFn,
  options: BufferedEditSinkOptions = {},
): Promise<StreamSink> {
  const intervalMs = options.intervalMs ?? 800;
  const placeholder = options.placeholder ?? '…';
  const maxChars = options.maxChars ?? 8000;
  const label = options.label ?? 'sink';

  let messageId: string | number | null = null;
  try {
    messageId = await open(placeholder);
  } catch (err) {
    log.warn({ err: String(err), label }, 'open() failed — returning noop sink');
    return makeNoopSink();
  }

  let buffer = '';
  let lastEditedText = placeholder;
  let lastEditAt = 0;
  let inFlight: Promise<void> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let finalized = false;

  /**
   * Intermediate streaming edits must fit a single channel message
   * (Telegram: 4096). Truncate with a marker so progressive updates stay
   * under the cap. finalize() deliberately does NOT clamp — the channel
   * edit() impl (e.g. telegram.editText) is responsible for chunking the
   * full body and sending overflow as follow-up messages so the tail is
   * never silently dropped.
   */
  function clampForChannel(text: string): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 16) + '\n…[truncated]';
  }

  async function flushEdit(): Promise<void> {
    if (cancelled || finalized) return;
    if (inFlight) return; // serialise edits
    if (messageId === null) return;

    const text = clampForChannel(buffer || placeholder);
    if (text === lastEditedText) return; // noop suppression

    const targetText = text;
    inFlight = (async () => {
      try {
        await edit(messageId!, targetText);
        lastEditedText = targetText;
        lastEditAt = Date.now();
      } catch (err) {
        // Per-edit failures are logged at warn but do not abort the
        // stream — a transient rate limit or network blip on edit N
        // should not stop edit N+1 from trying. Stamp lastEditAt so the
        // next retry still respects the debounce window — without this
        // a 429 from Telegram triggers an immediate aggressive re-edit
        // and cascading rate limits (verifier HIGH #4).
        log.warn({ err: String(err), label }, 'edit() failed — continuing');
        lastEditAt = Date.now();
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  function schedule(): void {
    if (cancelled || finalized) return;
    if (pendingTimer !== null) return;
    if (messageId === null) return;
    const elapsed = Date.now() - lastEditAt;
    const wait = Math.max(0, intervalMs - elapsed);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void flushEdit().then(() => {
        if (!cancelled && !finalized && buffer !== lastEditedText) {
          schedule();
        }
      });
    }, wait);
  }

  return {
    chunk(text: string): void {
      if (cancelled || finalized) return;
      if (!text) return;
      buffer += text;
      schedule();
    },

    async finalize(finalText: string): Promise<void> {
      if (cancelled || finalized) return;
      finalized = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (inFlight) {
        try { await inFlight; } catch { /* already logged */ }
      }
      if (messageId === null) return;
      // Pass the FULL final body to edit() — do NOT clamp. Channel adapters
      // (telegram.editText) chunk overflow and send follow-up messages so the
      // tail is never silently dropped with a [truncated] marker.
      const target = finalText ?? buffer;
      if (target === lastEditedText) return;
      // Defense-in-depth: an empty final edit makes Telegram throw
      // `400: message text is empty` (a content-filter/phantom turn hits this).
      // Callers normalise empties via normalizeReplyText upstream; if one still
      // reaches here, skip the edit rather than 400 — the placeholder stays put.
      if (target.trim().length === 0) return;
      try {
        await edit(messageId, target);
        lastEditedText = target;
      } catch (err) {
        log.warn({ err: String(err), label }, 'finalize edit failed');
      }
    },

    async cancel(): Promise<void> {
      cancelled = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (inFlight) {
        try { await inFlight; } catch { /* already logged */ }
      }
    },

    get bufferLength(): number {
      return buffer.length;
    },
  };
}

function makeNoopSink(): StreamSink {
  return {
    chunk(): void { /* noop */ },
    async finalize(): Promise<void> { /* noop */ },
    async cancel(): Promise<void> { /* noop */ },
    get bufferLength(): number { return 0; },
  };
}
