/**
 * @file tests/brain/failover-domains.test.ts
 * @description ADR 0003 — credential failure domains. Account-scoped errors
 * (auth_permanent/auth/billing) propagate cooldowns across profiles sharing a
 * credential (= provider); model-scoped errors do not; success on any domain
 * profile clears the domain's account-scoped cooldowns.
 *
 * Motivating incident (2026-07-29): an Anthropic org-level OAuth block (403)
 * had to be discovered four separate times — one live wire call per
 * claude-oauth slot — before the chain reached the next real credential.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelFailover } from '../../src/core/brain/failover.js';
import { AUTH_COOLDOWN, BILLING_COOLDOWN } from '../../src/core/shared/constants.js';

const FABLE = 'claude-oauth/claude-fable-5';
const HAIKU = 'claude-oauth/claude-haiku-4-5-20251001';
const OPUS = 'claude-oauth/claude-opus-4-8';
const GEMINI = 'google/gemini-2.5-flash';
const GLM = 'ollama/glm-5.2:cloud'; // in LAST_RESORT_MODEL_IDS (60s cap)
const OLLAMA2 = 'ollama/deepseek-v4-pro:cloud';

/** Prod-shaped chain: glm primary, claude block, gemini last. */
function fresh(): ModelFailover {
  return new ModelFailover([GLM, FABLE, HAIKU, OPUS, GEMINI]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  delete process.env['SUDO_FAILOVER_DOMAINS'];
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env['SUDO_FAILOVER_DOMAINS'];
});

