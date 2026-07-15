/**
 * @file tests/brain/provider-prefix-boot.test.ts
 * @description Boot-validation regression for the 2026-07-14 prod incident:
 * adding 'xai-oauth/grok-4.5' to config models.primary crash-looped prod
 * because ModelFailover's constructor validation threw 'Unknown provider'
 * for the prefix (failover.ts) — the model is served ONLY by the IR
 * transport, which the constructor never consults.
 *
 * The contract pinned here: a prod-shaped models.primary containing EVERY
 * supported provider prefix must CONSTRUCT (boot must not die on a routable
 * model), while a truly unknown prefix still throws. If a new provider prefix
 * is wired into routing (transport or legacy) without being added to the
 * failover allowlist, this fails at PR time instead of at prod boot.
 */

import { describe, it, expect } from 'vitest';
import { ModelFailover } from '../../src/core/brain/failover.js';
import { LLMError } from '../../src/core/shared/errors.js';

/**
 * Prod-shaped primary list: one model per supported provider prefix,
 * including the IR-transport-only 'xai-oauth' that triggered the incident.
 */
const PROD_SHAPED_PRIMARY = [
  'xai-oauth/grok-4.5',
  'claude-oauth/claude-opus-4-8',
  'anthropic/claude-sonnet-4-5',
  'xai/grok-4-fast-non-reasoning',
  'openai/gpt-5.2',
  'google/gemini-3-pro',
  'groq/llama-4-70b',
  'mistral/mistral-large-3',
  'deepseek/deepseek-chat',
  'together/qwen-3-235b',
  'ollama/deepseek-v4-pro:cloud',
];

describe('ModelFailover boot validation (provider prefixes)', () => {
  it('constructs with a prod-shaped primary containing EVERY supported prefix (incl. xai-oauth)', () => {
    const failover = new ModelFailover(PROD_SHAPED_PRIMARY);
    const status = failover.getStatus();
    expect(status).toHaveLength(PROD_SHAPED_PRIMARY.length);
    expect(status.map((p) => p.id)).toEqual(PROD_SHAPED_PRIMARY);
  });

  it.each(PROD_SHAPED_PRIMARY)('prefix accepted in isolation: %s', (model) => {
    // Per-prefix cases so a regression names the exact culprit instead of
    // failing the whole prod-shaped list opaquely.
    expect(() => new ModelFailover([model])).not.toThrow();
  });

  it('unknown prefix still throws llm_unknown_provider (validation is not disabled)', () => {
    let thrown: unknown;
    try {
      new ModelFailover(['bogus/x']);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMError);
    expect((thrown as LLMError).code).toBe('llm_unknown_provider');

    // A bad entry buried in an otherwise-valid list must also throw.
    expect(() => new ModelFailover([...PROD_SHAPED_PRIMARY, 'bogus/x'])).toThrow(LLMError);
  });

  it('xai-oauth profile drives cooldown/park/rescue machinery like any other provider', () => {
    const failover = new ModelFailover(['xai-oauth/grok-4.5', 'xai/grok-4-fast-non-reasoning']);

    // Highest priority first.
    expect(failover.getNextProfile()?.id).toBe('xai-oauth/grok-4.5');

    // Transient error → cooldown; selection advances to the next profile.
    failover.recordError('xai-oauth/grok-4.5', 'rate_limit');
    expect(failover.isCooledDown('xai-oauth/grok-4.5')).toBe(true);
    expect(failover.getCooldownRemaining('xai-oauth/grok-4.5')).toBeGreaterThan(0);
    expect(failover.getNextProfile()?.id).toBe('xai/grok-4-fast-non-reasoning');

    // Recovery resets the counter and re-enables the profile.
    failover.recordSuccess('xai-oauth/grok-4.5');
    expect(failover.isCooledDown('xai-oauth/grok-4.5')).toBe(false);
    expect(failover.getNextProfile()?.id).toBe('xai-oauth/grok-4.5');

    // auth_permanent still disables it permanently (403 semantics preserved).
    failover.recordError('xai-oauth/grok-4.5', 'auth_permanent');
    const profile = failover.getStatus().find((p) => p.id === 'xai-oauth/grok-4.5');
    expect(profile?.disabled).toBe(true);
  });
});
