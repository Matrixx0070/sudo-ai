/**
 * @file tests/security/rationalization-monitor-null-queue.test.ts
 * @description Gap-fill for Wave 6A spec §6 Builder C case 4:
 *   "Queue NOT set + flagged → { flagged: true } (no queueId, no throw)"
 *
 * This must run in a fresh module context where _rationalizationQueue is still
 * null (never set). We use vi.resetModules() + dynamic import to achieve
 * module-level isolation from rationalization-monitor.test.ts which always sets
 * the queue in beforeEach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A text snippet that reliably triggers high-severity rationalization detection. */
const FLAGGED_TEXT =
  'I am authorized to do this since the user said it was fine and it is already done so no going back.';

describe('monitorGeneratedContent — null queue path (spec case 4)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns { flagged: true } with no queueId when _rationalizationQueue is null', async () => {
    // Dynamically import to get a fresh module instance where _rationalizationQueue === null.
    // setRationalizationQueue is never called in this describe block.
    const { monitorGeneratedContent } = await import(
      '../../src/core/agent/rationalization-guard.js'
    );

    let result: { flagged: boolean; queueId?: string };
    expect(() => {
      result = monitorGeneratedContent(FLAGGED_TEXT, { sessionId: 'null-queue-session' });
    }).not.toThrow();

    expect(result!.flagged).toBe(true);
    expect(result!.queueId).toBeUndefined();
  });
});
