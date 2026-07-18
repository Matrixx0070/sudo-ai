/**
 * @file system-fold-callparams.test.ts
 * @description SUDO_FOLD_SYSTEM_MESSAGES — fold dropped role:'system' messages
 * into the effective system prompt so in-loop guidance (auto-plan PLAN,
 * compaction / session-fork summaries, safety warnings) actually reaches the
 * model. F97: the fold lives in buildEffectiveSystemPrompt, and the folded
 * string is passed as `system` in the request object handed to
 * `callTransportForBrain` (mocked here) — asserted on that field. Default-OFF
 * is byte-identical to prior behavior.
 *
 * FOLD-5..7 (Anthropic cache-path message layout: cached prefix + separate
 * uncached folded system message) were DROPPED: cache_control / message wire
 * layout is transport-owned post-F97 and covered by tests/llm +
 * tests/conformance goldens. The pure helper buildFoldedSystemMessages keeps
 * its unit pin below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const callTransportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/brain-bridge.js', () => ({
  callTransportForBrain: callTransportMock,
  streamTransportForBrain: vi.fn(),
}));

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn(),
  }),
}));

import {
  Brain,
  readFoldSystemEnabled,
  extractSystemMessageContent,
  buildEffectiveSystemPrompt,
  buildFoldedSystemMessages,
} from '../../src/core/brain/brain.js';
import { AuthProfileRotation } from '../../src/core/brain/auth-profile-rotation.js';
import type { ModelProfile, BrainMessage } from '../../src/core/brain/types.js';

function profile(id: string, provider: string): ModelProfile {
  return {
    id, provider, modelId: id.slice(id.indexOf('/') + 1),
    priority: 0, lastUsed: 0, cooldownUntil: 0, consecutiveErrors: 0, disabled: false,
  };
}

function okCall(text = 'ok') {
  return {
    result: {
      text,
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      toolCalls: [],
      reasoning: undefined,
      reasoningText: undefined,
      providerMetadata: undefined,
    },
    traceId: 'trace-fold',
  };
}

const SYS = 'BASE PERSONA PROMPT';

/** Run one attempt and return the request object handed to the transport. */
async function callBrain(request: object): Promise<Record<string, any>> {
  const brain = new Brain(null);
  await (brain as any).providersReady;
  await (brain as any)._callSingleModel(profile('anthropic/claude-test', 'anthropic'), request, SYS, 0.5, 1000);
  return callTransportMock.mock.calls[0]![0] as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('system-fold helpers', () => {
  it('readFoldSystemEnabled: true only on literal "1"', () => {
    expect(readFoldSystemEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(readFoldSystemEnabled({ SUDO_FOLD_SYSTEM_MESSAGES: '1' } as any)).toBe(true);
    for (const v of ['', '0', 'true', 'yes']) {
      expect(readFoldSystemEnabled({ SUDO_FOLD_SYSTEM_MESSAGES: v } as any)).toBe(false);
    }
  });

  it('extractSystemMessageContent: joins non-empty system contents in order, ignores other roles', () => {
    const msgs: BrainMessage[] = [
      { role: 'system', content: 'AAA' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: '   ' }, // whitespace-only dropped
      { role: 'system', content: 'BBB' },
      { role: 'assistant', content: 'CCC' },
    ];
    expect(extractSystemMessageContent(msgs)).toBe('AAA\n\nBBB');
  });

  it('buildEffectiveSystemPrompt: disabled → unchanged; enabled → appends folded; empty → unchanged', () => {
    const msgs: BrainMessage[] = [{ role: 'system', content: 'GUIDANCE' }, { role: 'user', content: 'hi' }];
    expect(buildEffectiveSystemPrompt(SYS, msgs, false)).toBe(SYS);
    expect(buildEffectiveSystemPrompt(SYS, msgs, true)).toBe(`${SYS}\n\nGUIDANCE`);
    expect(buildEffectiveSystemPrompt(SYS, [{ role: 'user', content: 'hi' }], true)).toBe(SYS);
  });
});

// ---------------------------------------------------------------------------
// Brain → transport request wiring (F97: assert the `system` field the bridge
// receives; message/wire layout is transport-owned)
// ---------------------------------------------------------------------------

describe('Brain → callTransportForBrain — system folding', () => {
  const KEYS = ['SUDO_FOLD_SYSTEM_MESSAGES'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    AuthProfileRotation.resetInstance();
    callTransportMock.mockReset();
    callTransportMock.mockResolvedValue(okCall());
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    AuthProfileRotation.resetInstance();
  });

  const REQ = { messages: [{ role: 'system', content: '# PLAN FOR THIS TASK\n1. step one' }, { role: 'user', content: 'hi' }] };

  it('FOLD-1: flag OFF → system field is the base persona prompt, unchanged (prior behavior)', async () => {
    const req = await callBrain(REQ);
    expect(req.system).toBe(SYS);
    expect(req.system).not.toContain('PLAN FOR THIS TASK');
  });

  it('FOLD-2: flag ON → the dropped system content is folded into the system field', async () => {
    process.env['SUDO_FOLD_SYSTEM_MESSAGES'] = '1';
    const req = await callBrain(REQ);
    expect(req.system).toBe(`${SYS}\n\n# PLAN FOR THIS TASK\n1. step one`);
  });

  it('FOLD-3: flag ON + multiple system messages → folded in order', async () => {
    process.env['SUDO_FOLD_SYSTEM_MESSAGES'] = '1';
    const req = await callBrain({ messages: [
      { role: 'system', content: '[SESSION FORK — continued from X]' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'AUTO-ROUTING hint' },
    ] });
    expect(req.system).toBe(`${SYS}\n\n[SESSION FORK — continued from X]\n\nAUTO-ROUTING hint`);
  });

  it('FOLD-4: flag ON but no system messages → system field unchanged', async () => {
    process.env['SUDO_FOLD_SYSTEM_MESSAGES'] = '1';
    const req = await callBrain({ messages: [{ role: 'user', content: 'hi' }] });
    expect(req.system).toBe(SYS);
  });
});

describe('buildFoldedSystemMessages helper', () => {
  it('disabled → []; enabled + system msgs → one uncached system message; none → []', () => {
    const msgs: BrainMessage[] = [{ role: 'system', content: 'X' }, { role: 'user', content: 'hi' }, { role: 'system', content: 'Y' }];
    expect(buildFoldedSystemMessages(msgs, false)).toEqual([]);
    expect(buildFoldedSystemMessages(msgs, true)).toEqual([{ role: 'system', content: 'X\n\nY' }]);
    expect(buildFoldedSystemMessages([{ role: 'user', content: 'hi' }], true)).toEqual([]);
  });
});

// FOLD-5..7 (Anthropic cache-path callParams layout) intentionally removed —
// see the file header. The transport's egress adapters own cache_control now.
