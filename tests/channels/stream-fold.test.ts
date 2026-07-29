/**
 * TX5 — stream into the fold (SUDO_TG_STREAM_FOLD). Pure decision logic:
 * env resolution, threshold, per-message latch (no md↔md-collapse flicker),
 * status renders never fold, Read More master off-switch.
 */

import { describe, it, expect } from 'vitest';
import {
  createStreamFoldLatch,
  resolveStreamFoldOptions,
  DEFAULT_STREAM_FOLD_MIN,
} from '../../src/core/channels/stream-fold.js';

const long = (n: number): string => 'x'.repeat(n);

describe('resolveStreamFoldOptions', () => {
  it('defaults OFF with no env', () => {
    expect(resolveStreamFoldOptions({})).toEqual({ enabled: false, minChars: DEFAULT_STREAM_FOLD_MIN });
  });

  it('enables only on SUDO_TG_STREAM_FOLD=1', () => {
    expect(resolveStreamFoldOptions({ SUDO_TG_STREAM_FOLD: '1' }).enabled).toBe(true);
    expect(resolveStreamFoldOptions({ SUDO_TG_STREAM_FOLD: '0' }).enabled).toBe(false);
    expect(resolveStreamFoldOptions({ SUDO_TG_STREAM_FOLD: 'true' }).enabled).toBe(false);
  });

  it('SUDO_TG_READMORE=0 is a master off-switch', () => {
    expect(resolveStreamFoldOptions({ SUDO_TG_STREAM_FOLD: '1', SUDO_TG_READMORE: '0' }).enabled).toBe(false);
    expect(resolveStreamFoldOptions({ SUDO_TG_STREAM_FOLD: '1', SUDO_TG_READMORE: '1' }).enabled).toBe(true);
  });

  it('reuses SUDO_TG_READMORE_MIN semantics (positive finite, else default)', () => {
    expect(resolveStreamFoldOptions({ SUDO_TG_READMORE_MIN: '500' }).minChars).toBe(500);
    expect(resolveStreamFoldOptions({ SUDO_TG_READMORE_MIN: '0' }).minChars).toBe(DEFAULT_STREAM_FOLD_MIN);
    expect(resolveStreamFoldOptions({ SUDO_TG_READMORE_MIN: '-5' }).minChars).toBe(DEFAULT_STREAM_FOLD_MIN);
    expect(resolveStreamFoldOptions({ SUDO_TG_READMORE_MIN: 'nope' }).minChars).toBe(DEFAULT_STREAM_FOLD_MIN);
  });
});

describe('createStreamFoldLatch', () => {
  it('disabled → always md, even far past the threshold', () => {
    const fmt = createStreamFoldLatch({ enabled: false, minChars: 100 });
    expect(fmt(long(50), false)).toBe('md');
    expect(fmt(long(5000), false)).toBe('md');
  });

  it('enabled → md until the body exceeds minChars, then md-collapse', () => {
    const fmt = createStreamFoldLatch({ enabled: true, minChars: 100 });
    expect(fmt(long(100), false)).toBe('md'); // exactly at threshold = not over
    expect(fmt(long(101), false)).toBe('md-collapse');
  });

  it('LATCH: once folded, stays folded even for shorter bodies (no flicker)', () => {
    const fmt = createStreamFoldLatch({ enabled: true, minChars: 100 });
    expect(fmt(long(200), false)).toBe('md-collapse');
    expect(fmt(long(10), false)).toBe('md-collapse');
    expect(fmt(long(150), false)).toBe('md-collapse');
  });

  it('status renders NEVER fold and never set the latch', () => {
    const fmt = createStreamFoldLatch({ enabled: true, minChars: 100 });
    expect(fmt(long(5000), true)).toBe('md');
    // A long status did not latch: short content still renders md.
    expect(fmt(long(50), false)).toBe('md');
    // Content then latches; a subsequent status render still shows md.
    expect(fmt(long(200), false)).toBe('md-collapse');
    expect(fmt(long(5000), true)).toBe('md');
    // But content stays latched after the status interleave.
    expect(fmt(long(10), false)).toBe('md-collapse');
  });

  it('latch is per-instance (fresh message = fresh latch)', () => {
    const a = createStreamFoldLatch({ enabled: true, minChars: 100 });
    expect(a(long(200), false)).toBe('md-collapse');
    const b = createStreamFoldLatch({ enabled: true, minChars: 100 });
    expect(b(long(50), false)).toBe('md');
  });
});
