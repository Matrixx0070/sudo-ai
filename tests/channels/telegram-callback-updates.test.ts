/**
 * Regression: inline-button (callback_query) updates must be REQUESTED from
 * Telegram and DISPATCHED by the poll loop.
 *
 * 2026-07-29 prod bug: the poll loop requested `allowed_updates=["message"]`
 * and additionally skipped any update without `.message`. Both independently
 * dropped every inline-button tap — the 👍👎⏭ feedback keyboard, TX1 Stop and
 * TX3 Details rendered but were dead on arrival, with no server-side trace.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { POLL_ALLOWED_UPDATES } from '../../src/core/channels/telegram.js';

const SRC = readFileSync(new URL('../../src/core/channels/telegram.ts', import.meta.url), 'utf8');

describe('telegram poll loop — callback_query delivery', () => {
  it('requests callback_query updates (and still messages)', () => {
    expect([...POLL_ALLOWED_UPDATES]).toContain('callback_query');
    expect([...POLL_ALLOWED_UPDATES]).toContain('message');
  });

  it('builds the getUpdates URL from the constant, not a hardcoded list', () => {
    expect(SRC).toMatch(/allowed_updates=\$\{encodeURIComponent\(JSON\.stringify\(POLL_ALLOWED_UPDATES\)\)\}/);
    expect(SRC).not.toContain('allowed_updates=["message"]');
  });

  it('does not skip updates that carry only a callback_query', () => {
    // The guard must admit callback-only updates.
    expect(SRC).toContain('if (!update.message && !update.callback_query) continue;');
  });

  it('serialises the allowed_updates list as a valid JSON array', () => {
    const encoded = encodeURIComponent(JSON.stringify(POLL_ALLOWED_UPDATES));
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual(['message', 'callback_query']);
  });
});
