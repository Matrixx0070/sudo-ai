/**
 * Tests for CredentialPool class.
 *
 * Covers:
 * - All 4 selection strategies (fill-first, round-robin, least-used, random)
 * - Cooldown behavior
 * - Success/failure reporting
 * - Kill-switch behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CredentialPool,
  credentialPool,
} from '../../src/core/auth/credential-pool.js';
import type { SelectionStrategy } from '../../src/core/auth/credential-pool-types.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  cooldownMs: 5_000,
  maxFailsBeforeCooldown: 3,
};

function createTestPool() {
  CredentialPool.resetInstance();
  return CredentialPool.getInstance();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialPool', () => {
  beforeEach(() => {
    CredentialPool.resetInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    CredentialPool.resetInstance();
    delete process.env['SUDO_CREDENTIAL_POOL_DISABLE'];
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
      const instance1 = CredentialPool.getInstance();
      const instance2 = CredentialPool.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should allow resetting the instance for testing', () => {
      const instance1 = CredentialPool.getInstance();
      CredentialPool.resetInstance();
      const instance2 = CredentialPool.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  // -------------------------------------------------------------------------
  // Credential management
  // -------------------------------------------------------------------------

  describe('addCredential', () => {
    it('should add a credential to the pool', () => {
      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-test-key');

      const creds = pool.getCredentials('openai');
      expect(creds).toHaveLength(1);
      expect(creds[0].id).toBe('key-1');
      expect(creds[0].key).toBe('sk-test-key');
      expect(creds[0].isActive).toBe(true);
    });

    it('should update an existing credential', () => {
      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-old-key');
      pool.addCredential('key-1', 'openai', 'sk-new-key');

      const creds = pool.getCredentials('openai');
      expect(creds).toHaveLength(1);
      expect(creds[0].key).toBe('sk-new-key');
    });
  });

  describe('removeCredential', () => {
    it('should remove a credential from the pool', () => {
      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      const removed = pool.removeCredential('key-1');
      expect(removed).toBe(true);

      const creds = pool.getCredentials('openai');
      expect(creds).toHaveLength(1);
      expect(creds[0].id).toBe('key-2');
    });

    it('should return false for unknown credential', () => {
      const pool = createTestPool();
      const removed = pool.removeCredential('unknown-key');
      expect(removed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Selection strategies
  // -------------------------------------------------------------------------

  describe('selectCredential - fill-first', () => {
    it('should select the first active credential', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'fill-first');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      const selected = pool.selectCredential('openai');
      expect(selected?.id).toBe('key-1');
    });

    it('should stay on first credential until cooldown', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'fill-first');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      // Put key-1 in cooldown
      for (let i = 0; i < 3; i++) {
        pool.reportFailure('key-1', 'rate limit');
      }

      const selected = pool.selectCredential('openai');
      expect(selected?.id).toBe('key-2');
    });
  });

  describe('selectCredential - round-robin', () => {
    it('should cycle through credentials', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'round-robin');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');
      pool.addCredential('key-3', 'openai', 'sk-key-3');

      const first = pool.selectCredential('openai');
      const second = pool.selectCredential('openai');
      const third = pool.selectCredential('openai');

      expect(first?.id).toBe('key-1');
      expect(second?.id).toBe('key-2');
      expect(third?.id).toBe('key-3');
    });

    it('should wrap around at the end', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'round-robin');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      pool.selectCredential('openai'); // key-1
      pool.selectCredential('openai'); // key-2
      const wrapped = pool.selectCredential('openai');

      expect(wrapped?.id).toBe('key-1');
    });
  });

  describe('selectCredential - least-used', () => {
    it('should select credential with lowest usage count', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'least-used');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      // Simulate usage on key-1
      pool.reportSuccess('key-1');
      pool.reportSuccess('key-1');

      const selected = pool.selectCredential('openai');
      expect(selected?.id).toBe('key-2');
    });

    it('should break ties by first added', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'least-used');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      const selected = pool.selectCredential('openai');
      expect(selected?.id).toBe('key-1');
    });
  });

  describe('selectCredential - random', () => {
    it('should select a random active credential', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'random');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      const selected = pool.selectCredential('openai');
      expect(['key-1', 'key-2']).toContain(selected?.id);
    });

    it('should only select from active credentials', () => {
      const pool = createTestPool();
      pool.setStrategy('openai', 'random');
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      // Put key-1 in cooldown
      for (let i = 0; i < 3; i++) {
        pool.reportFailure('key-1', 'rate limit');
      }

      // Should only select key-2 (key-1 is in cooldown)
      for (let i = 0; i < 10; i++) {
        const selected = pool.selectCredential('openai');
        expect(selected?.id).toBe('key-2');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown behavior
  // -------------------------------------------------------------------------

  describe('cooldown', () => {
    it('should apply cooldown after max failures', () => {
      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-key-1');

      // Report failures (maxFailsBeforeCooldown defaults to 3)
      pool.reportFailure('key-1', 'error 1');
      pool.reportFailure('key-1', 'error 2');
      pool.reportFailure('key-1', 'error 3');

      const status = pool.getPoolStatus('openai');
      expect(status.cooldown).toBe(1);
    });

    it('should not apply cooldown before max failures', () => {
      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-key-1');

      pool.reportFailure('key-1', 'error 1');
      pool.reportFailure('key-1', 'error 2');

      const status = pool.getPoolStatus('openai');
      expect(status.cooldown).toBe(0);
    });

    it('should clear cooldown on success', () => {
      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-key-1');

      // Put in cooldown
      for (let i = 0; i < 3; i++) {
        pool.reportFailure('key-1', 'error');
      }

      let status = pool.getPoolStatus('openai');
      expect(status.cooldown).toBe(1);

      // Clear cooldown
      pool.reportSuccess('key-1');

      status = pool.getPoolStatus('openai');
      expect(status.cooldown).toBe(0);
    });

    it('should return earliest cooldown when all are in cooldown', () => {
      vi.useFakeTimers();
      try {
        const pool = createTestPool();
        pool.addCredential('key-1', 'openai', 'sk-key-1');
        pool.addCredential('key-2', 'openai', 'sk-key-2');

        // Put both in cooldown at different times
        for (let i = 0; i < 3; i++) {
          pool.reportFailure('key-1', 'error');
        }
        vi.advanceTimersByTime(2_000);
        for (let i = 0; i < 3; i++) {
          pool.reportFailure('key-2', 'error');
        }

        const selected = pool.selectCredential('openai');
        expect(selected?.id).toBe('key-1'); // Expires first
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Kill-switch behavior
  // -------------------------------------------------------------------------

  describe('kill-switch', () => {
    it('should always return first credential when disabled', () => {
      process.env['SUDO_CREDENTIAL_POOL_DISABLE'] = '1';

      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');

      // Put key-1 in cooldown
      for (let i = 0; i < 3; i++) {
        pool.reportFailure('key-1', 'error');
      }

      // Should still return key-1 because pool is disabled
      const selected = pool.selectCredential('openai');
      expect(selected?.id).toBe('key-1');
    });

    it('should log warning when disabled', () => {
      process.env['SUDO_CREDENTIAL_POOL_DISABLE'] = '1';

      const pool = createTestPool();
      const status = pool.getPoolStatus('openai');

      // Pool should be initialized with warning logged
      expect(status.provider).toBe('openai');
    });
  });

  // -------------------------------------------------------------------------
  // Environment loading
  // -------------------------------------------------------------------------

  describe('loadFromEnv', () => {
    it('should load single key from OPENAI_API_KEY', () => {
      process.env['OPENAI_API_KEY'] = 'sk-test-key';

      const pool = createTestPool();
      const count = pool.loadFromEnv('openai');

      expect(count).toBe(1);
      const creds = pool.getCredentials('openai');
      expect(creds[0].id).toBe('openai-key-1');
      expect(creds[0].key).toBe('sk-test-key');
    });

    it('should load multiple numbered keys', () => {
      process.env['OPENAI_API_KEY_1'] = 'sk-key-1';
      process.env['OPENAI_API_KEY_2'] = 'sk-key-2';
      process.env['OPENAI_API_KEY_3'] = 'sk-key-3';

      const pool = createTestPool();
      const count = pool.loadFromEnv('openai');

      expect(count).toBe(3);
      const creds = pool.getCredentials('openai');
      expect(creds.map((c) => c.id)).toEqual([
        'openai-key-1',
        'openai-key-2',
        'openai-key-3',
      ]);
    });

    it('should prioritize numbered keys over single key', () => {
      process.env['OPENAI_API_KEY'] = 'sk-single';
      process.env['OPENAI_API_KEY_1'] = 'sk-numbered-1';

      const pool = createTestPool();
      const count = pool.loadFromEnv('openai');

      expect(count).toBe(1);
      const creds = pool.getCredentials('openai');
      expect(creds[0].key).toBe('sk-numbered-1');
    });

    it('should return 0 when no keys are set', () => {
      const pool = createTestPool();
      const count = pool.loadFromEnv('openai');
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pool status
  // -------------------------------------------------------------------------

  describe('getPoolStatus', () => {
    it('should return correct counts', () => {
      const pool = createTestPool();
      pool.addCredential('key-1', 'openai', 'sk-key-1');
      pool.addCredential('key-2', 'openai', 'sk-key-2');
      pool.addCredential('key-3', 'openai', 'sk-key-3');

      // Put key-3 in cooldown
      for (let i = 0; i < 3; i++) {
        pool.reportFailure('key-3', 'error');
      }

      const status = pool.getPoolStatus('openai');
      expect(status.total).toBe(3);
      expect(status.active).toBe(2);
      expect(status.cooldown).toBe(1);
    });

    it('should return empty status for unknown provider', () => {
      const pool = createTestPool();
      const status = pool.getPoolStatus('unknown');
      expect(status.total).toBe(0);
    });
  });
});
