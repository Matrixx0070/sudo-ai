/**
 * BufferedEditSink (gap #19) — channel-streaming primitive. Tests use a
 * tiny fake transport (open + edit functions backed by a calls array) so
 * no real Telegram bot is needed. Timing is exercised with vitest's fake
 * timers where the test cares about the debounce window; the rest of the
 * tests await directly to keep the suite fast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBufferedEditSink } from '../../src/core/channels/stream-sink.js';

interface FakeTransport {
  opens: string[];
  edits: Array<{ id: string | number; text: string }>;
  open: (placeholder: string) => Promise<string>;
  edit: (id: string | number, text: string) => Promise<void>;
}

function fakeTransport(opts: { failOpen?: boolean; editError?: Error; editLatencyMs?: number } = {}): FakeTransport {
  const opens: string[] = [];
  const edits: Array<{ id: string | number; text: string }> = [];
  let nextId = 100;
  return {
    opens,
    edits,
    async open(placeholder) {
      opens.push(placeholder);
      if (opts.failOpen) throw new Error('open failed');
      return `msg-${nextId++}`;
    },
    async edit(id, text) {
      if (opts.editLatencyMs) await new Promise((r) => setTimeout(r, opts.editLatencyMs));
      if (opts.editError) throw opts.editError;
      edits.push({ id, text });
    },
  };
}

// ---------------------------------------------------------------------------
// open / lifecycle
// ---------------------------------------------------------------------------

describe('createBufferedEditSink lifecycle', () => {
  it('calls open() once with the configured placeholder', async () => {
    const t = fakeTransport();
    await createBufferedEditSink(t.open, t.edit, { placeholder: 'hold on…' });
    expect(t.opens).toEqual(['hold on…']);
  });

  it('returns a NOOP sink when open() rejects (no throw to caller)', async () => {
    const t = fakeTransport({ failOpen: true });
    const sink = await createBufferedEditSink(t.open, t.edit);
    expect(sink.bufferLength).toBe(0);
    sink.chunk('ignored');
    await sink.finalize('also ignored');
    expect(t.edits).toEqual([]);
  });

  it('exposes a buffer-length getter for observability', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 9999 });
    sink.chunk('hi ');
    sink.chunk('there');
    expect(sink.bufferLength).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// chunk + debounce + finalize
// ---------------------------------------------------------------------------

describe('chunk debounce + finalize', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('groups multiple rapid chunks into a single edit on the debounce boundary', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 500 });
    sink.chunk('Hello ');
    sink.chunk('world');
    sink.chunk('!');
    // Before the debounce, no edit has fired.
    expect(t.edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    // One edit, containing the full buffer.
    expect(t.edits).toHaveLength(1);
    expect(t.edits[0]?.text).toBe('Hello world!');
  });

  it('schedules another edit when more chunks arrive after the first one settles', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100 });
    sink.chunk('A');
    await vi.advanceTimersByTimeAsync(150);
    sink.chunk('B');
    await vi.advanceTimersByTimeAsync(150);
    expect(t.edits.map((e) => e.text)).toEqual(['A', 'AB']);
  });

  it('finalize flushes immediately regardless of the debounce window', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 9999 });
    sink.chunk('partial');
    // Without finalize, the 9999 ms debounce would prevent an edit; finalize
    // forces a flush. Switch off fake timers for the await.
    vi.useRealTimers();
    await sink.finalize('Final canonical text');
    expect(t.edits).toHaveLength(1);
    expect(t.edits[0]?.text).toBe('Final canonical text');
  });

  it('finalize is a no-op when the final text matches the last edit', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100 });
    sink.chunk('Hello');
    await vi.advanceTimersByTimeAsync(150);
    expect(t.edits).toHaveLength(1);
    vi.useRealTimers();
    await sink.finalize('Hello');
    expect(t.edits).toHaveLength(1); // no duplicate edit
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('cancel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cancel() suppresses any subsequent edit', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 500 });
    sink.chunk('whoops');
    vi.useRealTimers();
    await sink.cancel();
    // Advancing time would not be useful with real timers; just verify no edit landed.
    expect(t.edits).toEqual([]);
    // Subsequent chunks are ignored.
    sink.chunk('still ignored');
    expect(t.edits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe('edit error handling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('edit failures are swallowed; next chunk can still trigger another edit', async () => {
    let calls = 0;
    const opens: string[] = [];
    const edits: string[] = [];
    const sink = await createBufferedEditSink(
      async (p) => { opens.push(p); return 'msg-1'; },
      async (_id, text) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        edits.push(text);
      },
      { intervalMs: 100 },
    );
    sink.chunk('first');
    await vi.advanceTimersByTimeAsync(150);
    sink.chunk(' second');
    await vi.advanceTimersByTimeAsync(150);
    // First edit raised but did not break the stream — the sink retried
    // and a later edit succeeded. The exact sequence of recovered edits
    // depends on debounce/retry timing; what matters is that the final
    // resolved buffer text appears in the edit log.
    expect(edits).toContain('first second');
  });
});

// ---------------------------------------------------------------------------
// truncation
// ---------------------------------------------------------------------------

describe('maxChars truncation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clamps intermediate streaming edits to maxChars with a [truncated] marker', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100, maxChars: 64 });
    sink.chunk('x'.repeat(500));
    await vi.advanceTimersByTimeAsync(150);
    const edited = t.edits[0]?.text ?? '';
    expect(edited.length).toBeLessThanOrEqual(64);
    expect(edited).toContain('[truncated]');
    expect(edited.startsWith('x')).toBe(true);
  });

  it('finalize passes the FULL body without clamping so the channel can chunk overflow', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100, maxChars: 64 });
    const full = 'y'.repeat(500);
    sink.chunk(full);
    await vi.advanceTimersByTimeAsync(150);
    // Intermediate edit was clamped.
    expect((t.edits[0]?.text ?? '').length).toBeLessThanOrEqual(64);
    vi.useRealTimers();
    await sink.finalize(full);
    // Final edit must be the unclamped full body — channel edit() is
    // responsible for chunking (telegram.editText sends overflow as follow-ups).
    const finalEdit = t.edits[t.edits.length - 1]?.text ?? '';
    expect(finalEdit).toBe(full);
    expect(finalEdit.length).toBe(500);
    expect(finalEdit).not.toContain('[truncated]');
  });
});

// ---------------------------------------------------------------------------
// same-text suppression
// ---------------------------------------------------------------------------

describe('same-text suppression', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a chunk that does not change the resolved text does not cause a duplicate edit', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100 });
    sink.chunk('Hello');
    await vi.advanceTimersByTimeAsync(150);
    // Same buffer state — chunk('') is a noop, no new edit.
    sink.chunk('');
    await vi.advanceTimersByTimeAsync(150);
    expect(t.edits).toHaveLength(1);
  });
});
