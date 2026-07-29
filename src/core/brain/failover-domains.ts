/**
 * ADR 0003 — credential failure domains. Profiles sharing one credential
 * (today exactly the provider) rise and fall together for ACCOUNT-scoped
 * errors (auth_permanent/auth/billing): a failure parks the whole domain so a
 * dead credential is discovered with ONE wire call, and a success un-parks it.
 * Model-scoped errors (transient/other) never propagate. Pure state-mutation
 * helpers over the ModelFailover profile map; no state of their own.
 */

import { AUTH_COOLDOWN, BILLING_COOLDOWN } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import type { ModelProfile } from './types.js';
import {
  capLastResort,
  computeCooldownMs,
  profileSeedFor,
  type RecordErrorOptions,
} from './failover-cooldown.js';

const log = createLogger('brain:failover');

/**
 * Default ON; SUDO_FAILOVER_DOMAINS=0 restores strictly per-profile behavior.
 * Read at call time so a runtime env flip (and tests) take effect without
 * restart.
 */
export function domainPropagationEnabled(): boolean {
  return process.env['SUDO_FAILOVER_DOMAINS'] !== '0';
}

/**
 * Park every OTHER profile in the erroring profile's credential domain on an
 * account-scoped cooldown. The cooldown escalates with the SOURCE profile's
 * consecutive-error count (the evidence is about the shared credential, not
 * the sibling models — siblings' own error counters are not touched), never
 * shortens an existing cooldown, and respects the last-resort cap. Disabled
 * siblings are left alone.
 */
export function propagateDomainCooldown(
  profiles: Iterable<ModelProfile>,
  source: ModelProfile,
  errClass: 'auth' | 'billing',
  errorCount: number,
  opts: RecordErrorOptions,
  now: number,
): void {
  if (!domainPropagationEnabled()) return;
  const schedule = errClass === 'billing' ? BILLING_COOLDOWN : AUTH_COOLDOWN;
  const affected: string[] = [];
  for (const sibling of profiles) {
    if (sibling.domain !== source.domain || sibling.id === source.id || sibling.disabled) continue;
    // Per-sibling seed so propagated cooldowns stay de-synchronized.
    const seed = opts.rng ? opts.profileSeed : profileSeedFor(sibling.id);
    const ms = capLastResort(
      sibling.id,
      computeCooldownMs(schedule, errorCount, { ...opts, profileSeed: seed }),
    );
    const until = now + ms;
    if (until > sibling.cooldownUntil) {
      sibling.cooldownUntil = until;
      sibling.cooldownClass = errClass;
      affected.push(sibling.id);
    }
  }
  if (affected.length > 0) {
    log.warn(
      { domain: source.domain, sourceProfileId: source.id, errClass, errorCount, affectedProfiles: affected },
      'Account-scoped error — cooldown propagated across credential domain',
    );
  }
}

/**
 * A working call proves the shared credential works — clear domain siblings'
 * ACCOUNT-scoped cooldowns (auth/billing). Transient cooldowns are evidence
 * about those models, not the credential, and disabled profiles stay disabled
 * (per-profile, permanent, as before).
 */
export function clearDomainAccountCooldowns(
  profiles: Iterable<ModelProfile>,
  source: ModelProfile,
): void {
  if (!domainPropagationEnabled()) return;
  const recovered: string[] = [];
  for (const sibling of profiles) {
    if (sibling.domain !== source.domain || sibling.id === source.id || sibling.disabled) continue;
    if (sibling.cooldownUntil > 0 && (sibling.cooldownClass === 'auth' || sibling.cooldownClass === 'billing')) {
      sibling.cooldownUntil = 0;
      delete sibling.cooldownClass;
      recovered.push(sibling.id);
    }
  }
  if (recovered.length > 0) {
    log.info(
      { domain: source.domain, sourceProfileId: source.id, recoveredProfiles: recovered },
      'Domain success — account-scoped cooldowns cleared across credential domain',
    );
  }
}