describe('ADR 0003: credential failure domains', () => {
  it('FD-1: auth_permanent disables the erroring profile and parks (not disables) its domain siblings', () => {
    const f = fresh();
    f.recordError(FABLE, 'auth_permanent', { rng: () => 0 });

    const status = new Map(f.getStatus().map((p) => [p.id, p]));
    expect(status.get(FABLE)!.disabled).toBe(true);

    for (const id of [HAIKU, OPUS]) {
      const p = status.get(id)!;
      expect(p.disabled).toBe(false);
      expect(p.cooldownClass).toBe('auth');
      // errorCount 1 → first AUTH_COOLDOWN slot (rng=0 → no jitter above base)
      expect(f.getCooldownRemaining(id)).toBeGreaterThanOrEqual(AUTH_COOLDOWN[0] - 100);
      expect(p.consecutiveErrors).toBe(0); // credential evidence, not model evidence
    }
    // Other domains untouched.
    expect(f.getCooldownRemaining(GEMINI)).toBe(0);
    expect(f.getCooldownRemaining(GLM)).toBe(0);
  });

  it('FD-2: after an org-block event the chain selects the next DOMAIN, not the next claude slot', () => {
    const f = fresh();
    // glm is priority 0; park it with a transient error so the walk starts at the claude block.
    f.recordError(GLM, 'rate_limit', { rng: () => 0 });
    f.recordError(FABLE, 'auth_permanent', { rng: () => 0 });

    const next = f.getNextProfile();
    expect(next).not.toBeNull();
    expect(next!.id).toBe(GEMINI);
  });

  it('FD-3: transient errors never propagate', () => {
    const f = fresh();
    f.recordError(FABLE, 'rate_limit', { rng: () => 0 });
    expect(f.getCooldownRemaining(FABLE)).toBeGreaterThan(0);
    expect(f.getCooldownRemaining(HAIKU)).toBe(0);
    expect(f.getCooldownRemaining(OPUS)).toBe(0);
  });

  it('FD-4: billing propagates the billing schedule across the domain only', () => {
    const f = fresh();
    f.recordError(GEMINI, 'billing', { rng: () => 0 });
    expect(f.getCooldownRemaining(GEMINI)).toBeGreaterThanOrEqual(BILLING_COOLDOWN[0] - 100);
    // gemini has no domain siblings in this chain — claude/ollama untouched.
    for (const id of [FABLE, HAIKU, OPUS, GLM]) {
      expect(f.getCooldownRemaining(id)).toBe(0);
    }

    const f2 = fresh();
    f2.recordError(HAIKU, 'billing', { rng: () => 0 });
    const status = new Map(f2.getStatus().map((p) => [p.id, p]));
    expect(status.get(FABLE)!.cooldownClass).toBe('billing');
    expect(f2.getCooldownRemaining(FABLE)).toBeGreaterThanOrEqual(BILLING_COOLDOWN[0] - 100);
    expect(f2.getCooldownRemaining(GEMINI)).toBe(0);
  });

  it('FD-5: success on a domain profile clears siblings’ account-scoped cooldowns but not transient ones', () => {
    const f = fresh();
    // opus gets its own transient cooldown first; then an auth event parks the domain.
    f.recordError(OPUS, 'rate_limit', { rng: () => 0 });
    const opusTransient = f.getCooldownRemaining(OPUS);
    f.recordError(FABLE, 'auth', { rng: () => 0 });
    expect(f.getCooldownRemaining(HAIKU)).toBeGreaterThan(0);
    // opus kept its LONGER-of-the-two cooldown; auth propagation only extends.
    expect(f.getCooldownRemaining(OPUS)).toBeGreaterThanOrEqual(opusTransient);

    f.recordSuccess(HAIKU);
    // haiku itself and the auth-parked fable are cleared…
    expect(f.getCooldownRemaining(HAIKU)).toBe(0);
    expect(f.getCooldownRemaining(FABLE)).toBe(0);
    // …opus was re-stamped by the (longer) auth propagation, so it clears too —
    // unless its transient cooldown was longer, in which case it survives.
    const opus = f.getStatus().find((p) => p.id === OPUS)!;
    if (opus.cooldownClass === 'transient') {
      expect(f.getCooldownRemaining(OPUS)).toBeGreaterThan(0);
    } else {
      expect(f.getCooldownRemaining(OPUS)).toBe(0);
    }
  });

  it('FD-6: success recovery does NOT re-enable a disabled sibling', () => {
    const f = fresh();
    f.recordError(FABLE, 'auth_permanent', { rng: () => 0 });
    f.recordSuccess(HAIKU);
    const fable = f.getStatus().find((p) => p.id === FABLE)!;
    expect(fable.disabled).toBe(true);
  });

  it('FD-7: propagation never shortens an existing longer cooldown', () => {
    const f = fresh();
    // Big Retry-After parks haiku for 30 minutes (transient class).
    f.recordError(HAIKU, 'rate_limit', { retryAfterMs: 1_800_000, rng: () => 0 });
    const before = f.getCooldownRemaining(HAIKU);
    f.recordError(FABLE, 'auth', { rng: () => 0 }); // AUTH_COOLDOWN[0] is far shorter
    expect(f.getCooldownRemaining(HAIKU)).toBe(before);
    // Class not overwritten either — the longer transient cooldown still owns the slot.
    expect(f.getStatus().find((p) => p.id === HAIKU)!.cooldownClass).toBe('transient');
  });

  it('FD-8: a propagated cooldown on a last-resort profile is capped at 60s', () => {
    const f = new ModelFailover([GLM, OLLAMA2]);
    f.recordError(OLLAMA2, 'auth', { rng: () => 0 });
    expect(f.getCooldownRemaining(GLM)).toBeGreaterThan(0);
    expect(f.getCooldownRemaining(GLM)).toBeLessThanOrEqual(60_000);
  });

  it('FD-9: SUDO_FAILOVER_DOMAINS=0 restores strictly per-profile behavior', () => {
    process.env['SUDO_FAILOVER_DOMAINS'] = '0';
    const f = fresh();
    f.recordError(FABLE, 'auth_permanent', { rng: () => 0 });
    expect(f.getStatus().find((p) => p.id === FABLE)!.disabled).toBe(true);
    expect(f.getCooldownRemaining(HAIKU)).toBe(0);
    expect(f.getCooldownRemaining(OPUS)).toBe(0);

    f.recordError(HAIKU, 'auth', { rng: () => 0 });
    f.recordSuccess(OPUS);
    expect(f.getCooldownRemaining(HAIKU)).toBeGreaterThan(0); // no recovery propagation either
  });

  it('FD-10: getStatus exposes domain and cooldownClass', () => {
    const f = fresh();
    f.recordError(FABLE, 'auth', { rng: () => 0 });
    const status = new Map(f.getStatus().map((p) => [p.id, p]));
    expect(status.get(FABLE)!.domain).toBe('claude-oauth');
    expect(status.get(GEMINI)!.domain).toBe('google');
    expect(status.get(FABLE)!.cooldownClass).toBe('auth');
    expect(status.get(GEMINI)!.cooldownClass).toBeUndefined();
  });
});
