/**
 * @file system-prompt-adaptive-amplify.test.ts
 * @description Locks in the adaptive-amplification wiring in assembleSystemPrompt:
 * a 'weak' backing model gets an explicit "Operating Mode" addendum; frontier,
 * strong, and unspecified models get nothing extra. The addendum is
 * model-dependent so it must sit BELOW the cache boundary. Kill-switch:
 * SUDO_ADAPTIVE_AMPLIFY=0.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

const BOUNDARY = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';
const ADDENDUM_HEADER = '## Reliable Operation';
const ADDENDUM_MARK = 'change exactly ONE thing';

afterEach(() => {
  delete process.env['SUDO_PROMPT_CACHE'];
  delete process.env['SUDO_ADAPTIVE_AMPLIFY'];
  delete process.env['SUDO_MODEL_TIER_OVERRIDE'];
});

describe('system prompt — adaptive amplification (weak-model addendum)', () => {
  it('appends the addendum for a weak model', async () => {
    const prompt = await assembleSystemPrompt({ modelId: 'ollama/llama3.2' });
    expect(prompt).toContain(ADDENDUM_HEADER);
    expect(prompt).toContain(ADDENDUM_MARK);
    expect(prompt).toContain('ONE STEP AT A TIME');
  });

  it('does NOT append it for a frontier model', async () => {
    const prompt = await assembleSystemPrompt({ modelId: 'claude-oauth/opus' });
    expect(prompt).not.toContain(ADDENDUM_HEADER);
  });

  it('does NOT append it for a strong model', async () => {
    const prompt = await assembleSystemPrompt({ modelId: 'anthropic/claude-sonnet-4-6' });
    expect(prompt).not.toContain(ADDENDUM_HEADER);
  });

  it('does NOT append it when no model is specified', async () => {
    const prompt = await assembleSystemPrompt({});
    expect(prompt).not.toContain(ADDENDUM_HEADER);
  });

  it('the kill-switch suppresses it even for a weak model', async () => {
    process.env['SUDO_ADAPTIVE_AMPLIFY'] = '0';
    const prompt = await assembleSystemPrompt({ modelId: 'ollama/llama3.2' });
    expect(prompt).not.toContain(ADDENDUM_HEADER);
  });

  it('the tier override forces the addendum on for any model', async () => {
    process.env['SUDO_MODEL_TIER_OVERRIDE'] = 'weak';
    const prompt = await assembleSystemPrompt({ modelId: 'claude-oauth/opus' });
    expect(prompt).toContain(ADDENDUM_HEADER);
  });

  it('sits BELOW the cache boundary (model-dependent → not cached)', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    const prompt = await assembleSystemPrompt({ modelId: 'ollama/llama3.2' });
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    const addendumIdx = prompt.indexOf(ADDENDUM_HEADER);
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(addendumIdx).toBeGreaterThan(boundaryIdx);
  });
});
