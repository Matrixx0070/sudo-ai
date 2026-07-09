/**
 * Tests for the post-run persist glue.
 *
 * Contract: the session is re-saved ONLY when post-run blocks (CompletionVerify
 * retry, universal-negative guard) appended messages after the end-of-run save;
 * ZDR is honored; a failing save never throws out of the turn.
 */
import { describe, it, expect, vi } from 'vitest';
import { persistPostRunAppends } from '../../src/core/agent/post-run-persist.js';

describe('persistPostRunAppends', () => {
  it('saves when messages were appended after the end-of-run save', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const outcome = await persistPostRunAppends({
      sessionId: 's1',
      persistedThrough: 10,
      currentLength: 11,
      zdrBlocked: false,
      save,
    });
    expect(outcome).toBe('saved');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not save when nothing was appended', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const outcome = await persistPostRunAppends({
      sessionId: 's1',
      persistedThrough: 10,
      currentLength: 10,
      zdrBlocked: false,
      save,
    });
    expect(outcome).toBe('no-appends');
    expect(save).not.toHaveBeenCalled();
  });

  it('does not save when the message array shrank (compaction edge)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const outcome = await persistPostRunAppends({
      sessionId: 's1',
      persistedThrough: 10,
      currentLength: 7,
      zdrBlocked: false,
      save,
    });
    expect(outcome).toBe('no-appends');
    expect(save).not.toHaveBeenCalled();
  });

  it('honors ZDR: appended but persistence blocked', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const outcome = await persistPostRunAppends({
      sessionId: 's1',
      persistedThrough: 10,
      currentLength: 12,
      zdrBlocked: true,
      save,
    });
    expect(outcome).toBe('zdr-skipped');
    expect(save).not.toHaveBeenCalled();
  });

  it('fail-open: a rejecting save is swallowed and reported as error', async () => {
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const outcome = await persistPostRunAppends({
      sessionId: 's1',
      persistedThrough: 10,
      currentLength: 11,
      zdrBlocked: false,
      save,
    });
    expect(outcome).toBe('error');
    expect(save).toHaveBeenCalledTimes(1);
  });
});
