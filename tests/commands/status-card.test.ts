/**
 * @file tests/commands/status-card.test.ts
 * @description BO7 / S6 — the shared /status card builder.
 *
 * Proves: every field is present and formatted; the pure assembler and text
 * renderer never throw on missing/zero data; the collector is fail-open; and
 * no raw SQL or prompt text leaks into the rendered card.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleStatusCard,
  renderStatusCardText,
  collectStatusCard,
  formatUptime,
  shortTokens,
  formatCurrentTime,
  formatReferenceUtc,
  type RawStatusInputs,
  type StatusCardData,
} from '../../src/core/commands/builtin/status-card.js';

// A fully-populated, realistic input mirroring OpenClaw's sample card.
function fullRaw(overrides: Partial<RawStatusInputs> = {}): RawStatusInputs {
  return {
    version: '4.1.7',
    commit: '46ae1cfabc123',
    nowMs: Date.UTC(2026, 6, 18, 17, 7, 12), // Sat Jul 18 2026 17:07 UTC
    gatewayUptimeS: 86,
    systemUptimeS: 42 * 86400 + 22 * 3600,
    model: 'xai/grok-4.5',
    authKind: 'api-key',
    authProfile: 'xai:default',
    tokensIn: 169,
    tokensOut: 549,
    costUsd: 0.0057,
    cacheSharePct: 99,
    cacheReadTokens: 21000,
    freshTokens: 0,
    contextUsed: 21000,
    contextWindow: 1_000_000,
    compactions: 0,
    sessionKey: 'web:abc',
    sessionCreatedMs: Date.UTC(2026, 6, 18, 17, 0, 46),
    execMode: 'direct',
    think: 'low',
    fast: 'off',
    queueMode: 'steer',
    queueDepth: 0,
    ...overrides,
  };
}

const ALL_FIELDS: Array<keyof StatusCardData> = [
  'headline', 'version', 'commit', 'currentTime', 'referenceUtc', 'uptime',
  'gatewayUptime', 'systemUptime', 'model', 'auth', 'tokens', 'tokensIn',
  'tokensOut', 'cost', 'cache', 'cacheSharePct', 'context', 'contextUsed',
  'contextWindow', 'contextPct', 'compactions', 'session', 'sessionKey',
  'sessionDuration', 'execution', 'think', 'fast', 'queue', 'queueMode',
  'queueDepth',
];

describe('assembleStatusCard — full card formatting', () => {
  const card = assembleStatusCard(fullRaw());

  it('populates every StatusCardData field', () => {
    for (const key of ALL_FIELDS) {
      expect(card[key], `field ${String(key)}`).not.toBeUndefined();
    }
  });

  it('formats headline with version + short commit', () => {
    expect(card.headline).toBe('SUDO-AI 4.1.7 (46ae1cf)');
    expect(card.commit).toBe('46ae1cf'); // truncated to 7
  });

  it('formats the human time and reference UTC', () => {
    expect(card.currentTime).toBe('Saturday, July 18th, 2026 - 5:07 PM (UTC)');
    expect(card.referenceUtc).toBe('2026-07-18 17:07 UTC');
  });

  it('formats gateway + system uptime', () => {
    expect(card.uptime).toBe('gateway 1m 26s · system 42d 22h');
  });

  it('formats model + auth profile', () => {
    expect(card.model).toBe('xai/grok-4.5');
    expect(card.auth).toBe('api-key (xai:default)');
  });

  it('formats tokens, cost and cache line', () => {
    expect(card.tokens).toBe('169 in / 549 out');
    expect(card.cost).toBe('$0.0057');
    expect(card.cache).toBe('99% hit · 21k cached, 0 new');
  });

  it('formats context fill + percent + compactions', () => {
    expect(card.context).toBe('21k/1.0m (2%)');
    expect(card.contextPct).toBe(2);
    expect(card.compactions).toBe(0);
  });

  it('formats session key + duration', () => {
    expect(card.sessionKey).toBe('web:abc');
    expect(card.session).toBe('web:abc · duration 6m 26s');
  });

  it('formats execution/think/fast and queue', () => {
    expect(card.execution).toBe('direct');
    expect(card.think).toBe('low');
    expect(card.fast).toBe('off');
    expect(card.queue).toBe('steer (depth 0)');
  });
});

describe('assembleStatusCard — degenerate inputs never throw', () => {
  it('handles all-null / all-zero without throwing and yields a complete card', () => {
    const empty: RawStatusInputs = {
      version: null, commit: null, nowMs: 0, gatewayUptimeS: 0, systemUptimeS: 0,
      model: null, authKind: '', authProfile: null, tokensIn: 0, tokensOut: 0,
      costUsd: 0, cacheSharePct: 0, cacheReadTokens: 0, freshTokens: 0,
      contextUsed: 0, contextWindow: 0, compactions: 0, sessionKey: null,
      sessionCreatedMs: null, execMode: '', think: '', fast: '', queueMode: '',
      queueDepth: 0,
    };
    const card = assembleStatusCard(empty);
    for (const key of ALL_FIELDS) {
      expect(card[key], `field ${String(key)}`).not.toBeUndefined();
    }
    expect(card.version).toBe('dev');
    expect(card.commit).toBe('unknown');
    expect(card.model).toBe('unknown');
    expect(card.context).toBe('0/0 (0%)'); // no divide-by-zero
    expect(card.contextPct).toBe(0);
    expect(card.session).toContain('none');
    expect(card.execution).toBe('direct');
    expect(card.queue).toBe('followup (depth 0)');
  });

  it('clamps cache share to 0..100 and coerces NaN-ish numbers', () => {
    const card = assembleStatusCard(fullRaw({
      cacheSharePct: 250,
      tokensIn: Number.NaN as unknown as number,
      queueDepth: -5,
    }));
    expect(card.cacheSharePct).toBe(100);
    expect(card.tokensIn).toBe(0);
    expect(card.queueDepth).toBe(0);
  });

  it('derives auth profile from the model when authProfile is null', () => {
    const card = assembleStatusCard(fullRaw({ authProfile: null }));
    expect(card.auth).toBe('api-key (xai:default)');
  });
});

describe('renderStatusCardText', () => {
  const text = renderStatusCardText(assembleStatusCard(fullRaw()));

  it('renders all emoji-labeled lines with values', () => {
    expect(text).toContain('🎯 SUDO-AI 4.1.7 (46ae1cf)');
    expect(text).toContain('Current time: Saturday, July 18th, 2026 - 5:07 PM (UTC)');
    expect(text).toContain('Reference UTC: 2026-07-18 17:07 UTC');
    expect(text).toContain('⏱️ Uptime: gateway 1m 26s · system 42d 22h');
    expect(text).toContain('🍪 Model: xai/grok-4.5 · 🔑 api-key (xai:default)');
    expect(text).toContain('📊 Tokens: 169 in / 549 out · Cost: $0.0057');
    expect(text).toContain('🗄️ Cache: 99% hit · 21k cached, 0 new');
    expect(text).toContain('🧊 Context: 21k/1.0m (2%) · 🧭 Compactions: 0');
    expect(text).toContain('🧵 Session: web:abc · duration 6m 26s');
    expect(text).toContain('⚙️ Execution: direct · Think: low · Fast: off');
    expect(text).toContain('🎚️ Queue: steer (depth 0)');
  });

  it('has one line per card row (11 lines)', () => {
    expect(text.split('\n')).toHaveLength(11);
  });

  it('never leaks raw SQL or prompt scaffolding', () => {
    const forbidden = [/select\s/i, /from\s+llm_calls/i, /insert\s+into/i, /parent_session_id/i, /```/, /system prompt/i];
    for (const pat of forbidden) {
      expect(pat.test(text), `leaked ${pat}`).toBe(false);
    }
  });
});

describe('formatting primitives', () => {
  it('formatUptime', () => {
    expect(formatUptime(86)).toBe('1m 26s');
    expect(formatUptime(42 * 86400 + 22 * 3600)).toBe('42d 22h');
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(-100)).toBe('0s');
    expect(formatUptime(Number.NaN)).toBe('0s');
    expect(formatUptime(3661)).toBe('1h 1m');
  });

  it('shortTokens', () => {
    expect(shortTokens(169)).toBe('169');
    expect(shortTokens(21000)).toBe('21k');
    expect(shortTokens(1_000_000)).toBe('1.0m');
    expect(shortTokens(0)).toBe('0');
    expect(shortTokens(-50)).toBe('0');
  });

  it('formatCurrentTime / formatReferenceUtc are UTC and stable', () => {
    const t = Date.UTC(2026, 0, 1, 0, 5, 0); // midnight → 12:05 AM
    expect(formatCurrentTime(t)).toBe('Thursday, January 1st, 2026 - 12:05 AM (UTC)');
    expect(formatReferenceUtc(t)).toBe('2026-01-01 00:05 UTC');
  });
});

describe('collectStatusCard — fail-open collector', () => {
  it('returns a complete card from empty sources without throwing', async () => {
    const card = await collectStatusCard({ ledgerDbPath: '/nonexistent/no.db' });
    for (const key of ALL_FIELDS) {
      expect(card[key], `field ${String(key)}`).not.toBeUndefined();
    }
    // No ledger → zero tokens/cost, but the card is still whole.
    expect(card.tokens).toBe('0 in / 0 out');
    expect(card.cost).toBe('$0.0000');
  });

  it('reads model, context and queue from mock runtime handles', async () => {
    const brain = { getModel: () => 'xai/grok-4.5', getStrategy: () => 'single' };
    const session = {
      messages: [{ content: 'x'.repeat(400) }], // ~100 tokens
      createdAt: new Date(Date.now() - 60_000),
    };
    const card = await collectStatusCard({
      ledgerDbPath: '/nonexistent/no.db',
      agentLoop: { brain, sessionManager: { get: async () => session } },
      peerQueue: { pendingKeys: ['web:abc'], size: 1 },
      sessionId: 's1',
      channel: 'web',
      peerId: 'abc',
    });
    expect(card.model).toBe('xai/grok-4.5');
    expect(card.auth).toBe('api-key (xai:default)');
    expect(card.contextUsed).toBeGreaterThan(0);
    expect(card.contextWindow).toBeGreaterThan(0);
    expect(card.execution).toBe('direct'); // 'single' strategy maps to direct
    expect(card.queueDepth).toBe(1); // peer is busy
  });

  it('marks oauth models with the oauth auth kind', async () => {
    const brain = { getModel: () => 'xai-oauth/grok-4.5' };
    const card = await collectStatusCard({
      ledgerDbPath: '/nonexistent/no.db',
      agentLoop: { brain },
    });
    expect(card.auth).toBe('oauth (xai:default)');
  });
});
