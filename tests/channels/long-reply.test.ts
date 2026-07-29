/**
 * planLongReply — delivery-mode planning for replies past Telegram's 4096-char
 * bubble cap: single bubble / newline-boundary chunks / attached-file with
 * preview. chunkText moved here from telegram.ts (shared, unchanged logic).
 */
import { describe, it, expect } from 'vitest';
import {
  planLongReply,
  chunkText,
  DEFAULT_CHUNK_LIMIT,
  DEFAULT_FILE_THRESHOLD,
} from '../../src/core/channels/long-reply.js';

describe('chunkText', () => {
  it('returns one chunk when text fits', () => {
    expect(chunkText('short', 100)).toEqual(['short']);
  });

  it('prefers newline boundaries and respects the limit', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}`;
    const chunks = chunkText(text, 100);
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it('never splits a surrogate pair at the cut', () => {
    const text = `${'x'.repeat(99)}😀${'y'.repeat(50)}`;
    const chunks = chunkText(text, 100);
    expect(chunks.join('')).toContain('😀');
    for (const c of chunks) expect(c).not.toContain('�');
  });
});

describe('planLongReply', () => {
  it('single mode at or under the chunk limit', () => {
    const plan = planLongReply('x'.repeat(DEFAULT_CHUNK_LIMIT));
    expect(plan.mode).toBe('single');
    expect(plan.chunks).toHaveLength(1);
  });

  it('chunks mode between one bubble and the file threshold', () => {
    const plan = planLongReply('line\n'.repeat(1200)); // ~6000 chars
    expect(plan.mode).toBe('chunks');
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNK_LIMIT);
  });

  it('file mode past the threshold, with preview + char count + filename', () => {
    const body = 'word '.repeat(4000); // 20k chars
    const plan = planLongReply(body);
    expect(plan.mode).toBe('file');
    expect(plan.filename).toBe('reply.md');
    expect(plan.chunks).toHaveLength(1);
    const preview = plan.chunks[0]!;
    expect(preview.length).toBeLessThan(800);
    expect(preview).toContain('📄 Full reply attached (20,000 chars).');
  });

  it('fileThreshold 0 disables file mode (always chunks)', () => {
    const plan = planLongReply('z\n'.repeat(10_000), { fileThreshold: 0 });
    expect(plan.mode).toBe('chunks');
  });

  it('threshold boundary: exactly at threshold stays chunks, above goes file', () => {
    expect(planLongReply('a'.repeat(DEFAULT_FILE_THRESHOLD)).mode).toBe('chunks');
    expect(planLongReply('a'.repeat(DEFAULT_FILE_THRESHOLD + 1)).mode).toBe('file');
  });

  it('is total on junk input', () => {
    expect(planLongReply(undefined as unknown as string).mode).toBe('single');
    expect(planLongReply('abc', { fileThreshold: Number.NaN }).mode).toBe('single');
  });
});
