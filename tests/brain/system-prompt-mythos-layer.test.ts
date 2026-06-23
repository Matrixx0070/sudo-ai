/**
 * @file system-prompt-mythos-layer.test.ts
 * @description Locks in the Mythos Behavioral Layer — the model-agnostic
 * behavioral-quality block that lifts ANY backing model (opus/sonnet/kimi/glm/
 * grok/ollama) toward top-tier behavior. It closes three gaps the Fable-5
 * behavioral standard exposed: memory is applied silently (no retrieval
 * narration), the agent stays current (search before answering time-sensitive
 * questions), and replies are calibrated (prose-first, no bullets when
 * declining). The block lives above the cache boundary and is on by default,
 * with a SUDO_MYTHOS_LAYER=0 kill-switch.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

const BOUNDARY = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';

afterEach(() => {
  delete process.env['SUDO_PROMPT_CACHE'];
  delete process.env['SUDO_MYTHOS_LAYER'];
});

describe('system prompt — Mythos Behavioral Layer', () => {
  it('includes the layer by default', async () => {
    const prompt = await assembleSystemPrompt({});
    expect(prompt).toContain('## Mythos Behavioral Layer');
  });

  it('enforces memory-application discipline (no retrieval narration)', async () => {
    const prompt = await assembleSystemPrompt({});
    expect(prompt).toContain('APPLYING MEMORY & CONTEXT NATURALLY');
    // The forbidden retrieval-narration phrases must be named as forbidden.
    expect(prompt).toContain('based on your memories/profile/data');
    expect(prompt).toContain('Never narrate retrieval');
    // Selective application by query type (greeting → name only).
    expect(prompt).toContain('a bare greeting gets at most the name');
  });

  it('declares the knowledge boundary and search-first behavior', async () => {
    const prompt = await assembleSystemPrompt({});
    expect(prompt).toContain('STAYING CURRENT (KNOWLEDGE BOUNDARY)');
    expect(prompt).toContain('use your web/search tools BEFORE answering');
    expect(prompt).toContain('do not ask permission first');
  });

  it('requires calibrated, prose-first replies and no bullets when declining', async () => {
    const prompt = await assembleSystemPrompt({});
    expect(prompt).toContain('CALIBRATING THE REPLY');
    expect(prompt).toContain('Default to prose');
    expect(prompt).toContain('not bullet points');
  });

  it('keeps the layer above the cache boundary (stable prefix)', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    const layerIdx = prompt.indexOf('## Mythos Behavioral Layer');
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(layerIdx).toBeGreaterThan(-1);
    expect(layerIdx).toBeLessThan(boundaryIdx);
  });

  it('can be disabled with the SUDO_MYTHOS_LAYER=0 kill-switch', async () => {
    process.env['SUDO_MYTHOS_LAYER'] = '0';
    const prompt = await assembleSystemPrompt({});
    expect(prompt).not.toContain('## Mythos Behavioral Layer');
  });
});
