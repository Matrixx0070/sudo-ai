/**
 * Guards media.grok-image / media.grok-video wiring + safety gates — the paths
 * that return BEFORE any browser/oracle launch (owner gate, disabled flag, empty
 * prompt). The actual generation is grok-web-media's (covered by
 * tests/llm/grok-web-media.test.ts) and is exercised live, never in CI.
 */
import { describe, it, expect } from 'vitest';
import { grokImageTool, grokVideoTool } from '../../../../src/core/tools/builtin/media/grok-tools.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

const base = { sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console };
const owner = { ...base, isOwner: true } as unknown as ToolContext;
const nonOwner = { ...base, isOwner: false } as unknown as ToolContext;

describe('media.grok-image / media.grok-video', () => {
  it('are registered in the media category with a required prompt param', () => {
    expect(grokImageTool.name).toBe('media.grok-image');
    expect(grokVideoTool.name).toBe('media.grok-video');
    for (const t of [grokImageTool, grokVideoTool]) {
      expect(t.category).toBe('media');
      expect(t.parameters['prompt']?.required).toBe(true);
      expect(t.description).toMatch(/free/i);
      expect(t.description).toMatch(/owner-only/i);
    }
  });

  it('deny explicitly non-owner turns before touching the browser', async () => {
    for (const t of [grokImageTool, grokVideoTool]) {
      const r = await t.execute({ prompt: 'a cat' }, nonOwner);
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/owner-only/i);
    }
  });

  it('reject an empty prompt', async () => {
    for (const t of [grokImageTool, grokVideoTool]) {
      expect((await t.execute({ prompt: '' }, owner)).success).toBe(false);
      expect((await t.execute({ prompt: '   ' }, owner)).success).toBe(false);
    }
  });

  it('surface a clear disabled message when SUDO_GROK_WEBSESSION is off (no browser launch)', async () => {
    const prev = process.env['SUDO_GROK_WEBSESSION'];
    delete process.env['SUDO_GROK_WEBSESSION'];
    try {
      for (const t of [grokImageTool, grokVideoTool]) {
        const r = await t.execute({ prompt: 'a cat' }, owner);
        expect(r.success).toBe(false);
        expect(r.output).toMatch(/SUDO_GROK_WEBSESSION/);
      }
    } finally {
      if (prev !== undefined) process.env['SUDO_GROK_WEBSESSION'] = prev;
    }
  });
});
