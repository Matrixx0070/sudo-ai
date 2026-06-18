/**
 * @file prompt-cache-discipline.test.ts
 * @description Tests for SUDO_PROMPT_CACHE stable-prefix discipline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isPromptCacheEnabled,
  isCacheBreakpointsEnabled,
  isAnthropicModelId,
  buildCachedSystemMessages,
  markLastToolForCache,
  sortToolEntries,
  sortByName,
  DYNAMIC_BOUNDARY_MARKER,
} from '../../src/core/brain/prompt-cache-discipline.js';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

const FLAG = 'SUDO_PROMPT_CACHE';
const KILL_SWITCH = 'SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE';
const BOUNDARY = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';

let saved: string | undefined;
let savedKill: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  savedKill = process.env[KILL_SWITCH];
  delete process.env[FLAG];
  delete process.env[KILL_SWITCH];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
  if (savedKill === undefined) delete process.env[KILL_SWITCH];
  else process.env[KILL_SWITCH] = savedKill;
});

describe('isPromptCacheEnabled', () => {
  it('is off by default and requires exact "1"', () => {
    expect(isPromptCacheEnabled()).toBe(false);
    process.env[FLAG] = 'true';
    expect(isPromptCacheEnabled()).toBe(false);
    process.env[FLAG] = '1';
    expect(isPromptCacheEnabled()).toBe(true);
  });
});

describe('isCacheBreakpointsEnabled', () => {
  it('requires the master flag', () => {
    expect(isCacheBreakpointsEnabled()).toBe(false);
    process.env[FLAG] = '1';
    expect(isCacheBreakpointsEnabled()).toBe(true);
  });

  it('kill-switch disables breakpoints while the master flag stays on', () => {
    process.env[FLAG] = '1';
    process.env[KILL_SWITCH] = '1';
    expect(isCacheBreakpointsEnabled()).toBe(false);
    expect(isPromptCacheEnabled()).toBe(true);
  });
});

describe('isAnthropicModelId', () => {
  it('matches the anthropic/ provider prefix', () => {
    expect(isAnthropicModelId('anthropic/claude-sonnet-4-5')).toBe(true);
    expect(isAnthropicModelId('xai/grok-3-fast')).toBe(false);
    expect(isAnthropicModelId('ollama/anthropic-style')).toBe(false);
  });

  it('also matches the claude-oauth/ subscription prefix', () => {
    // Without this, subscription users pay full price on every call because
    // cache_control breakpoints silently never attach (gated on this fn).
    expect(isAnthropicModelId('claude-oauth/claude-opus-4-8')).toBe(true);
    expect(isAnthropicModelId('claude-oauth/claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicModelId('claude-oauth/claude-fable-5')).toBe(true);
  });

  it('does not match unrelated providers that happen to mention claude', () => {
    expect(isAnthropicModelId('ollama/claude-mimic')).toBe(false);
    expect(isAnthropicModelId('openai/gpt-4-claude-style')).toBe(false);
  });
});

describe('buildCachedSystemMessages', () => {
  const exported = DYNAMIC_BOUNDARY_MARKER;

  it('exported marker matches the literal used by the system prompt', () => {
    expect(exported).toBe(BOUNDARY);
  });

  it('splits at the boundary: stable part gets the breakpoint, dynamic part does not', () => {
    const prompt = `STABLE PART\n${BOUNDARY}\nDYNAMIC PART`;
    const msgs = buildCachedSystemMessages(prompt);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      role: 'system',
      content: 'STABLE PART\n',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(msgs[1]).toEqual({ role: 'system', content: `${BOUNDARY}\nDYNAMIC PART` });
    expect(msgs[0]!.content + msgs[1]!.content).toBe(prompt);
  });

  it('no boundary → single uncached system message', () => {
    const msgs = buildCachedSystemMessages('plain prompt');
    expect(msgs).toEqual([{ role: 'system', content: 'plain prompt' }]);
  });

  it('boundary at position 0 (nothing stable) → single uncached system message', () => {
    const prompt = `${BOUNDARY}\nall dynamic`;
    expect(buildCachedSystemMessages(prompt)).toEqual([{ role: 'system', content: prompt }]);
  });
});

describe('markLastToolForCache', () => {
  it('marks only the last entry and preserves tool fields', () => {
    const entries: Array<[string, { description: string }]> = [
      ['alpha', { description: 'a' }],
      ['zeta', { description: 'z' }],
    ];
    const marked = markLastToolForCache(entries);
    expect(marked[0]![1]).not.toHaveProperty('providerOptions');
    expect(marked[1]![1]).toMatchObject({
      description: 'z',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('does not mutate the input entries or tool objects', () => {
    const tool = { description: 'z' };
    const entries: Array<[string, typeof tool]> = [['zeta', tool]];
    markLastToolForCache(entries);
    expect(tool).not.toHaveProperty('providerOptions');
    expect(entries[0]![1]).toBe(tool);
  });

  it('empty entries pass through unchanged', () => {
    const empty: Array<[string, unknown]> = [];
    expect(markLastToolForCache(empty)).toBe(empty);
  });
});

describe('sortToolEntries', () => {
  const entries: Array<[string, number]> = [['zeta', 1], ['alpha', 2], ['mid', 3]];

  it('preserves arrival order when flag is off (identity, no copy)', () => {
    expect(sortToolEntries(entries)).toBe(entries);
  });

  it('sorts by name when flag is on, without mutating the input', () => {
    process.env[FLAG] = '1';
    const sorted = sortToolEntries(entries);
    expect(sorted.map(([n]) => n)).toEqual(['alpha', 'mid', 'zeta']);
    expect(entries.map(([n]) => n)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('uses code-unit order (locale-independent)', () => {
    process.env[FLAG] = '1';
    const sorted = sortToolEntries([['b', 0], ['B', 0], ['a', 0], ['A', 0]] as Array<[string, number]>);
    // Uppercase code units sort before lowercase
    expect(sorted.map(([n]) => n)).toEqual(['A', 'B', 'a', 'b']);
  });
});

describe('sortByName', () => {
  const tools = [{ name: 'shell.exec' }, { name: 'browser.click' }, { name: 'fs.read' }];

  it('preserves order when flag is off', () => {
    expect(sortByName(tools, (t) => t.name)).toBe(tools);
  });

  it('sorts when flag is on', () => {
    process.env[FLAG] = '1';
    expect(sortByName(tools, (t) => t.name).map((t) => t.name))
      .toEqual(['browser.click', 'fs.read', 'shell.exec']);
  });
});

describe('assembleSystemPrompt prefix stability', () => {
  it('flag off: timestamp block sits ABOVE the cache boundary (legacy layout)', async () => {
    const prompt = await assembleSystemPrompt({});
    const tsIdx = prompt.indexOf('Current Date & Time');
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(tsIdx).toBeGreaterThan(-1);
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(tsIdx).toBeLessThan(boundaryIdx);
  });

  it('flag on: timestamp block moves BELOW the cache boundary', async () => {
    process.env[FLAG] = '1';
    const prompt = await assembleSystemPrompt({});
    const tsIdx = prompt.indexOf('Current Date & Time');
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(tsIdx).toBeGreaterThan(-1);
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(tsIdx).toBeGreaterThan(boundaryIdx);
  });

  it('flag on: prefix above the boundary is byte-identical across calls', async () => {
    process.env[FLAG] = '1';
    const opts = { tools: [{ name: 'b.tool', description: 'B' }, { name: 'a.tool', description: 'A' }] };
    const p1 = (await assembleSystemPrompt(opts)).split(BOUNDARY)[0];
    await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary
    const p2 = (await assembleSystemPrompt(opts)).split(BOUNDARY)[0];
    expect(p1).toBe(p2);
  });

  it('flag on: tools list is rendered in sorted order', async () => {
    process.env[FLAG] = '1';
    const prompt = await assembleSystemPrompt({
      tools: [{ name: 'zz.last', description: 'z' }, { name: 'aa.first', description: 'a' }],
    });
    expect(prompt.indexOf('- **aa.first**')).toBeLessThan(prompt.indexOf('- **zz.last**'));
  });

  it('flag off: tools list keeps arrival order', async () => {
    const prompt = await assembleSystemPrompt({
      tools: [{ name: 'zz.last', description: 'z' }, { name: 'aa.first', description: 'a' }],
    });
    expect(prompt.indexOf('- **zz.last**')).toBeLessThan(prompt.indexOf('- **aa.first**'));
  });

  it('flag on: AGENTS.md, TOOLS.md, Tool Capability Manifest, Long-Term Memory all sit ABOVE the boundary', async () => {
    process.env[FLAG] = '1';
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);

    const agentsIdx = prompt.indexOf('AGENTS — Agent Manual');
    const toolsIdx = prompt.indexOf('TOOLS — Environment-Specific Notes');
    const manifestIdx = prompt.indexOf('Tool Capability Manifest');
    const memoryIdx = prompt.indexOf('Long-Term Memory');

    // Each section must be present AND ordered before the boundary.
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(manifestIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(agentsIdx).toBeLessThan(boundaryIdx);
    expect(toolsIdx).toBeLessThan(boundaryIdx);
    expect(manifestIdx).toBeLessThan(boundaryIdx);
    expect(memoryIdx).toBeLessThan(boundaryIdx);
  });

  it('flag off: AGENTS.md, TOOLS.md, Tool Capability Manifest, Long-Term Memory all sit BELOW the boundary (legacy layout)', async () => {
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);

    const agentsIdx = prompt.indexOf('AGENTS — Agent Manual');
    const toolsIdx = prompt.indexOf('TOOLS — Environment-Specific Notes');
    const manifestIdx = prompt.indexOf('Tool Capability Manifest');
    const memoryIdx = prompt.indexOf('Long-Term Memory');

    expect(agentsIdx).toBeGreaterThan(boundaryIdx);
    expect(toolsIdx).toBeGreaterThan(boundaryIdx);
    expect(manifestIdx).toBeGreaterThan(boundaryIdx);
    expect(memoryIdx).toBeGreaterThan(boundaryIdx);
  });
});
