/**
 * @file prompt-cache-callparams.test.ts
 * @description brain.ts-level tests for callParams construction under
 * SUDO_PROMPT_CACHE flag states, the tool-empty-retry no-system invariant,
 * and the system-role message drop warning in toSDKMessages.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    debug: debugSpy,
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}));

import { Brain } from '../../src/core/brain/brain.js';
import { AuthProfileRotation } from '../../src/core/brain/auth-profile-rotation.js';
import { DYNAMIC_BOUNDARY_MARKER } from '../../src/core/brain/prompt-cache-discipline.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

function profile(id: string, provider: string): ModelProfile {
  return {
    id,
    provider,
    modelId: id.slice(id.indexOf('/') + 1),
    priority: 0,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    disabled: false,
  };
}

function okResult(text = 'the answer is 42') {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, inputTokens: 10, outputTokens: 5 },
    finishReason: 'stop' as const,
  };
}

const SYS = `STABLE INSTRUCTIONS\n${DYNAMIC_BOUNDARY_MARKER}\ndynamic tail`;
const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };
const TOOLS = [
  { name: 'zeta_tool', description: 'z', parameters: { type: 'object', properties: {} } },
  { name: 'alpha_tool', description: 'a', parameters: { type: 'object', properties: {} } },
];

async function callBrain(
  p: ModelProfile,
  request: object = REQUEST,
): Promise<Record<string, any>> {
  const brain = new Brain(null);
  await (brain as any).providersReady;
  await (brain as any)._callSingleModel(p, request, SYS, 0.5, 1000);
  return generateTextMock.mock.calls[0]![0];
}

describe('Brain callParams construction under SUDO_PROMPT_CACHE', () => {
  const KEYS = [
    'SUDO_PROMPT_CACHE',
    'SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE',
    'ANTHROPIC_API_KEY',
    'XAI_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Prompt cache is now default-ON; "flag off" cases select the off path
    // explicitly (unsetting no longer disables). On-path tests set '1'.
    process.env['SUDO_PROMPT_CACHE'] = '0';
    AuthProfileRotation.resetInstance();
    generateTextMock.mockReset();
    warnSpy.mockClear();
    debugSpy.mockClear();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    AuthProfileRotation.resetInstance();
  });

  it('CP-1: flag off → system param set, no system-role messages', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    generateTextMock.mockResolvedValueOnce(okResult());

    const params = await callBrain(profile('anthropic/claude-test', 'anthropic'));

    expect(params.system).toBe(SYS);
    expect((params.messages as any[]).every((m) => m.role !== 'system')).toBe(true);
  });

  it('CP-2: flag on + Anthropic → system moves to leading cached messages, no system param', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    generateTextMock.mockResolvedValueOnce(okResult());

    const params = await callBrain(profile('anthropic/claude-test', 'anthropic'));

    expect(params).not.toHaveProperty('system');
    const msgs = params.messages as any[];
    expect(msgs[0]).toEqual({
      role: 'system',
      content: 'STABLE INSTRUCTIONS\n',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(msgs[1]).toEqual({
      role: 'system',
      content: `${DYNAMIC_BOUNDARY_MARKER}\ndynamic tail`,
    });
    expect(msgs[2]).toMatchObject({ role: 'user' });
  });

  it('CP-3: flag on + non-Anthropic → B1 only: system param kept, tools sorted, no breakpoints', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    process.env['XAI_API_KEY'] = 'sk-xai-test';
    generateTextMock.mockResolvedValueOnce(okResult());

    const params = await callBrain(profile('xai/grok-test', 'xai'), { ...REQUEST, tools: TOOLS });

    expect(params.system).toBe(SYS);
    expect((params.messages as any[]).every((m) => m.role !== 'system')).toBe(true);
    expect(Object.keys(params.tools as object)).toEqual(['alpha_tool', 'zeta_tool']);
    for (const tool of Object.values(params.tools as Record<string, any>)) {
      expect(tool.providerOptions).toBeUndefined();
    }
  });

  it('CP-4: flag on + Anthropic + breakpoints kill-switch → B1 only', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    process.env['SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE'] = '1';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    generateTextMock.mockResolvedValueOnce(okResult());

    const params = await callBrain(profile('anthropic/claude-test', 'anthropic'), {
      ...REQUEST,
      tools: TOOLS,
    });

    expect(params.system).toBe(SYS);
    expect((params.messages as any[]).every((m) => m.role !== 'system')).toBe(true);
    expect(Object.keys(params.tools as object)).toEqual(['alpha_tool', 'zeta_tool']);
    for (const tool of Object.values(params.tools as Record<string, any>)) {
      expect(tool.providerOptions).toBeUndefined();
    }
  });

  it('CP-5: flag on + Anthropic → last sorted tool carries the cache breakpoint', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    generateTextMock.mockResolvedValueOnce(okResult());

    const params = await callBrain(profile('anthropic/claude-test', 'anthropic'), {
      ...REQUEST,
      tools: TOOLS,
    });

    const tools = params.tools as Record<string, any>;
    expect(Object.keys(tools)).toEqual(['alpha_tool', 'zeta_tool']);
    expect(tools['alpha_tool'].providerOptions).toBeUndefined();
    expect(tools['zeta_tool'].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('RETRY-1: tool-empty retry with breakpoints on never re-adds a system param', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    generateTextMock
      .mockResolvedValueOnce(okResult('')) // empty with tools → triggers retry
      .mockResolvedValueOnce(okResult());

    await callBrain(profile('anthropic/claude-test', 'anthropic'), { ...REQUEST, tools: TOOLS });

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    const retryParams = generateTextMock.mock.calls[1]![0] as Record<string, any>;
    expect(retryParams).not.toHaveProperty('system');
    expect(retryParams).not.toHaveProperty('tools');
    const msgs = retryParams.messages as any[];
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'STABLE INSTRUCTIONS\n' });
    expect(msgs[1]).toMatchObject({ role: 'system' });
  });

  it('DROP-1: system-role message in request.messages is dropped (logged at debug)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    generateTextMock.mockResolvedValueOnce(okResult());

    const params = await callBrain(profile('anthropic/claude-test', 'anthropic'), {
      messages: [
        { role: 'system' as const, content: 'sneaky system message' },
        { role: 'user' as const, content: 'hi' },
      ],
    });

    expect((params.messages as any[]).every((m) => m.role !== 'system')).toBe(true);
    // Demoted to debug: with system-message folding the drop is handled
    // (no content loss), so it's routine, not a warning.
    const dropLog = debugSpy.mock.calls.find((c) =>
      String(c[1]).includes('routed out of request.messages array'),
    );
    expect(dropLog).toBeDefined();
    expect(dropLog![0]).toEqual({ contentPreview: 'sneaky system message' });
  });
});
