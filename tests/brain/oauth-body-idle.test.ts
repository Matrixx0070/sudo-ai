import { describe, it, expect } from 'vitest';
import { attachBodyIdleTimeout } from '../../src/core/brain/providers';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Drain a stream to a single decoded string, or throw if it errors. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe('attachBodyIdleTimeout', () => {
  it('forwards a healthy stream unchanged and never aborts', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('hello '));
        c.enqueue(enc.encode('world'));
        c.close();
      },
    });
    const ac = new AbortController();
    const wrapped = attachBodyIdleTimeout(body, ac, 1000, 'test-model');

    expect(await drain(wrapped)).toBe('hello world');
    expect(ac.signal.aborted).toBe(false);
  });

  it('aborts the request when the body goes silent past the idle window', async () => {
    // A body that delivers one chunk then stalls forever (never closes).
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('partial')); },
      // no further enqueue, no close -> the next read hangs
    });
    const ac = new AbortController();
    const wrapped = attachBodyIdleTimeout(body, ac, 40, 'stalled-model');
    const reader = wrapped.getReader();

    // First chunk arrives immediately, resetting the timer.
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe('partial');
    expect(ac.signal.aborted).toBe(false);

    // The second read hangs; the idle timer (40ms) must fire and abort.
    const aborted = await new Promise<boolean>((resolve) => {
      ac.signal.addEventListener('abort', () => resolve(true), { once: true });
      setTimeout(() => resolve(ac.signal.aborted), 120);
    });
    expect(aborted).toBe(true);
    expect(ac.signal.aborted).toBe(true);
  });

  it('does not abort a slow-but-alive stream that keeps feeding the timer', async () => {
    // Chunks every 20ms with a 50ms idle window: each chunk re-arms the timer
    // before it can fire, so a healthy slow stream survives.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        let n = 0;
        const tick = (): void => {
          if (n >= 4) { c.close(); return; }
          c.enqueue(enc.encode(`chunk${n++} `));
          setTimeout(tick, 20);
        };
        setTimeout(tick, 20);
      },
    });
    const ac = new AbortController();
    const wrapped = attachBodyIdleTimeout(body, ac, 50, 'slow-model');

    expect(await drain(wrapped)).toBe('chunk0 chunk1 chunk2 chunk3 ');
    expect(ac.signal.aborted).toBe(false);
  });

  it('propagates cancellation to the underlying reader', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('x')); },
      cancel() { cancelled = true; },
    });
    const ac = new AbortController();
    const wrapped = attachBodyIdleTimeout(body, ac, 1000, 'test-model');
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel('done');

    expect(cancelled).toBe(true);
    // Cancelling clears the idle timer, so no spurious abort fires afterward.
    await new Promise((r) => setTimeout(r, 30));
    expect(ac.signal.aborted).toBe(false);
  });
});
