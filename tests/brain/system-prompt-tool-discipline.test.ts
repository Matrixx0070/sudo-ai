/**
 * @file system-prompt-tool-discipline.test.ts
 * @description The tool-use discipline (exact tool names, valid-JSON args,
 * read-before-edit, read-the-error-hint-and-change-one-thing) is part of the
 * UNIFORM harness — it ships in the always-on tools guidance for EVERY model,
 * with no per-model tiering. This replaces the reverted model-tier approach:
 * the harness is Mythos-grade regardless of which LLM runs.
 */

import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

const TOOLS = [{ name: 'coder.read-file', description: 'read a file' }];

describe('system prompt — uniform tool-use discipline', () => {
  it('includes the discipline in the always-on tools guidance', async () => {
    const prompt = await assembleSystemPrompt({ tools: TOOLS });
    expect(prompt).toContain('Call ONE tool at a time');
    expect(prompt).toContain('Use a tool name EXACTLY as listed');
    expect(prompt).toContain('Tool arguments must be valid JSON');
    expect(prompt).toContain('"How to fix this" hint');
    expect(prompt).toContain('Before editing a file, read it');
  });

  it('is model-agnostic — no per-model tiering remains', async () => {
    const prompt = await assembleSystemPrompt({ tools: TOOLS });
    // The reverted weak-model addendum header must be gone.
    expect(prompt).not.toContain('## Reliable Operation');
  });
});
