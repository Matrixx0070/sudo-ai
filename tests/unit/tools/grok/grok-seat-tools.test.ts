/**
 * Unit tests for the grok-seat agent tools (meta.grok-models,
 * coder.grok-run-code, knowledge.grok-rag). All assertions exercise paths that
 * return BEFORE any network/browser call — owner gating, input validation, and
 * the flag-OFF disabled paths (the libs refuse before touching the seat) — so
 * CI needs no mocks and never contacts grok.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GROK_SEAT_TOOLS } from '../../../../src/core/tools/builtin/grok/index.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

const models = GROK_SEAT_TOOLS.find((t) => t.name === 'meta.grok-models')!;
const runCode = GROK_SEAT_TOOLS.find((t) => t.name === 'coder.grok-run-code')!;
const rag = GROK_SEAT_TOOLS.find((t) => t.name === 'knowledge.grok-rag')!;

function ctx(isOwner?: boolean): ToolContext {
  return { sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console, isOwner } as unknown as ToolContext;
}

describe('grok-seat tools — shape & categories', () => {
  it('registers exactly the three expected tools with the right categories', () => {
    expect(GROK_SEAT_TOOLS.map((t) => t.name).sort()).toEqual([
      'coder.grok-run-code',
      'knowledge.grok-rag',
      'meta.grok-models',
    ]);
    expect(models.category).toBe('meta');
    expect(runCode.category).toBe('coder');
    expect(rag.category).toBe('knowledge');
  });

  it('declares the required params and python-only enum', () => {
    expect(runCode.parameters['code']?.required).toBe(true);
    expect(runCode.parameters['language']?.enum).toEqual(['python', 'python3', 'py']);
    expect(rag.parameters['question']?.required).toBe(true);
  });

  it('describes each tool as owner-only and free on the seat', () => {
    for (const t of GROK_SEAT_TOOLS) {
      expect(t.description).toMatch(/owner-only/i);
      expect(t.description).toMatch(/free|subscription/i);
    }
  });
});

describe('grok-seat tools — owner gating', () => {
  it('refuses every tool when the turn is explicitly not the owner', async () => {
    for (const t of GROK_SEAT_TOOLS) {
      const res = await t.execute({ code: 'print(1)', question: 'q', text: ['x'] }, ctx(false));
      expect(res.success).toBe(false);
      expect(res.output).toMatch(/owner-only/i);
    }
  });
});

describe('grok-seat tools — input validation (owner)', () => {
  it('run-code rejects empty code', async () => {
    const res = await runCode.execute({ code: '   ' }, ctx(true));
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/code is required/i);
  });

  it('rag rejects a missing question', async () => {
    const res = await rag.execute({ files: ['/tmp/x.txt'] }, ctx(true));
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/question is required/i);
  });

  it('rag rejects when no documents are supplied', async () => {
    const res = await rag.execute({ question: 'what is it?' }, ctx(true));
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/at least one document/i);
  });
});

describe('grok-seat tools — disabled flags refuse before any network', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved['ws'] = process.env['SUDO_GROK_WEBSESSION'];
    saved['sub'] = process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'];
  });
  afterEach(() => {
    if (saved['ws'] === undefined) delete process.env['SUDO_GROK_WEBSESSION'];
    else process.env['SUDO_GROK_WEBSESSION'] = saved['ws'];
    if (saved['sub'] === undefined) delete process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'];
    else process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'] = saved['sub'];
  });

  it('models returns the SUDO_GROK_WEBSESSION hint when the seat is off', async () => {
    delete process.env['SUDO_GROK_WEBSESSION'];
    const res = await models.execute({}, ctx(true));
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/SUDO_GROK_WEBSESSION/);
  });

  it('run-code fails loud (never a metered fallback) when the subscription proxy is off', async () => {
    process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'] = '0';
    const res = await runCode.execute({ code: 'print(1)' }, ctx(true));
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/grok run-code failed/i);
  });
});
