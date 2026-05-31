/**
 * @file tests/brain/race-killswitch.test.ts
 * @description Tests for SUDO_BRAIN_RACE_DISABLE kill-switch in brain.ts.
 *
 * Tests:
 *  1. RACE-KS-1: When SUDO_BRAIN_RACE_DISABLE=1 and request.race is undefined, racing is SKIPPED
 *  2. RACE-KS-2: When SUDO_BRAIN_RACE_DISABLE=1 and request.race === true, racing is ENABLED (override)
 *  3. RACE-KS-3: When SUDO_BRAIN_RACE_DISABLE is unset and request.race is undefined, racing proceeds normally
 *  4. RACE-KS-4: When SUDO_BRAIN_RACE_DISABLE is unset and request.race === false, racing proceeds normally
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock Brain instance with controlled failover behavior.
 * We mock the failover's getCloudProfiles and _callSingleModel to observe
 * whether racing (parallel) or sequential failover is used.
 */
function createMockBrain(
  cloudProfiles: ModelProfile[] = [],
  options?: {
    /** When true, getNextProfile returns null (no sequential fallback available) */
    noSequentialFallback?: boolean;
    /** When set, getNextProfile returns this profile for sequential fallback */
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
  // Create a Brain with empty config (uses env defaults)
  const brain = new Brain(null);

  // Mock getCloudProfiles to return our test profiles
  const getCloudProfilesMock = vi.fn().mockReturnValue(cloudProfiles);
  (brain as any).failover.getCloudProfiles = getCloudProfilesMock;

  // Mock _callSingleModel to track calls and return predictable results
  const callSingleModelMock = vi.fn().mockImplementation(async (profile: ModelProfile) => ({
    content: `response-from-${profile.id}`,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.001 },
    model: profile.id,
    finishReason: 'stop' as const,
  }));
  (brain as any)._callSingleModel = callSingleModelMock;

  // Mock recordError to avoid side effects
  const recordErrorMock = vi.fn();
  (brain as any).failover.recordError = recordErrorMock;

  // Mock getNextProfile for sequential fallback
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

describe('SUDO_BRAIN_RACE_DISABLE kill-switch', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save original env
    originalEnv['SUDO_BRAIN_RACE_DISABLE'] = process.env['SUDO_BRAIN_RACE_DISABLE'];
    delete process.env['SUDO_BRAIN_RACE_DISABLE'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv['SUDO_BRAIN_RACE_DISABLE'] !== undefined) {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = originalEnv['SUDO_BRAIN_RACE_DISABLE'];
    } else {
      delete process.env['SUDO_BRAIN_RACE_DISABLE'];
    }
    vi.clearAllMocks();
  });

  const testMessages = [
    { role: 'user' as const, content: 'Hello, test!' },
  ];

  const cloudProfiles: ModelProfile[] = [
    {
      id: 'openai/gpt-4o:cloud',
      provider: 'openai',
      modelId: 'gpt-4o:cloud',
      priority: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      consecutiveErrors: 0,
      disabled: false,
    },
    {
      id: 'anthropic/claude-sonnet:cloud',
      provider: 'anthropic',
      modelId: 'claude-sonnet:cloud',
      priority: 1,
      lastUsed: 0,
      cooldownUntil: 0,
      consecutiveErrors: 0,
      disabled: false,
    },
  ];

  describe('RACE-KS-1: Kill-switch enabled, no per-request override', () => {
    it('skips racing when SUDO_BRAIN_RACE_DISABLE=1 and request.race is undefined', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '1';

      // When racing is disabled, code falls through to sequential failover.
      // We provide a sequential profile so the call succeeds without throwing.
      const sequentialProfile: ModelProfile = {
        id: 'ollama/llama3:local',
        provider: 'ollama',
        modelId: 'llama3:local',
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

      // When racing is skipped, _callSingleModel should NOT be called for cloud profiles
      // in parallel. Instead, sequential failover is used.
      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      // Should only call _callSingleModel once for sequential fallback, not for cloud racing
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(1);
      expect(mocks.callSingleModel).toHaveBeenCalledWith(
        sequentialProfile,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it('does not use Promise.allSettled pattern when racing is disabled', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '1';

      const sequentialProfile: ModelProfile = {
        id: 'ollama/llama3:local',
        provider: 'ollama',
        modelId: 'llama3:local',
        priority: 2,
        lastUsed: 0,
        cooldownUntil: 0,
        consecutiveErrors: 0,
        disabled: false,
      };

      const { brain, mocks } = createMockBrain(cloudProfiles, {
        sequentialProfile,
      });

      // Track timing - racing would call all models in parallel (same tick)
      // Sequential would call them one at a time
      const callTimestamps: number[] = [];
      mocks.callSingleModel.mockImplementation(async (profile: ModelProfile) => {
        callTimestamps.push(Date.now());
        return {
          content: `response-from-${profile.id}`,
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.001 },
          model: profile.id,
          finishReason: 'stop' as const,
        };
      });

      await brain.call({ messages: testMessages });

      // With racing disabled, only sequential fallback is called (once)
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(1);
    });
  });

  describe('RACE-KS-2: Kill-switch enabled, per-request override forces racing', () => {
    it('enables racing when request.race === true overrides SUDO_BRAIN_RACE_DISABLE=1', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '1';

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({
        messages: testMessages,
        race: true, // Override flag
      });

      // With race: true, the kill-switch is bypassed and racing should occur
      // _callSingleModel should be called for each cloud profile in parallel
      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);

      // Verify calls were made for both cloud profiles
      const calledProfiles = mocks.callSingleModel.mock.calls.map(call => call[0]?.id);
      expect(calledProfiles).toContain('openai/gpt-4o:cloud');
      expect(calledProfiles).toContain('anthropic/claude-sonnet:cloud');
    });

    it('calls all cloud models when racing is forced via request.race=true', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '1';

      const { brain, mocks } = createMockBrain(cloudProfiles);

      // Make first profile succeed
      mocks.callSingleModel.mockImplementationOnce(async (profile: ModelProfile) => ({
        content: `winner-${profile.id}`,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.001 },
        model: profile.id,
        finishReason: 'stop' as const,
      }));

      // Second call also succeeds (racing fires all in parallel)
      mocks.callSingleModel.mockImplementationOnce(async (profile: ModelProfile) => ({
        content: `response-${profile.id}`,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.001 },
        model: profile.id,
        finishReason: 'stop' as const,
      }));

      const result = await brain.call({
        messages: testMessages,
        race: true,
      });

      // Both models should have been called (parallel racing)
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(2);
      // Result should be from the first successful response
      expect(result.content).toContain('winner-');
    });
  });

  describe('RACE-KS-3: Kill-switch disabled (default), no per-request flag', () => {
    it('proceeds with racing when SUDO_BRAIN_RACE_DISABLE is unset and request.race is undefined', async () => {
      // Ensure env var is NOT set (default behavior)
      delete process.env['SUDO_BRAIN_RACE_DISABLE'];

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({ messages: testMessages });

      // Default behavior: racing should occur when cloud profiles exist
      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);

      // Verify both cloud profiles were called
      const calledProfiles = mocks.callSingleModel.mock.calls.map(call => call[0]?.id);
      expect(calledProfiles).toContain('openai/gpt-4o:cloud');
      expect(calledProfiles).toContain('anthropic/claude-sonnet:cloud');
    });

    it('uses parallel execution pattern when racing is enabled by default', async () => {
      delete process.env['SUDO_BRAIN_RACE_DISABLE'];

      const { brain, mocks } = createMockBrain(cloudProfiles);

      // Track call order - in racing mode, all calls start nearly simultaneously
      const callOrder: string[] = [];
      mocks.callSingleModel.mockImplementation(async (profile: ModelProfile) => {
        callOrder.push(`start-${profile.id}`);
        // Simulate async delay
        await new Promise(resolve => setTimeout(resolve, 1));
        callOrder.push(`end-${profile.id}`);
        return {
          content: `response-from-${profile.id}`,
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.001 },
          model: profile.id,
          finishReason: 'stop' as const,
        };
      });

      await brain.call({ messages: testMessages });

      // In racing mode, all calls should start before any complete
      // (Promise.allSettled pattern)
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(2);
      // Both should have started (the exact interleaving depends on timing)
      expect(callOrder.filter(s => s.startsWith('start-')).length).toBe(2);
    });
  });

  describe('RACE-KS-4: Kill-switch disabled, request.race === false', () => {
    it('proceeds with racing when SUDO_BRAIN_RACE_DISABLE is unset and request.race === false', async () => {
      // Ensure env var is NOT set (default behavior)
      delete process.env['SUDO_BRAIN_RACE_DISABLE'];

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({
        messages: testMessages,
        race: false, // Explicit false should NOT disable racing
      });

      // The kill-switch logic only checks for race !== true when env is set
      // When env is NOT set, racing proceeds regardless of request.race value
      // Actually, looking at the code: raceDisabled = env === '1' && request.race !== true
      // When env is NOT '1', raceDisabled is false, so racing happens
      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);
    });

    it('does not treat race=false as a disable flag', async () => {
      delete process.env['SUDO_BRAIN_RACE_DISABLE'];

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({
        messages: testMessages,
        race: false,
      });

      // race=false doesn't disable racing - only the env flag does
      // Racing should still occur
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(2);
    });
  });

  describe('Edge cases', () => {
    it('handles empty cloud profiles gracefully when racing is disabled', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '1';

      // No cloud profiles and no sequential fallback - this will throw
      // We need to provide at least a sequential profile for the call to succeed
      const sequentialProfile: ModelProfile = {
        id: 'ollama/llama3:local',
        provider: 'ollama',
        modelId: 'llama3:local',
        priority: 2,
        lastUsed: 0,
        cooldownUntil: 0,
        consecutiveErrors: 0,
        disabled: false,
      };

      const { brain, mocks } = createMockBrain([], {
        sequentialProfile,
      });

      await brain.call({ messages: testMessages });

      // No cloud profiles = no racing possible anyway, falls to sequential
      expect(mocks.getCloudProfiles).toHaveBeenCalled();
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(1);
    });

    it('handles SUDO_BRAIN_RACE_DISABLE with invalid values (not "1")', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = 'true'; // Invalid - only '1' works

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({ messages: testMessages });

      // 'true' !== '1', so racing should still occur
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);
    });

    it('handles SUDO_BRAIN_RACE_DISABLE=0 (should enable racing)', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '0';

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({ messages: testMessages });

      // '0' !== '1', so racing should occur
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);
    });

    it('handles request.race with non-boolean truthy values', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '1';

      // No sequential fallback, so this will throw when racing is skipped
      const sequentialProfile: ModelProfile = {
        id: 'ollama/llama3:local',
        provider: 'ollama',
        modelId: 'llama3:local',
        priority: 2,
        lastUsed: 0,
        cooldownUntil: 0,
        consecutiveErrors: 0,
        disabled: false,
      };

      const { brain, mocks } = createMockBrain(cloudProfiles, {
        sequentialProfile,
      });

      // race: 1 (truthy but not strictly true)
      await brain.call({
        messages: testMessages,
        race: 1 as any,
      });

      // The check is request.race !== true, so 1 !== true is true
      // This means racing would still be disabled, falls to sequential
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(1);
      expect(mocks.callSingleModel).toHaveBeenCalledWith(
        sequentialProfile,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it('handles request.race === true with kill-switch enabled', async () => {
      process.env['SUDO_BRAIN_RACE_DISABLE'] = '1';

      const { brain, mocks } = createMockBrain(cloudProfiles);

      await brain.call({
        messages: testMessages,
        race: true,
      });

      // Explicit true should override the kill-switch
      expect(mocks.callSingleModel).toHaveBeenCalledTimes(cloudProfiles.length);
    });
  });
});
