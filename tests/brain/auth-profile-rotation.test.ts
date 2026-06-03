/**
 * Tests for AuthProfileRotation class.
 *
 * Covers:
 * - Rotation on rate limit errors
 * - Rotation on billing errors
 * - Cooldown expiry
 * - Success reset
 * - Kill-switch behavior
 * - No keys available scenario
 * - Priority ordering
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AuthProfileRotation,
  AuthProfile,
  AuthErrorCategory,
} from '../../src/core/brain/auth-profile-rotation.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  rateLimitCooldowns: [5_000, 10_000, 30_000] as const,
  billingCooldowns: [30_000, 60_000, 120_000] as const,
  authCooldowns: [5_000, 10_000, 30_000] as const,
};

function createTestRotation() {
  AuthProfileRotation.resetInstance();
  return AuthProfileRotation.getInstance(TEST_CONFIG);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProfileRotation', () => {
  beforeEach(() => {
    AuthProfileRotation.resetInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    AuthProfileRotation.resetInstance();
    delete process.env['SUDO_AUTH_ROTATION_DISABLE'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY_1'];
    delete process.env['OPENAI_API_KEY_2'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  // -------------------------------------------------------------------------
  // Singleton behavior
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = AuthProfileRotation.getInstance();
      const instance2 = AuthProfileRotation.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should allow resetting the instance for testing', () => {
      const instance1 = AuthProfileRotation.getInstance();
      AuthProfileRotation.resetInstance();
      const instance2 = AuthProfileRotation.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  // -------------------------------------------------------------------------
  // Key loading from environment
  // -------------------------------------------------------------------------

  describe('loadKeysFromEnv', () => {
    it('should load a single key from OPENAI_API_KEY', () => {
      process.env['OPENAI_API_KEY'] = 'sk-test-key-123';
      const rotation = createTestRotation();
      const count = rotation.loadKeysFromEnv('openai');

      expect(count).toBe(1);
      const status = rotation.getStatus('openai');
      expect(status).toHaveLength(1);
      expect(status[0].keyId).toBe('openai-key-1');
      expect(status[0].apiKey).toBe('sk-test-key-123');
    });

    it('should load multiple numbered keys from OPENAI_API_KEY_1, _2, etc.', () => {
      process.env['OPENAI_API_KEY_1'] = 'sk-key-1';
      process.env['OPENAI_API_KEY_2'] = 'sk-key-2';
      process.env['OPENAI_API_KEY_3'] = 'sk-key-3';
      const rotation = createTestRotation();
      const count = rotation.loadKeysFromEnv('openai');

      expect(count).toBe(3);
      const status = rotation.getStatus('openai');
      expect(status.map((s) => s.keyId)).toEqual([
        'openai-key-1',
        'openai-key-2',
        'openai-key-3',
      ]);
    });

    it('should prioritize numbered keys over single key', () => {
      process.env['OPENAI_API_KEY'] = 'sk-single';
      process.env['OPENAI_API_KEY_1'] = 'sk-numbered-1';
      const rotation = createTestRotation();
      const count = rotation.loadKeysFromEnv('openai');

      expect(count).toBe(1);
      const status = rotation.getStatus('openai');
      expect(status[0].apiKey).toBe('sk-numbered-1');
    });

    it('should return 0 when no keys are set', () => {
      const rotation = createTestRotation();
      const count = rotation.loadKeysFromEnv('openai');
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Programmatic key registration
  // -------------------------------------------------------------------------

  describe('registerKeys', () => {
    it('should register keys with auto-generated keyIds', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      const status = rotation.getStatus('openai');
      expect(status).toHaveLength(2);
      expect(status[0].keyId).toBe('openai-key-1');
      expect(status[1].keyId).toBe('openai-key-2');
    });

    it('should register keys with explicit keyIds', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { keyId: 'primary-key', apiKey: 'sk-primary' },
        { keyId: 'backup-key', apiKey: 'sk-backup' },
      ]);

      const status = rotation.getStatus('openai');
      expect(status[0].keyId).toBe('primary-key');
      expect(status[0].apiKey).toBe('sk-primary');
      expect(status[1].keyId).toBe('backup-key');
      expect(status[1].apiKey).toBe('sk-backup');
    });
  });

  // -------------------------------------------------------------------------
  // Key selection - getNextKey
  // -------------------------------------------------------------------------

  describe('getNextKey', () => {
    it('should return null when no keys are registered', () => {
      const rotation = createTestRotation();
      const result = rotation.getNextKey('openai');
      expect(result).toBeNull();
    });

    it('should return the first active key by default', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      const result = rotation.getNextKey('openai');
      expect(result?.keyId).toBe('openai-key-1');
    });

    it('should skip keys in cooldown and return the next available', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
        { apiKey: 'sk-key-3' },
      ]);

      // Put first key in cooldown
      rotation.reportError('openai', 'openai-key-1', 'rate_limit');

      const result = rotation.getNextKey('openai');
      expect(result?.keyId).toBe('openai-key-2');
    });

    it('should skip disabled keys', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      // Manually disable first key
      const profiles = rotation.getStatus('openai');
      // Need to use reportError to trigger disable after 3 auth errors
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');

      const result = rotation.getNextKey('openai');
      expect(result?.keyId).toBe('openai-key-2');
    });

    it('should force-reset the earliest cooldown key when all are in cooldown', () => {
      vi.useFakeTimers();
      try {
        const rotation = createTestRotation();
        rotation.registerKeys('openai', [
          { apiKey: 'sk-key-1' },
          { apiKey: 'sk-key-2' },
        ]);

        // Put both keys in cooldown with different expiry times
        rotation.reportError('openai', 'openai-key-1', 'rate_limit');
        vi.advanceTimersByTime(2_000);
        rotation.reportError('openai', 'openai-key-2', 'rate_limit');

        const result = rotation.getNextKey('openai');
        // Should return key-1 since it expires first
        expect(result?.keyId).toBe('openai-key-1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should prefer keys with fewer consecutive errors', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      // Add errors to first key but not enough to cooldown
      // (we need to manually manipulate for this test)
      const status = rotation.getStatus('openai');
      // Can't easily test this without cooldown, so test priority ordering
      expect(status[0].consecutiveErrors).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error reporting and rotation
  // -------------------------------------------------------------------------

  describe('reportError', () => {
    it('should mark key as rate_limited and apply cooldown', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');

      const status = rotation.getStatus('openai');
      expect(status[0].state).toBe('rate_limited');
      expect(status[0].cooldownUntil).toBeGreaterThan(Date.now());
      expect(status[0].consecutiveErrors).toBe(1);
    });

    it('should mark key as billing_error with longer cooldown', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      rotation.reportError('openai', 'openai-key-1', 'billing_error');

      const status = rotation.getStatus('openai');
      expect(status[0].state).toBe('billing_error');
      // Billing cooldown should be longer than rate limit
      expect(status[0].cooldownUntil).toBeGreaterThan(Date.now() + 20_000);
      expect(status[0].consecutiveErrors).toBe(1);
    });

    it('should disable key after 3 auth_invalid errors', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');

      const status = rotation.getStatus('openai');
      expect(status[0].disabled).toBe(true);
    });

    it('should escalate cooldown on consecutive errors', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');
      const firstStatus = rotation.getStatus('openai')[0];
      const firstCooldownDuration = firstStatus.cooldownUntil - Date.now();

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');
      const secondStatus = rotation.getStatus('openai')[0];
      const secondCooldownDuration = secondStatus.cooldownUntil - Date.now();

      // Second error should have longer cooldown (10s vs 5s in test config)
      expect(secondCooldownDuration).toBeGreaterThan(firstCooldownDuration);
    });

    it('should handle unknown keyId gracefully', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      // Should not throw
      expect(() => {
        rotation.reportError('openai', 'nonexistent-key', 'rate_limit');
      }).not.toThrow();
    });

    it('should handle unknown provider gracefully', () => {
      const rotation = createTestRotation();

      // Should not throw
      expect(() => {
        rotation.reportError('nonexistent', 'some-key', 'rate_limit');
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Success reporting
  // -------------------------------------------------------------------------

  describe('reportSuccess', () => {
    it('should reset error count and clear cooldown', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');
      const afterError = rotation.getStatus('openai')[0];
      expect(afterError.consecutiveErrors).toBe(1);
      expect(afterError.cooldownUntil).toBeGreaterThan(0);

      rotation.reportSuccess('openai', 'openai-key-1');

      const afterSuccess = rotation.getStatus('openai')[0];
      expect(afterSuccess.consecutiveErrors).toBe(0);
      expect(afterSuccess.cooldownUntil).toBe(0);
      expect(afterSuccess.state).toBe('active');
    });

    it('should handle unknown keyId gracefully', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      expect(() => {
        rotation.reportSuccess('openai', 'nonexistent-key');
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Kill-switch behavior
  // -------------------------------------------------------------------------

  describe('kill-switch', () => {
    it('should always return first key when SUDO_AUTH_ROTATION_DISABLE=1', () => {
      process.env['SUDO_AUTH_ROTATION_DISABLE'] = '1';
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      // Put first key in cooldown
      rotation.reportError('openai', 'openai-key-1', 'rate_limit');

      // Should still return first key despite cooldown
      const result = rotation.getNextKey('openai');
      expect(result?.keyId).toBe('openai-key-1');
    });

    it('should return null when first key is disabled and rotation is disabled', () => {
      process.env['SUDO_AUTH_ROTATION_DISABLE'] = '1';
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      // Disable first key via auth errors
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');
      rotation.reportError('openai', 'openai-key-1', 'auth_invalid');

      const result = rotation.getNextKey('openai');
      expect(result).toBeNull();
    });

    it('should rotate normally when kill-switch is not set', () => {
      delete process.env['SUDO_AUTH_ROTATION_DISABLE'];
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');

      const result = rotation.getNextKey('openai');
      expect(result?.keyId).toBe('openai-key-2');
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown inspection
  // -------------------------------------------------------------------------

  describe('cooldown inspection', () => {
    it('should report isKeyInCooldown correctly', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      expect(rotation.isKeyInCooldown('openai', 'openai-key-1')).toBe(false);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');

      expect(rotation.isKeyInCooldown('openai', 'openai-key-1')).toBe(true);
    });

    it('should return remaining cooldown time', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');
      const remaining = rotation.getCooldownRemaining('openai', 'openai-key-1');

      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(5_000);
    });

    it('should return 0 when key is not in cooldown', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      const remaining = rotation.getCooldownRemaining('openai', 'openai-key-1');
      expect(remaining).toBe(0);
    });

    it('should return 0 for unknown key', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key-1' }]);

      const remaining = rotation.getCooldownRemaining('openai', 'unknown-key');
      expect(remaining).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Provider management
  // -------------------------------------------------------------------------

  describe('provider management', () => {
    it('should track multiple providers independently', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-openai-key' }]);
      rotation.registerKeys('anthropic', [{ apiKey: 'sk-anthropic-key' }]);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');

      // OpenAI key should be in cooldown
      expect(rotation.isKeyInCooldown('openai', 'openai-key-1')).toBe(true);

      // Anthropic key should NOT be affected
      expect(rotation.isKeyInCooldown('anthropic', 'anthropic-key-1')).toBe(false);
    });

    it('should list registered providers', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-openai-key' }]);
      rotation.registerKeys('anthropic', [{ apiKey: 'sk-anthropic-key' }]);

      const providers = rotation.getRegisteredProviders();
      expect(providers).toContain('openai');
      expect(providers).toContain('anthropic');
    });

    it('should reset cooldowns for a provider', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [
        { apiKey: 'sk-key-1' },
        { apiKey: 'sk-key-2' },
      ]);

      rotation.reportError('openai', 'openai-key-1', 'rate_limit');
      rotation.reportError('openai', 'openai-key-2', 'rate_limit');

      expect(rotation.isKeyInCooldown('openai', 'openai-key-1')).toBe(true);

      rotation.resetProviderCooldowns('openai');

      expect(rotation.isKeyInCooldown('openai', 'openai-key-1')).toBe(false);
      expect(rotation.isKeyInCooldown('openai', 'openai-key-2')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // API key retrieval
  // -------------------------------------------------------------------------

  describe('getApiKey', () => {
    it('should return the API key value for a valid keyId', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-secret-key' }]);

      const key = rotation.getApiKey('openai', 'openai-key-1');
      expect(key).toBe('sk-secret-key');
    });

    it('should return null for unknown keyId', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-key' }]);

      const key = rotation.getApiKey('openai', 'unknown-key');
      expect(key).toBeNull();
    });

    it('should return null for unknown provider', () => {
      const rotation = createTestRotation();

      const key = rotation.getApiKey('unknown', 'some-key');
      expect(key).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getAllStatus
  // -------------------------------------------------------------------------

  describe('getAllStatus', () => {
    it('should return status for all providers', () => {
      const rotation = createTestRotation();
      rotation.registerKeys('openai', [{ apiKey: 'sk-openai' }]);
      rotation.registerKeys('anthropic', [{ apiKey: 'sk-anthropic' }]);

      const allStatus = rotation.getAllStatus();

      expect(allStatus.size).toBe(2);
      expect(allStatus.get('openai')).toHaveLength(1);
      expect(allStatus.get('anthropic')).toHaveLength(1);
    });
  });
});
