/**
 * TX3 — working-card-keyboard pure builder tests.
 */
import { describe, expect, it } from 'vitest';
import {
  buildWorkingCardRows,
  parseTx3CallbackData,
  tx3CallbackData,
  TX3_CALLBACK_PREFIX,
} from '../../../src/core/channels/working-card-keyboard.js';

describe('working-card-keyboard', () => {
  it('returns no rows when no buttons are requested', () => {
    expect(buildWorkingCardRows({})).toEqual([]);
  });

  it('builds a Details button when compact (label advertises next state)', () => {
    const rows = buildWorkingCardRows({ detail: { token: 'abc123', detailNow: false } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]![0]!.text).toContain('Details');
    expect(rows[0]![0]!.callbackData).toBe('tx3:t:abc123');
  });

  it('builds a Compact button when detail is on', () => {
    const rows = buildWorkingCardRows({ detail: { token: 'abc123', detailNow: true } });
    expect(rows[0]![0]!.text).toContain('Compact');
    expect(rows[0]![0]!.callbackData).toBe('tx3:t:abc123');
  });

  it('composes stop + detail on one row (TX1/TX3 shared card)', () => {
    const rows = buildWorkingCardRows({
      stop: { token: 'run1' },
      detail: { token: 'tok2', detailNow: false },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.map((b) => b.callbackData)).toEqual(['tx1:stop:run1', 'tx3:t:tok2']);
    expect(rows[0]![0]!.text).toContain('Stop');
  });

  it('keeps callback data within Telegram\'s 64-byte budget for registry tokens', () => {
    const data = tx3CallbackData('A'.repeat(12));
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(data.startsWith(TX3_CALLBACK_PREFIX)).toBe(true);
  });

  it('round-trips tokens through parseTx3CallbackData', () => {
    expect(parseTx3CallbackData(tx3CallbackData('x9_-Zz'))).toBe('x9_-Zz');
  });

  it('rejects malformed or foreign callback data', () => {
    expect(parseTx3CallbackData('fb:good:123')).toBeNull();
    expect(parseTx3CallbackData('tx3:t:')).toBeNull();
    expect(parseTx3CallbackData('tx3:x:abc')).toBeNull();
    expect(parseTx3CallbackData('tx3:t:has:colon')).toBeNull();
    expect(parseTx3CallbackData('')).toBeNull();
  });
});
