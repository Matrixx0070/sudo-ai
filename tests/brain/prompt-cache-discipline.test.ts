/**
 * @file prompt-cache-discipline.test.ts
 * @description Tests for SUDO_PROMPT_CACHE stable-prefix discipline.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { writeFile, unlink, mkdir, access } from 'fs/promises';
import path from 'path';
import { PATHS } from '../../src/core/shared/constants.js';
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
  // Prompt cache is now default-ON; the "flag off" cases here select the off
  // path explicitly via '0' (unsetting no longer disables). Tests that need it
  // on override with '1'.
  process.env[FLAG] = '0';
  delete process.env[KILL_SWITCH];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
  if (savedKill === undefined) delete process.env[KILL_SWITCH];
  else process.env[KILL_SWITCH] = savedKill;
});

describe('isPromptCacheEnabled', () => {
  it('is ON by default; only SUDO_PROMPT_CACHE=0 disables', () => {
    delete process.env[FLAG];
    expect(isPromptCacheEnabled()).toBe(true);
    process.env[FLAG] = '1';
    expect(isPromptCacheEnabled()).toBe(true);
    process.env[FLAG] = '0';
    expect(isPromptCacheEnabled()).toBe(false);
  });
});

describe('isCacheBreakpointsEnabled', () => {
  it('follows the master flag (ON by default), off when master is disabled', () => {
    delete process.env[FLAG];
    expect(isCacheBreakpointsEnabled()).toBe(true);
    process.env[FLAG] = '0';
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

  // Workspace files (AGENTS.md / TOOLS.md / MEMORY.md) aren't guaranteed to
  // exist in CI's checkout — they live in workspace/ which is gitignored on
  // some setups. The Tool Capability Manifest, in contrast, is sourced from
  // capability-manifest.ts (compiled source, deterministic). So the manifest
  // is asserted unconditionally, while the workspace-backed sections are
  // asserted only when their content is actually present in the prompt.
  it('flag on: Tool Capability Manifest sits ABOVE the boundary (and workspace blocks when present)', async () => {
    process.env[FLAG] = '1';
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);

    const manifestIdx = prompt.indexOf('Tool Capability Manifest');
    expect(manifestIdx).toBeGreaterThan(-1);
    expect(manifestIdx).toBeLessThan(boundaryIdx);

    for (const marker of ['AGENTS — Agent Manual', 'TOOLS — Environment-Specific Notes', 'Long-Term Memory']) {
      const idx = prompt.indexOf(marker);
      if (idx >= 0) expect(idx).toBeLessThan(boundaryIdx);
    }
  });

  it('flag off: Tool Capability Manifest sits BELOW the boundary (and workspace blocks when present)', async () => {
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);

    const manifestIdx = prompt.indexOf('Tool Capability Manifest');
    expect(manifestIdx).toBeGreaterThan(boundaryIdx);

    for (const marker of ['AGENTS — Agent Manual', 'TOOLS — Environment-Specific Notes', 'Long-Term Memory']) {
      const idx = prompt.indexOf(marker);
      if (idx >= 0) expect(idx).toBeGreaterThan(boundaryIdx);
    }
  });
});

describe('assembleSystemPrompt static rule sections (Phase 3 cache-locality lift)', () => {
  // These sections come from workspace/*.md files that are not guaranteed to
  // exist in a checkout (workspace/ is gitignored). To make the assertions
  // NON-vacuous, sentinel rule files are created for the duration of this
  // block and removed afterwards — but only the ones this block created.
  const sentinelFiles: Record<string, string> = {
    'SAFETY-RULES.md': 'Sentinel safety rule: never rm -rf without confirmation.',
    'CODING.md': 'Sentinel coding rule: prefer const over let.',
  };
  const created: string[] = [];

  beforeAll(async () => {
    await mkdir(PATHS.WORKSPACE, { recursive: true });
    for (const [name, content] of Object.entries(sentinelFiles)) {
      const filePath = path.join(PATHS.WORKSPACE, name);
      try {
        await access(filePath); // pre-existing — leave it alone
      } catch {
        await writeFile(filePath, content, 'utf8');
        created.push(filePath);
      }
    }
  });

  afterAll(async () => {
    for (const filePath of created) {
      try {
        await unlink(filePath);
      } catch {
        /* already gone */
      }
    }
  });

  const HEADERS = ['## Safety Rules', '## Coding Army — Standing Orders'];

  it('flag on: Safety and Coding rule sections sit ABOVE the boundary', async () => {
    process.env[FLAG] = '1';
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);
    for (const header of HEADERS) {
      const idx = prompt.indexOf(header);
      expect(idx, `${header} missing from prompt`).toBeGreaterThan(-1);
      expect(idx, `${header} should be above the boundary`).toBeLessThan(boundaryIdx);
    }
    // Relative order preserved from the legacy layout: Coding before Safety.
    expect(prompt.indexOf('## Coding Army — Standing Orders'))
      .toBeLessThan(prompt.indexOf('## Safety Rules'));
  });

  it('flag off: Safety and Coding rule sections sit BELOW the boundary (legacy position)', async () => {
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);
    for (const header of HEADERS) {
      const idx = prompt.indexOf(header);
      expect(idx, `${header} missing from prompt`).toBeGreaterThan(-1);
      expect(idx, `${header} should be below the boundary`).toBeGreaterThan(boundaryIdx);
    }
    // Legacy relative order: Coding before Safety.
    expect(prompt.indexOf('## Coding Army — Standing Orders'))
      .toBeLessThan(prompt.indexOf('## Safety Rules'));
  });

  it('flag on: prefix is byte-identical across calls WITH lifted rule content and tools present', async () => {
    process.env[FLAG] = '1';
    const opts = { tools: [{ name: 'b.tool', description: 'B' }, { name: 'a.tool', description: 'A' }] };
    const p1 = (await assembleSystemPrompt(opts)).split(BOUNDARY)[0];
    await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary
    const p2 = (await assembleSystemPrompt(opts)).split(BOUNDARY)[0];
    // Sanity: the lifted rule content is actually inside the compared prefix.
    expect(p1).toContain('## Safety Rules');
    expect(p1).toBe(p2);
  });
});
