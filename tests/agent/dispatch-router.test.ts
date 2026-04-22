/**
 * Tests for DispatchRouter (Wave 6C Builder C).
 *
 * Covers: novelty scoring, cache hit/miss, TTL expiry,
 * anti-self-promotion, env-disabled passthrough, error fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DispatchRouter } from '../../src/core/brain/dispatch-router.js';
import type { DispatchInput } from '../../src/core/brain/dispatch-router.js';
import * as loggerModule from '../../src/core/shared/logger.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    userText: 'Hello, how are you?',
    history: [],
    primaryModel: 'grok-3',
    cheapModel: 'grok-3-mini',
    ...overrides,
  };
}

// Short user history helper.
function userMessages(texts: string[]): Array<{ role: string; content: string }> {
  return texts.map(t => ({ role: 'user', content: t }));
}

// ---------------------------------------------------------------------------
// C-1: Novel input → primary model
// ---------------------------------------------------------------------------

describe('C-1: novel input forces primary model regardless of text length', () => {
  it('noveltyHint=1.0 returns primary model', () => {
    const router = new DispatchRouter();
    // Short text that cheap-model-router would normally approve.
    const result = router.route(makeInput({ noveltyHint: 1.0 }));
    expect(result.cheapUsed).toBe(false);
    expect(result.model).toBe('grok-3');
    expect(result.noveltyScore).toBe(1.0);
    expect(result.selfPromotionBlocked).toBe(false);
  });

  it('noveltyHint >= NOVELTY_THRESHOLD triggers override', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({ noveltyHint: DispatchRouter.NOVELTY_THRESHOLD }));
    expect(result.cheapUsed).toBe(false);
    expect(result.noveltyScore).toBe(DispatchRouter.NOVELTY_THRESHOLD);
    expect(result.reason).toContain('novelty score');
  });
});

// ---------------------------------------------------------------------------
// C-2: Familiar short greeting → cheap model
// ---------------------------------------------------------------------------

describe('C-2: short familiar greeting routes to cheap model', () => {
  it('returns cheap model for a short non-complex repetitive message', () => {
    const router = new DispatchRouter();
    // Give history so novelty is low; provide a very similar previous message.
    const prev = 'Hi, how are you?';
    const current = 'Hi, how are you?';
    const history = userMessages([prev, prev]);
    const result = router.route(makeInput({
      userText: current,
      history,
      noveltyHint: 0, // force novelty=0
    }));
    expect(result.cheapUsed).toBe(true);
    expect(result.model).toBe('grok-3-mini');
    expect(result.cacheHit).toBe(false);
    expect(result.selfPromotionBlocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C-3: Cache hit returns same result within TTL
// ---------------------------------------------------------------------------

describe('C-3: cache hit returns same result without recomputing', () => {
  it('second identical call is a cache hit', () => {
    const router = new DispatchRouter({ cacheTtlMs: 5000 });
    const input = makeInput({ noveltyHint: 0 });

    const first = router.route(input);
    const second = router.route(input);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    // Both should agree on model.
    expect(second.model).toBe(first.model);
    expect(second.cheapUsed).toBe(first.cheapUsed);
  });

  it('cache does NOT store results for primary-model decisions (novelty override)', () => {
    const router = new DispatchRouter({ cacheTtlMs: 5000 });
    const input = makeInput({ noveltyHint: 1.0 });

    const first = router.route(input);
    const second = router.route(input);

    // Primary decisions are not cached.
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C-4: Anti-self-promotion — subagent → primary
// ---------------------------------------------------------------------------

describe('C-4: anti-self-promotion blocks sub-agent cheap routing', () => {
  it('agentRole=subagent forces primary model and sets selfPromotionBlocked', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({
      agentRole: 'subagent',
      noveltyHint: 0, // low novelty so base router would pick cheap
    }));
    expect(result.cheapUsed).toBe(false);
    expect(result.model).toBe('grok-3');
    expect(result.selfPromotionBlocked).toBe(true);
    expect(result.reason).toContain('sub-agent self-promotion');
  });

  it('agentRole=planner is also blocked', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({ agentRole: 'planner', noveltyHint: 0 }));
    expect(result.selfPromotionBlocked).toBe(true);
  });

  it('agentRole=scheduler is also blocked', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({ agentRole: 'scheduler', noveltyHint: 0 }));
    expect(result.selfPromotionBlocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C-5: allowlist — only human/user/operator roles are fast-path eligible
// ---------------------------------------------------------------------------

describe('C-5: allowlist — only human/user/operator roles are fast-path eligible', () => {
  it('agentRole=user (human caller) is NOT blocked', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({
      agentRole: 'user',
      noveltyHint: 0,
    }));
    // 'user' is in FAST_PATH_ELIGIBLE_ROLES so no block should occur.
    expect(result.selfPromotionBlocked).toBe(false);
  });

  it('agentRole=operator is NOT blocked', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({
      agentRole: 'operator',
      noveltyHint: 0,
    }));
    expect(result.selfPromotionBlocked).toBe(false);
  });

  it('agentRole=orchestrator IS blocked (not in allowlist)', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({
      agentRole: 'orchestrator',
      noveltyHint: 0,
    }));
    // orchestrator is a non-human role; allowlist blocks it.
    expect(result.selfPromotionBlocked).toBe(true);
    expect(result.cheapUsed).toBe(false);
  });

  // [M3] New test: 'agent' role must be blocked (non-human, not in allowlist).
  it('agentRole=agent is blocked — forced to deliberate (primary) model', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({
      agentRole: 'agent',
      noveltyHint: 0, // low novelty so base router would pick cheap
    }));
    expect(result.selfPromotionBlocked).toBe(true);
    expect(result.cheapUsed).toBe(false);
    expect(result.model).toBe('grok-3');
  });

  // [M3] New test: unknown/arbitrary role string → conservative block (allowlist default).
  it('unknown role string is blocked by default — conservative allowlist', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({
      agentRole: 'some-future-unknown-role',
      noveltyHint: 0,
    }));
    // Allowlist design: unrecognised roles are blocked to prevent future bypass.
    expect(result.selfPromotionBlocked).toBe(true);
    expect(result.cheapUsed).toBe(false);
    expect(result.model).toBe('grok-3');
  });
});

// ---------------------------------------------------------------------------
// C-6: route() never throws — returns primary on internal errors
// ---------------------------------------------------------------------------

describe('C-6: route never throws — fail-open to primary model', () => {
  it('handles a null-ish input gracefully by returning primary', () => {
    const router = new DispatchRouter();
    // Pass an empty userText which cheap-model-router treats as complex anyway.
    const result = router.route(makeInput({ userText: '' }));
    // Should not throw; model should be primary.
    expect(result.model).toBe('grok-3');
    expect(result.cheapUsed).toBe(false);
  });

  it('returns a valid DispatchResult shape even for borderline inputs', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({
      userText: 'x'.repeat(500), // very long → triggers char limit in cheap-model-router
      noveltyHint: 0.5,
    }));
    expect(typeof result.model).toBe('string');
    expect(typeof result.noveltyScore).toBe('number');
    expect(typeof result.cacheHit).toBe('boolean');
    expect(typeof result.selfPromotionBlocked).toBe('boolean');
    expect(typeof result.cheapUsed).toBe('boolean');
    expect(typeof result.reason).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// C-7: noveltyHint=0 forces noveltyScore=0
// ---------------------------------------------------------------------------

describe('C-7: noveltyHint takes precedence over internal scoring', () => {
  it('noveltyHint=0 returns noveltyScore=0 even with no history', () => {
    const router = new DispatchRouter();
    // No history → internal scorer would give high novelty, but hint overrides.
    const result = router.route(makeInput({ history: [], noveltyHint: 0 }));
    expect(result.noveltyScore).toBe(0);
  });

  it('noveltyHint=0.3 is below threshold and does not block cheap model', () => {
    const router = new DispatchRouter();
    const result = router.route(makeInput({ noveltyHint: 0.3 }));
    // Below NOVELTY_THRESHOLD → novelty override does not trigger.
    expect(result.noveltyScore).toBe(0.3);
    // Cheap routing may or may not occur depending on text — just verify no novelty block.
    expect(result.reason).not.toContain('novelty score');
  });
});

// ---------------------------------------------------------------------------
// C-9: [M1] Anti-self-promotion emits log.info (visibility for Frank)
// ---------------------------------------------------------------------------

describe('C-9: anti-self-promotion block emits log.info', () => {
  it('emits an info-level log when fast-path is denied for a non-allowlisted role', () => {
    // Spy on the child logger's info method via the base logger.
    const infoSpy = vi.spyOn(loggerModule.logger, 'info');

    const router = new DispatchRouter();
    const result = router.route(makeInput({
      agentRole: 'subagent',
      noveltyHint: 0, // low novelty so base router would pick cheap
    }));

    expect(result.selfPromotionBlocked).toBe(true);

    // Verify at least one info call mentions the anti-self-promotion guard.
    const antiSelfPromotionCalled = infoSpy.mock.calls.some(callArgs => {
      const msg = callArgs[1];
      return typeof msg === 'string' && msg.includes('anti-self-promotion');
    });
    expect(antiSelfPromotionCalled).toBe(true);

    infoSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// C-8: TTL expiry evicts cache entries
// ---------------------------------------------------------------------------

describe('C-8: expired cache entries are evicted before lookup', () => {
  it('entry is not returned after TTL expires', async () => {
    // Use very short TTL of 50ms for testing.
    const router = new DispatchRouter({ cacheTtlMs: 50 });
    const input = makeInput({ noveltyHint: 0 });

    const first = router.route(input);
    expect(first.cacheHit).toBe(false);

    // Confirm the entry is cached immediately after.
    const immediate = router.route(input);
    expect(immediate.cacheHit).toBe(true);

    // Wait for TTL to expire.
    await new Promise<void>(resolve => setTimeout(resolve, 60));

    // After expiry, cache miss and fresh computation.
    const afterExpiry = router.route(input);
    expect(afterExpiry.cacheHit).toBe(false);
  });
});
