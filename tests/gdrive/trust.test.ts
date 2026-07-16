import { describe, it, expect } from 'vitest';
import { deriveTrustTier, TRUST_WEIGHTS } from '../../src/core/gdrive/trust.js';

const ctx = {
  serviceAccountEmail: 'sudo-ai@proj.iam.gserviceaccount.com',
  principalEmails: ['frankmartin7722@gmail.com'],
};

const perm = (role: string, emailAddress?: string, type = 'user') => ({ role, emailAddress, type });

describe('deriveTrustTier (F16)', () => {
  it('SA-only writers => agent', () => {
    expect(deriveTrustTier([perm('writer', ctx.serviceAccountEmail)], [], ctx)).toBe('agent');
  });

  it('owner-writable => principal (even alongside the SA)', () => {
    expect(
      deriveTrustTier(
        [perm('owner', 'frankmartin7722@gmail.com'), perm('writer', ctx.serviceAccountEmail)],
        [],
        ctx,
      ),
    ).toBe('principal');
  });

  it('any unknown writer => external (weakest writer wins)', () => {
    expect(
      deriveTrustTier(
        [perm('owner', 'frankmartin7722@gmail.com'), perm('writer', 'rando@example.com')],
        [],
        ctx,
      ),
    ).toBe('external');
  });

  it('anyone/domain/group write access => external', () => {
    expect(deriveTrustTier([{ role: 'writer', type: 'anyone' }], [], ctx)).toBe('external');
    expect(
      deriveTrustTier([{ role: 'writer', type: 'domain', emailAddress: undefined }], [], ctx),
    ).toBe('external');
  });

  it('parent-folder writers count as file writers', () => {
    expect(
      deriveTrustTier(
        [perm('writer', ctx.serviceAccountEmail)],
        [perm('writer', 'rando@example.com')],
        ctx,
      ),
    ).toBe('external');
    expect(
      deriveTrustTier(
        [perm('writer', ctx.serviceAccountEmail)],
        [perm('owner', 'frankmartin7722@gmail.com')],
        ctx,
      ),
    ).toBe('principal');
  });

  it('readers/commenters do not affect the tier', () => {
    expect(
      deriveTrustTier(
        [perm('writer', ctx.serviceAccountEmail), perm('reader', 'rando@example.com'), perm('commenter', 'x@y.z')],
        [],
        ctx,
      ),
    ).toBe('agent');
  });

  it('no identifiable writers => external (fail-closed)', () => {
    expect(deriveTrustTier([], [], ctx)).toBe('external');
    expect(deriveTrustTier([{ role: 'writer' }], [], ctx)).toBe('external');
  });

  it('email matching is case-insensitive', () => {
    expect(deriveTrustTier([perm('owner', 'FrankMartin7722@Gmail.com')], [], ctx)).toBe('principal');
  });

  it('weights are ordered principal > agent > self_acquired > external', () => {
    expect(TRUST_WEIGHTS.principal).toBeGreaterThan(TRUST_WEIGHTS.agent);
    expect(TRUST_WEIGHTS.agent).toBeGreaterThan(TRUST_WEIGHTS.self_acquired);
    expect(TRUST_WEIGHTS.self_acquired).toBeGreaterThan(TRUST_WEIGHTS.external);
  });
});
