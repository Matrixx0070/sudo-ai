/**
 * @file grok-web-chat-drift-escalation.test.ts
 * @description Mid-retry escalation on statsig algorithm drift (2026-08-01 prod
 * incident).
 *
 * When grok changes the statsig algorithm, the pure-Node minter still produces
 * length-VALID tokens that the server rejects with 403 — the fault is
 * server-side and invisible in the token itself. Every token in the pool shares
 * that fault, so retrying WITHOUT demoting just burns the remaining attempts on
 * equally poisoned tokens. That was the live failure: "request rejected by
 * anti-bot rules even after fresh mints", with the demote firing only after all
 * attempts were already spent — so the call that detected the drift always died,
 * and only a LATER call benefited.
 *
 * The fix escalates on the FIRST rejection, so the call recovers itself.
 *
 * The pool is mocked file-scope: chatGrokWeb without an injected `mintStatsig`
 * would otherwise reach the real pool (network + browser).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const demoteSpy = vi.fn();
let browserlessActive = true;
/** Tokens handed out in order; 'POISON*' stands in for a drifted-algorithm mint. */
let acquired: string[] = [];

vi.mock('../../src/llm/grok-statsig-pool.js', () => ({
  getGrokStatsigPool: () => ({
    acquire: async () => {
      const t = browserlessActive ? 'POISON'.padEnd(94, 'x') : 'ORACLE'.padEnd(94, 'y');
      acquired.push(t.slice(0, 6));
      return t;
    },
  }),
  // Demoting flips the source, exactly as the real demote+purge does.
  demoteGrokBrowserlessStatsig: (...args: unknown[]) => {
    demoteSpy(...args);
    browserlessActive = false;
  },
  isGrokBrowserlessActive: () => browserlessActive,
}));

const SESSION = { cookie: 'cf_clearance=X; sso=Y', userAgent: 'UA' };
function fakeManager() {
  return { ensureHealthy: async () => SESSION } as unknown as
    import('../../src/llm/grok-web-session-manager.js').GrokWebSessionManager;
}

beforeEach(() => {
  process.env['SUDO_GROK_WEBSESSION'] = '1';
  process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '1';
  demoteSpy.mockClear();
  browserlessActive = true;
  acquired = [];
});
afterEach(() => {
  delete process.env['SUDO_GROK_WEBSESSION'];
  delete process.env['SUDO_GROK_STATSIG_BROWSERLESS'];
  vi.resetModules();
});

describe('chatGrokWeb — statsig drift escalation', () => {
  it('demotes on the FIRST 403 and recovers within the same call', async () => {
    const { chatGrokWeb } = await import('../../src/llm/grok-web-media.js');
    // Poisoned tokens 403; an oracle token succeeds.
    const bridge = vi.fn(async (_req: unknown, creds: { statsigId?: string }) =>
      creds.statsigId?.startsWith('POISON')
        ? { ok: false, status: 403, errorClass: 'statsig' }
        : { ok: true, text: 'PONG' },
    );

    const r = await chatGrokWeb('hi', {
      deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 },
    });

    // The call itself recovered — previously this threw.
    expect(r.text).toBe('PONG');
    // Escalated once, on the first rejection — not after the attempts ran out.
    expect(demoteSpy).toHaveBeenCalledTimes(1);
    // Attempt 1 poisoned, attempt 2 from the oracle.
    expect(acquired).toEqual(['POISON', 'ORACLE']);
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it('does not demote when browserless is already inactive (no repeat demotions)', async () => {
    browserlessActive = false; // e.g. already demoted, or the flag is off
    const { chatGrokWeb } = await import('../../src/llm/grok-web-media.js');
    const bridge = vi.fn(async () => ({ ok: true, text: 'OK' }));

    const r = await chatGrokWeb('hi', {
      deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 },
    });

    expect(r.text).toBe('OK');
    expect(demoteSpy).not.toHaveBeenCalled();
  });

  it('still surfaces a persistent 403 when even oracle tokens are rejected', async () => {
    const { chatGrokWeb } = await import('../../src/llm/grok-web-media.js');
    const bridge = vi.fn(async () => ({ ok: false, status: 403, errorClass: 'statsig' }));

    await expect(
      chatGrokWeb('hi', { deps: { manager: fakeManager(), bridge: bridge as never, now: () => 1 } }),
    ).rejects.toThrow(/anti-bot/i);

    // Escalated once, then stopped — never falls back to the metered API.
    expect(demoteSpy).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledTimes(3);
  });
});
