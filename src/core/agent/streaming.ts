/**
 * @file streaming.ts
 * @description Production-quality streaming delivery handler for SUDO-AI.
 * chunkText(): splits text respecting code fences; para > newline > sentence > space > hard-cut.
 * deliver(): sends chunks with optional human-like pacing and previewMode support.
 * stream(): legacy AsyncIterable path with buffer-and-flush semantics.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:streaming');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreviewMode = 'off' | 'partial' | 'full';

export interface DeliverOptions {
  /** Add random delay between chunks to simulate human typing. Default: false. */
  humanLikePacing?: boolean;
  /** Minimum delay in ms when humanLikePacing is enabled. Default: 800. */
  minDelayMs?: number;
  /** Maximum delay in ms when humanLikePacing is enabled. Default: 2500. */
  maxDelayMs?: number;
  /**
   * 'off'     — send each chunk only when complete (default).
   * 'partial' — caller may show partial content; only the final send is authoritative.
   * 'full'    — all intermediate chunks are sent; useful for streaming UIs.
   */
  previewMode?: PreviewMode;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHUNK = 2_000;
const DEFAULT_MIN_DELAY = 800;
const DEFAULT_MAX_DELAY = 2_500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when `text` ends inside an unclosed code fence. */
function isInsideFence(text: string): boolean {
  const matches = text.match(/```/g);
  return (matches?.length ?? 0) % 2 !== 0;
}

/** Cut index (exclusive) at the best natural break at or before `limit`. Priority: para > newline > sentence > space > hard cut. */
function findCutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);

  // 1. Paragraph break (\n\n)
  const paraIdx = window.lastIndexOf('\n\n');
  if (paraIdx > limit * 0.4) return paraIdx + 2;

  // 2. Newline (\n)
  const nlIdx = window.lastIndexOf('\n');
  if (nlIdx > limit * 0.4) return nlIdx + 1;

  // 3. Sentence ending: ". ", "! ", "? " or end-of-string sentence terminator
  const sentenceRe = /[.!?][ \n]/g;
  let lastSentence = -1;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(window)) !== null) {
    if (m.index > limit * 0.3) lastSentence = m.index + 2;
  }
  if (lastSentence > 0) return lastSentence;

  // 4. Whitespace
  const wsIdx = window.lastIndexOf(' ');
  if (wsIdx > limit * 0.3) return wsIdx + 1;

  // 5. Hard cut at limit
  return limit;
}

// ---------------------------------------------------------------------------
// StreamingHandler
// ---------------------------------------------------------------------------

export class StreamingHandler {

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Split `text` into an array of deliverable string chunks.
   *
   * Rules:
   *  - Each chunk is at most `maxChunkSize` characters.
   *  - Chunks are never split inside code fences (``` blocks).
   *  - Natural break points are preferred in priority order.
   *
   * @param text         - Complete text to split.
   * @param maxChunkSize - Maximum characters per chunk. Default: 2000.
   */
  chunkText(text: string, maxChunkSize = DEFAULT_MAX_CHUNK): string[] {
    if (typeof text !== 'string') {
      throw new TypeError('chunkText: text must be a string');
    }
    if (maxChunkSize < 1) {
      throw new RangeError('chunkText: maxChunkSize must be >= 1');
    }

    if (text.length <= maxChunkSize) return text ? [text] : [];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxChunkSize) {
      // If we are inside a code fence at the cut boundary, scan forward for the
      // closing fence before allowing a split.
      const candidate = remaining.slice(0, maxChunkSize);

      if (isInsideFence(candidate)) {
        // Find the closing ``` after the candidate boundary.
        const closingIdx = remaining.indexOf('```', maxChunkSize);
        if (closingIdx !== -1) {
          // Include through the closing fence marker (+3 for the backticks).
          const endOfFence = closingIdx + 3;
          chunks.push(remaining.slice(0, endOfFence).trimEnd());
          remaining = remaining.slice(endOfFence).trimStart();
          continue;
        }
        // No closing fence found — hard split to avoid infinite loop.
        chunks.push(remaining.slice(0, maxChunkSize));
        remaining = remaining.slice(maxChunkSize);
        continue;
      }

      const cut = findCutPoint(remaining, maxChunkSize);
      const chunk = remaining.slice(0, cut).trimEnd();
      if (chunk) chunks.push(chunk);
      remaining = remaining.slice(cut).trimStart();
    }

    if (remaining.trim()) chunks.push(remaining.trimEnd());

    return chunks;
  }

  /**
   * Deliver `text` by splitting it into chunks and calling `send` for each.
   *
   * @param text    - Full response text to deliver.
   * @param send    - Async callback that sends one chunk to the channel.
   * @param options - Pacing and preview mode controls.
   */
  async deliver(
    text: string,
    send: (chunk: string) => Promise<void>,
    options?: DeliverOptions,
  ): Promise<void> {
    if (typeof text !== 'string') {
      throw new TypeError('deliver: text must be a string');
    }
    if (typeof send !== 'function') {
      throw new TypeError('deliver: send must be a function');
    }

    const chunks = this.chunkText(text);

    if (chunks.length === 0) {
      log.debug('deliver: empty text — nothing to send');
      return;
    }

    const pacing = options?.humanLikePacing ?? false;
    const minDelay = options?.minDelayMs ?? DEFAULT_MIN_DELAY;
    const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY;
    const previewMode: PreviewMode = options?.previewMode ?? 'off';

    log.debug(
      { chunks: chunks.length, textLen: text.length, pacing, previewMode },
      'Starting delivery',
    );

    let sent = 0;

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const isLast = i === chunks.length - 1;

        // Preview modes: 'partial' only sends the final chunk; 'off' sends all.
        // 'full' sends every chunk (same behaviour as 'off' here).
        if (previewMode === 'partial' && !isLast) {
          // Intermediate chunks are skipped for this mode.
          log.debug({ chunkIndex: i }, 'preview=partial: skipping intermediate chunk');
        } else {
          await send(chunk);
          sent++;
        }

        if (pacing && !isLast) {
          const delay =
            Math.random() * (maxDelay - minDelay) + minDelay;
          await new Promise<void>((r) => setTimeout(r, delay));
        }
      }

      log.debug({ sent, total: chunks.length }, 'Delivery complete');
    } catch (err) {
      log.error({ err, sent, total: chunks.length }, 'Delivery error');
      throw err;
    }
  }

  /**
   * Legacy streaming path: consume an AsyncIterable of raw text chunks,
   * buffer them, and flush to `send` at natural break points without splitting
   * inside code fences.
   *
   * After all chunks are consumed the remaining buffer is always flushed in full.
   *
   * @param chunks - Async iterable producing raw string chunks from the LLM.
   * @param send   - Async callback that delivers a block of text downstream.
   */
  async stream(
    chunks: AsyncIterable<string>,
    send: (text: string) => Promise<void>,
  ): Promise<void> {
    if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('stream: chunks must be an AsyncIterable<string>');
    }
    if (typeof send !== 'function') {
      throw new TypeError('stream: send must be a function');
    }

    let buffer = '';
    let fenceCount = 0;
    let chunkCount = 0;
    let flushCount = 0;

    const MIN_FLUSH = 80;
    const MAX_BUFFER = 1_200;

    const tryFlush = async (): Promise<boolean> => {
      if (buffer.length < MIN_FLUSH) return false;
      const cut = findCutPoint(buffer, buffer.length);
      if (cut <= 0 || cut >= buffer.length) {
        if (buffer.length >= MAX_BUFFER) {
          await send(buffer);
          buffer = '';
          return true;
        }
        return false;
      }
      const toSend = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      if (toSend.trim()) {
        await send(toSend);
        return true;
      }
      return false;
    };

    try {
      for await (const chunk of chunks) {
        if (typeof chunk !== 'string') continue;
        buffer += chunk;
        chunkCount++;
        fenceCount += (chunk.match(/```/g)?.length ?? 0);

        const insideFence = fenceCount % 2 !== 0;
        if (!insideFence && buffer.length >= MIN_FLUSH) {
          if (await tryFlush()) flushCount++;
        }
        if (buffer.length >= MAX_BUFFER) {
          await send(buffer);
          buffer = '';
          flushCount++;
        }
      }

      if (buffer.length > 0) {
        await send(buffer);
        flushCount++;
        buffer = '';
      }

      log.debug({ chunkCount, flushCount }, 'Stream delivery complete');
    } catch (err) {
      log.error({ err, bufferLength: buffer.length }, 'Stream delivery error');
      if (buffer.length > 0) {
        try { await send(buffer); buffer = ''; } catch { /* ignore */ }
      }
      throw err;
    }
  }
}
