/**
 * @file tests/brain/provider-vault-fallback.test.ts
 * @description Tests for the opt-in vault fallback for provider API keys
 *   (SUDO_VAULT_PROVIDER_KEYS=1; env always wins; vault errors degrade to
 *   "key unset").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const vaultGetMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/security/vault.js', () => ({
  vault: {
    get: vaultGetMock,
    set: vi.fn(),
    list: vi.fn(),
    rotate: vi.fn(),
    delete: vi.fn(),
  },
  VaultError: class VaultError extends Error {
    constructor(message: string, public code: string) {
      super(message);
    }
  },
}));

import { resolveVaultProviderKey } from '../../src/core/brain/providers.js';

describe('resolveVaultProviderKey', () => {
  beforeEach(() => {
    vaultGetMock.mockReset();
  });

  it('returns the vault value for a stored key', async () => {
    vaultGetMock.mockResolvedValue({ value: 'sk-from-vault', entry: { createdAt: 'x' } });
    const value = await resolveVaultProviderKey('TEST_VAULT_KEY_A');
    expect(value).toBe('sk-from-vault');
    expect(vaultGetMock).toHaveBeenCalledWith('providers', 'TEST_VAULT_KEY_A', 'brain:providers');
  });

  it('caches per envKey — second call does not hit the vault again', async () => {
    vaultGetMock.mockResolvedValue({ value: 'sk-cached', entry: { createdAt: 'x' } });
    await resolveVaultProviderKey('TEST_VAULT_KEY_B');
    await resolveVaultProviderKey('TEST_VAULT_KEY_B');
    expect(vaultGetMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing vault (no master key / not found) degrades to undefined', async () => {
    vaultGetMock.mockRejectedValue(new Error('No master key configured'));
    const value = await resolveVaultProviderKey('TEST_VAULT_KEY_C');
    expect(value).toBeUndefined();
  });

  it('a null vault result degrades to undefined', async () => {
    vaultGetMock.mockResolvedValue(null);
    const value = await resolveVaultProviderKey('TEST_VAULT_KEY_D');
    expect(value).toBeUndefined();
  });
});

// The SUDO_VAULT_PROVIDER_KEYS gate lives inline in instantiateProvider (not
// exported): flag unset/'0' or env key present → resolveVaultProviderKey is
// never invoked, so default behavior is byte-identical to pre-change. That
// branch is one guarded condition; the helper's contract is what's tested here.
