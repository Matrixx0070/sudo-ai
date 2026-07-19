/**
 * Unit tests for ConsciousnessOrchestrator.
 *
 * The orchestrator has deep dependencies on many sub-modules that each write
 * to an SQLite database. We mock all sub-modules using proper class mocks
 * so no real SQLite or file-system access happens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all consciousness sub-modules with proper class constructors
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/consciousness/consciousness-db.js', () => {
  const mockDb = {
    getDb: vi.fn(() => ({
      prepare: vi.fn(() => ({
        run: vi.fn(),
        all: vi.fn(() => []),
        get: vi.fn(() => undefined),
      })),
    })),
    close: vi.fn(),
  };
  return {
    ConsciousnessDB: vi.fn().mockImplementation(function () {
      return mockDb;
    }),
  };
});

vi.mock('../../../src/core/consciousness/embodied-state/index.js', () => {
  const instance = {
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => ({
      energy: 0.8,
      clarity: 0.7,
      sampledAt: new Date().toISOString(),
    })),
  };
  return {
    EmbodiedStateEngine: vi.fn().mockImplementation(function () {
      return instance;
    }),
  };
});

vi.mock('../../../src/core/consciousness/spreading-activation/index.js', () => ({
  SpreadingActivationNetwork: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../../src/core/consciousness/emotional-memory/index.js', () => {
  const instance = {
    getCurrentState: vi.fn(() => ({
      dominantEmotion: 'neutral',
      intensity: 0.5,
      tags: [],
      valence: 0,
    })),
  };
  return {
    EmotionalStateManager: vi.fn().mockImplementation(function () {
      return instance;
    }),
  };
});

vi.mock('../../../src/core/consciousness/attention-system/index.js', () => ({
  AttentionManager: vi.fn().mockImplementation(function () {
    return { submitSignal: vi.fn() };
  }),
}));

vi.mock('../../../src/core/consciousness/cognitive-stream/index.js', () => {
  const instance = {
    start: vi.fn(),
    stop: vi.fn(),
    interrupt: vi.fn(async () => ({
      contextSummary: 'mock context',
      activeConcepts: [],
    })),
    getRecentThoughts: vi.fn(() => []),
    getState: vi.fn(() => ({ thoughtCount: 0, isRunning: false })),
  };
  return {
    CognitiveStream: vi.fn().mockImplementation(function () {
      return instance;
    }),
  };
});

vi.mock('../../../src/core/consciousness/episodic-memory/index.js', () => ({
  EpisodicMemory: vi.fn().mockImplementation(function () {
    return { recordEpisode: vi.fn() };
  }),
  // CW5: orchestrator now imports the flag-aware signals helper from this
  // barrel; mirror the real contract (flag OFF -> legacy constants).
  computeEpisodeSignals: vi.fn(() => ({ surpriseLevel: 0, significance: 0.5 })),
}));

vi.mock('../../../src/core/consciousness/drive-system/index.js', () => ({
  DriveManager: vi.fn().mockImplementation(function () {
    return {
      compute: vi.fn(),
      getDominant: vi.fn(() => ({ name: 'curiosity', satisfiedBy: 'learning' })),
    };
  }),
}));

vi.mock('../../../src/core/consciousness/world-model/index.js', () => ({
  WorldModel: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../../src/core/consciousness/self-model/index.js', () => ({
  SelfModel: vi.fn().mockImplementation(function () {
    return {
      updateFromEpisode: vi.fn(),
      toPromptSummary: vi.fn(() => 'Mock self summary line 1\nLine 2'),
    };
  }),
}));

vi.mock('../../../src/core/consciousness/theory-of-mind/index.js', () => ({
  TheoryOfMind: vi.fn().mockImplementation(function () {
    return { updateUserModel: vi.fn(async () => undefined) };
  }),
}));

vi.mock('../../../src/core/consciousness/prospective-memory/index.js', () => ({
  ProspectiveMemory: vi.fn().mockImplementation(function () {
    return {
      expirePast: vi.fn(),
      checkTriggers: vi.fn(),
      getPending: vi.fn(() => []),
    };
  }),
}));

vi.mock('../../../src/core/consciousness/relationship-model/index.js', () => ({
  RelationshipTracker: vi.fn().mockImplementation(function () {
    return { updateFromInteraction: vi.fn() };
  }),
}));

vi.mock('../../../src/core/consciousness/internal-dialogue/index.js', () => ({
  InternalDialogue: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../../src/core/consciousness/metacognition/index.js', () => ({
  MetacognitionEngine: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../../src/core/consciousness/counterfactual-engine/index.js', () => ({
  CounterfactualEngine: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../../src/core/consciousness/temporal-self/index.js', () => ({
  TemporalSelf: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

import { ConsciousnessOrchestrator } from '../../../src/core/consciousness/orchestrator.js';
import { ConsciousnessError } from '../../../src/core/consciousness/errors.js';

// ---------------------------------------------------------------------------
// Mock brain factory
// ---------------------------------------------------------------------------

function makeMockBrain() {
  return {
    call: vi.fn(async () => ({ content: 'mock introspection response' })),
  };
}

// ---------------------------------------------------------------------------
// Tests — Construction
// ---------------------------------------------------------------------------

describe('ConsciousnessOrchestrator — construction', () => {
  it('constructs with a valid brain', () => {
    const brain = makeMockBrain();
    expect(() => new ConsciousnessOrchestrator(brain)).not.toThrow();
  });

  it('throws ConsciousnessError when brain is null', () => {
    expect(() => new ConsciousnessOrchestrator(null as unknown as ReturnType<typeof makeMockBrain>)).toThrow(ConsciousnessError);
  });

  it('throws ConsciousnessError when brain has no call() method', () => {
    expect(() => new ConsciousnessOrchestrator({} as unknown as ReturnType<typeof makeMockBrain>)).toThrow(ConsciousnessError);
  });

  it('accepts config overrides without throwing', () => {
    const brain = makeMockBrain();
    expect(
      () => new ConsciousnessOrchestrator(brain, { streamModel: 'xai/grok-3-fast', quietHoursStart: 22, quietHoursEnd: 6 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — Before boot
// ---------------------------------------------------------------------------

describe('ConsciousnessOrchestrator — before boot', () => {
  it('getState() returns isBooted: false when not booted', () => {
    const orch = new ConsciousnessOrchestrator(makeMockBrain());
    expect(orch.getState().isBooted).toBe(false);
  });

  it('getState() returns null bodyState when not booted', () => {
    const orch = new ConsciousnessOrchestrator(makeMockBrain());
    expect(orch.getState().bodyState).toBeNull();
  });

  it('getConsciousnessContext() returns "not booted" message when not booted', () => {
    const orch = new ConsciousnessOrchestrator(makeMockBrain());
    expect(orch.getConsciousnessContext()).toContain('not booted');
  });

  it('onInteractionStart() throws ConsciousnessError when not booted', async () => {
    const orch = new ConsciousnessOrchestrator(makeMockBrain());
    await expect(orch.onInteractionStart('user-1', 'hello')).rejects.toThrow(ConsciousnessError);
  });

  it('shutdown() throws ConsciousnessError when not booted', async () => {
    const orch = new ConsciousnessOrchestrator(makeMockBrain());
    await expect(orch.shutdown()).rejects.toThrow(ConsciousnessError);
  });

  it('introspect() throws ConsciousnessError when not booted', async () => {
    const orch = new ConsciousnessOrchestrator(makeMockBrain());
    await expect(orch.introspect('What am I?')).rejects.toThrow(ConsciousnessError);
  });
});

// ---------------------------------------------------------------------------
// Tests — After boot
// ---------------------------------------------------------------------------

describe('ConsciousnessOrchestrator — after boot', () => {
  let orch: ConsciousnessOrchestrator;
  let brain: ReturnType<typeof makeMockBrain>;

  beforeEach(async () => {
    brain = makeMockBrain();
    orch = new ConsciousnessOrchestrator(brain);
    await orch.boot();
  });

  afterEach(async () => {
    // Each test boots a fresh orchestrator; shut it down so its process
    // 'sudo:consciousness:control' listener (and DB handle) is released and does
    // not accumulate across tests (MaxListenersExceededWarning).
    try { await orch.shutdown(); } catch { /* a test may have already shut it down */ }
  });

  it('boot() sets isBooted to true', () => {
    expect(orch.getState().isBooted).toBe(true);
  });

  it('calling boot() twice does not throw', async () => {
    await expect(orch.boot()).resolves.not.toThrow();
  });

  it('getConsciousnessContext() returns a string containing "Internal State"', () => {
    const ctx = orch.getConsciousnessContext();
    expect(typeof ctx).toBe('string');
    expect(ctx).toContain('Internal State');
  });

  it('getConsciousnessContext() includes body energy and clarity', () => {
    const ctx = orch.getConsciousnessContext();
    expect(ctx).toContain('energy=');
    expect(ctx).toContain('clarity=');
  });

  it('getState() returns non-null bodyState after boot', () => {
    expect(orch.getState().bodyState).not.toBeNull();
  });

  it('getState() returns non-null emotionalState after boot', () => {
    expect(orch.getState().emotionalState).not.toBeNull();
  });

  it('onInteractionStart() returns InterruptResult with contextSummary', async () => {
    const result = await orch.onInteractionStart('user-1', 'hello world');
    expect(result).toBeDefined();
    expect(typeof result.contextSummary).toBe('string');
  });

  it('onInteractionStart() throws ConsciousnessError with empty userId', async () => {
    await expect(orch.onInteractionStart('', 'hello')).rejects.toThrow(ConsciousnessError);
  });

  it('onInteractionEnd() with valid params does not throw', async () => {
    await expect(
      orch.onInteractionEnd('session-1', [{ role: 'user', content: 'test' }], 'positive'),
    ).resolves.not.toThrow();
  });

  it('onInteractionEnd() with empty messages array returns without throwing', async () => {
    await expect(orch.onInteractionEnd('session-1', [], 'neutral')).resolves.not.toThrow();
  });

  it('introspect() returns a string response', async () => {
    const answer = await orch.introspect('What is my current mood?');
    expect(typeof answer).toBe('string');
    expect(answer.length).toBeGreaterThan(0);
  });

  it('introspect() throws ConsciousnessError for empty question', async () => {
    await expect(orch.introspect('')).rejects.toThrow(ConsciousnessError);
  });

  it('introspect() calls brain.call() with the question', async () => {
    await orch.introspect('Am I self-aware?');
    expect(brain.call).toHaveBeenCalled();
    const callArg = brain.call.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
    const hasQuestion = callArg?.messages?.some((m) => m.content === 'Am I self-aware?');
    expect(hasQuestion).toBe(true);
  });

  it('attachSleepCycle() does not throw', () => {
    const sleepCycle = {
      shouldSleep: vi.fn(() => false),
      startSleep: vi.fn(async () => undefined),
      isAsleep: vi.fn(() => false),
      wakeUp: vi.fn(),
    };
    expect(() => orch.attachSleepCycle(sleepCycle)).not.toThrow();
  });

  it('attachSelfEvolution() does not throw', () => {
    const selfEvo = {
      getDNA: vi.fn(() => ({ seed: 'abc', birthDate: '2026-01-01' })),
      recordFailure: vi.fn(),
    };
    expect(() => orch.attachSelfEvolution(selfEvo)).not.toThrow();
  });

  it('shutdown() after boot succeeds', async () => {
    await expect(orch.shutdown()).resolves.not.toThrow();
  });
});
