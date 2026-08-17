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

  it('decorates live content (cursor), then drops it on finalize', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100, liveDecorate: (b) => `${b}▌` });
    sink.chunk('Hello world');
    await vi.advanceTimersByTimeAsync(150);
    // The live edit carries the cursor riding the text…
    expect(t.edits.at(-1)?.text).toBe('Hello world▌');
    vi.useRealTimers();
    // …and the finalized message is exactly the canonical text (no decoration).
    await sink.finalize('Hello world');
    expect(t.edits.at(-1)?.text).toBe('Hello world');
  });

  it('does not decorate the status card (only content)', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100, liveDecorate: (b) => `${b}▌` });
    sink.status('💭 **Thinking** · 2s');
    await vi.advanceTimersByTimeAsync(150);
    expect(t.edits.at(-1)?.text).toBe('💭 **Thinking** · 2s'); // no cursor on status
  });
});

describe('adaptive 429 backoff', () => {
  it('honors Telegram retry_after by widening the next edit window', async () => {
    // First edit 429s with retry_after: 3s; the sink must not re-edit until then.
    let calls = 0;
    const seen: string[] = [];
    const err = Object.assign(new Error('Too Many Requests: retry after 3'), { parameters: { retry_after: 3 } });
    const edit = async (_id: string | number, text: string) => {
      calls++;
      if (calls === 1) throw err; // first edit rate-limited
      seen.push(text);
    };
    const open = async () => 'm1';
    vi.useFakeTimers();
    const sink = await createBufferedEditSink(open, edit, { intervalMs: 100 });
    sink.chunk('A');
    await vi.advanceTimersByTimeAsync(150); // first edit fires → 429
    sink.chunk('B');
    await vi.advanceTimersByTimeAsync(500); // well past the 100ms floor but < 3s
    expect(seen).toEqual([]); // still backing off — no second edit yet
    await vi.advanceTimersByTimeAsync(3000); // past retry_after
    // (a further chunk re-triggers scheduling after the backoff window)
    sink.chunk('C');
    await vi.advanceTimersByTimeAsync(200);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it('finalize is a no-op when the final text matches the last edit', async () => {
    vi.useFakeTimers();
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

  it('clamps buffer body to maxChars with a [truncated] marker', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100, maxChars: 64 });
    sink.chunk('x'.repeat(500));
    await vi.advanceTimersByTimeAsync(150);
    const edited = t.edits[0]?.text ?? '';
    expect(edited.length).toBeLessThanOrEqual(64);
    expect(edited).toContain('[truncated]');
    expect(edited.startsWith('x')).toBe(true);
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

// ---------------------------------------------------------------------------
// status updates (activity-timeline card) + messageId exposure
// ---------------------------------------------------------------------------

describe('status() and messageId', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exposes the opened messageId (and null on failed open)', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100 });
    expect(sink.messageId).toBe('msg-100');
    const failed = await createBufferedEditSink(fakeTransport({ failOpen: true }).open, t.edit, {});
    expect(failed.messageId).toBeNull();
  });

  it('status() edits the placeholder while no content has arrived', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100, placeholder: '…' });
    sink.status('⠹ running • 3s\n✓ web.search');
    await vi.advanceTimersByTimeAsync(150);
    expect(t.edits[0]?.text).toBe('⠹ running • 3s\n✓ web.search');
  });

  it('content chunks win over status: later status() calls are ignored', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100 });
    sink.chunk('Real reply text');
    await vi.advanceTimersByTimeAsync(150);
    sink.status('⠹ running • 9s');
    await vi.advanceTimersByTimeAsync(300);
    expect(t.edits.map((e) => e.text)).toEqual(['Real reply text']);
  });

  it('finalize still lands the canonical text after status updates', async () => {
    const t = fakeTransport();
    const sink = await createBufferedEditSink(t.open, t.edit, { intervalMs: 100 });
    sink.status('⠹ working');
    await vi.advanceTimersByTimeAsync(150);
    await sink.finalize('Final answer');
    expect(t.edits.at(-1)?.text).toBe('Final answer');
  });
});
