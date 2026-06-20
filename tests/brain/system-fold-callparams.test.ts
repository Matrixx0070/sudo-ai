/**
 * @file system-fold-callparams.test.ts
 * @description SUDO_FOLD_SYSTEM_MESSAGES — fold dropped role:'system' messages
 * into the `system` param so in-loop guidance (auto-plan PLAN, compaction /
 * session-fork summaries, safety warnings) actually reaches the model instead of
 * being silently dropped by toSDKMessages. Asserts at the brain callParams level
 * (the system param the SDK receives), plus the pure helpers. Default-OFF is
 * byte-identical to prior behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});

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
} from '../../src/core/brain/brain.js';
import { AuthProfileRotation } from '../../src/core/brain/auth-profile-rotation.js';
import type { ModelProfile, BrainMessage } from '../../src/core/brain/types.js';

function profile(id: string, provider: string): ModelProfile {
  return {
    id, provider, modelId: id.slice(id.indexOf('/') + 1),
    priority: 0, lastUsed: 0, cooldownUntil: 0, consecutiveErrors: 0, disabled: false,
  };
}

function okResult(text = 'ok') {
  return {
    text, toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, inputTokens: 10, outputTokens: 5 },
    finishReason: 'stop' as const,
  };
}

const SYS = 'BASE PERSONA PROMPT';

/** Non-cache path (no SUDO_PROMPT_CACHE) → callParams.system is set verbatim. */
async function callBrain(request: object): Promise<Record<string, any>> {
  const brain = new Brain(null);
  await (brain as any).providersReady;
  await (brain as any)._callSingleModel(profile('anthropic/claude-test', 'anthropic'), request, SYS, 0.5, 1000);
  return generateTextMock.mock.calls[0]![0];
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
// Brain callParams wiring
// ---------------------------------------------------------------------------

describe('Brain callParams — system folding', () => {
  const KEYS = ['SUDO_FOLD_SYSTEM_MESSAGES', 'SUDO_PROMPT_CACHE', 'ANTHROPIC_API_KEY'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'; // so getModel resolves; no SUDO_PROMPT_CACHE → non-cache path
    AuthProfileRotation.resetInstance();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue(okResult());
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    AuthProfileRotation.resetInstance();
  });

  const REQ = { messages: [{ role: 'system', content: '# PLAN FOR THIS TASK\n1. step one' }, { role: 'user', content: 'hi' }] };

  it('FOLD-1: flag OFF → system param unchanged, system message dropped from array (prior behavior)', async () => {
    const params = await callBrain(REQ);
    expect(params.system).toBe(SYS);
    expect(params.system).not.toContain('PLAN FOR THIS TASK');
    expect((params.messages as any[]).every((m) => m.role !== 'system')).toBe(true);
    expect((params.messages as any[]).some((m) => m.role === 'user')).toBe(true);
  });

  it('FOLD-2: flag ON → the dropped system content is folded into the system param', async () => {
    process.env['SUDO_FOLD_SYSTEM_MESSAGES'] = '1';
    const params = await callBrain(REQ);
    expect(params.system).toBe(`${SYS}\n\n# PLAN FOR THIS TASK\n1. step one`);
    // Still removed from the messages array (avoids SDK schema error) — delivered ONCE, via system.
    expect((params.messages as any[]).every((m) => m.role !== 'system')).toBe(true);
  });

  it('FOLD-3: flag ON + multiple system messages → folded in order', async () => {
    process.env['SUDO_FOLD_SYSTEM_MESSAGES'] = '1';
    const params = await callBrain({ messages: [
      { role: 'system', content: '[SESSION FORK — continued from X]' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'AUTO-ROUTING hint' },
    ] });
    expect(params.system).toBe(`${SYS}\n\n[SESSION FORK — continued from X]\n\nAUTO-ROUTING hint`);
  });

  it('FOLD-4: flag ON but no system messages → system param unchanged', async () => {
    process.env['SUDO_FOLD_SYSTEM_MESSAGES'] = '1';
    const params = await callBrain({ messages: [{ role: 'user', content: 'hi' }] });
    expect(params.system).toBe(SYS);
  });
});
