/**
 * @file prompt-cache-discipline.test.ts
 * @description Tests for SUDO_PROMPT_CACHE stable-prefix discipline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isPromptCacheEnabled,
  sortToolEntries,
  sortByName,
} from '../../src/core/brain/prompt-cache-discipline.js';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

const FLAG = 'SUDO_PROMPT_CACHE';
const BOUNDARY = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
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
});
