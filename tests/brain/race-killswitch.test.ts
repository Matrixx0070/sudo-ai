/**
 * @file tests/brain/race-killswitch.test.ts
 * @description Tests for SUDO_BRAIN_CONSENSUS_DISABLE kill-switch in brain.ts.
 *
 * Tests:
 *  1. CONSENSUS-KS-1: When SUDO_BRAIN_CONSENSUS_DISABLE=1, consensus is SKIPPED
 *  2. CONSENSUS-KS-2: When SUDO_BRAIN_CONSENSUS_DISABLE is unset, consensus proceeds
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockBrain(
  cloudProfiles: ModelProfile[] = [],
  options?: {
    noSequentialFallback?: boolean;
    sequentialProfile?: ModelProfile;
  }
): {
  brain: Brain;
  mocks: {
    getCloudProfiles: ReturnType<typeof vi.fn>;
    callSingleModel: ReturnType<typeof vi.fn>;
    failover: { recordError: ReturnType<typeof vi.fn> };
    getNextProfile: ReturnType<typeof vi.fn>;
  };
} {
  const brain = new Brain(null);

  const getCloudProfilesMock = vi.fn().mockReturnValue(cloudProfiles);
  (brain as any).failover.getCloudProfiles = getCloudProfilesMock;

  const callSingleModelMock = vi.fn().mockImplementation(async (profile: ModelProfile) => ({
    content: `response-from-${profile.id}`,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.001 },
    model: profile.id,
    finishReason: 'stop' as const,
  }));
  (brain as any)._callSingleModel = callSingleModelMock;

  const recordErrorMock = vi.fn();
  (brain as any).failover.recordError = recordErrorMock;

  const getNextProfileMock = vi.fn().mockReturnValue(
    options?.noSequentialFallback ? null : (options?.sequentialProfile ?? null)
  );
  (brain as any).failover.getNextProfile = getNextProfileMock;

  return {
    brain,
    mocks: {
      getCloudProfiles: getCloudProfilesMock,
      callSingleModel: callSingleModelMock,
      failover: { recordError: recordErrorMock },
      getNextProfile: getNextProfileMock,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SUDO_BRAIN_CONSENSUS_DISABLE kill-switch', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv['SUDO_BRAIN_CONSENSUS_DISABLE'] = process.env['SUDO_BRAIN_CONSENSUS_DISABLE'];
    delete process.env['SUDO_BRAIN_CONSENSUS_DISABLE'];
    // Guard against consensus early-exit env leaking in and reducing the model
    // count this suite asserts on (it expects all cloud models to be called).
    delete process.env['SUDO_CONSENSUS_MIN_AGREEMENT'];
    delete process.env['SUDO_CONSENSUS_TIMEOUT_MS'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv['SUDO_BRAIN_CONSENSUS_DISABLE'] !== undefined) {
      process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = originalEnv['SUDO_BRAIN_CONSENSUS_DISABLE'];
    } else {
      delete process.env['SUDO_BRAIN_CONSENSUS_DISABLE'];
    }
    vi.clearAllMocks();
  });

  const testMessages = [
    { role: 'user' as const, content: 'Hello, test!' },
  ];

  const cloudProfiles: ModelProfile[] = [
    {
      id: 'ollama/kimi-k2.6:cloud',
      provider: 'openai' as any,
      modelId: 'kimi-k2.6:cloud',
      priority: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      consecutiveErrors: 0,
      disabled: false,
    },
    {
      id: 'ollama/glm-5.1:cloud',
      provider: 'openai' as any,
      modelId: 'glm-5.1:cloud',
      priority: 1,
      lastUsed: 0,
      cooldownUntil: 0,
      consecutiveErrors: 0,
      disabled: false,
    },
  ];

  describe('CONSENSUS-KS-1: Kill-switch enabled', () => {
    it('skips consensus when SUDO_BRAIN_CONSENSUS_DISABLE=1', async () => {
      process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1';

      const sequentialProfile: ModelProfile = {
        id: 'ollama/qwen3.5:latest',
        provider: 'openai' as any,
        modelId: 'qwen3.5:latest',
        priority: 2,
        lastUsed: 0,
        cooldownUntil: 0,
        consecutiveErrors: 0,
        disabled: false,
      };

      const { brain, mocks } = createMockBrain(cloudProfiles, {
        sequentialProfile,
      });

      await brain.call({ messages: testMessages });

      // Consensus skipped, falls to sequential
      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(1);
      expect(mocks.callSingleModel).toHaveBeenCalledWith(
        sequentialProfile,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });
  });

  describe('CONSENSUS-KS-2: Kill-switch disabled (default)', () => {
    it('proceeds with consensus when SUDO_BRAIN_CONSENSUS_DISABLE is unset', async () => {
      delete process.env['SUDO_BRAIN_CONSENSUS_DISABLE'];

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({ messages: testMessages });

      // Consensus should call all cloud profiles
      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);
    });
  });

  describe('Edge cases', () => {
    it('handles empty cloud profiles gracefully', async () => {
      process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1';

      const sequentialProfile: ModelProfile = {
        id: 'ollama/qwen3.5:latest',
        provider: 'openai' as any,
        modelId: 'qwen3.5:latest',
        priority: 2,
        lastUsed: 0,
        cooldownUntil: 0,
        consecutiveErrors: 0,
        disabled: false,
      };

      const { brain, mocks } = createMockBrain([], { sequentialProfile });

      await brain.call({ messages: testMessages });

      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(1);
    });

    it('handles SUDO_BRAIN_CONSENSUS_DISABLE with invalid values', async () => {
      process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = 'true';

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({ messages: testMessages });

      // 'true' !== '1', so consensus should still occur
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);
    });

    it('handles SUDO_BRAIN_CONSENSUS_DISABLE=0', async () => {
      process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '0';

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({ messages: testMessages });

      // '0' !== '1', so consensus should occur
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);
    });
  });
});
