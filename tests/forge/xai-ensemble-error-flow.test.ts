/**
 * Unit test for XaiEnsemble.callModel error-flow fix from the audit-LOW
 * sweep (PR follow-up to #204 HIGH-2). The pre-fix code overloaded
 * `lastError` with both an HTTP body string and a caught Error, and a
 * 3x-429 rate-limit exhaust produced a confusing "Failed to call xAI
 * model after retries: undefined" message. The fix uses a typed
 * `Error | undefined` slot and synthesises an Error inside the 429
 * branch so the exhausted message is always meaningful.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XaiEnsemble } from '../../src/core/forge/xai-ensemble.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mock429Thrice(): void {
  let calls = 0;
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    calls++;
    return {
      status: 429,
      ok: false,
      headers: { get: (h: string) => (h === 'Retry-After' ? '0' : null) },
      text: async () => `attempt ${calls} rate limited`,
      json: async () => ({}),
    };
  });
}

describe('XaiEnsemble.callModel — lastError flow', () => {
  it('emits a meaningful error message on 3x-429 exhaust (no "undefined" leak)', async () => {
    mock429Thrice();
    const xai = new XaiEnsemble();

    await expect(
      xai.callModel('docs', [{ role: 'user', content: 'hi' }])
    ).rejects.toThrowError(/Failed to call xAI model after retries: xAI API rate-limited \(status 429\); backed off up to \d+ms per attempt/);
  });

  it('does NOT contain the legacy "undefined" sentinel after 3x-429', async () => {
    mock429Thrice();
    const xai = new XaiEnsemble();

    try {
      await xai.callModel('docs', [{ role: 'user', content: 'hi' }]);
      throw new Error('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toMatch(/undefined/);
    }
  });
});
