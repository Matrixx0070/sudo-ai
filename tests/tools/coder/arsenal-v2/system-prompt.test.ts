/**
 * @file system-prompt.test.ts
 * @description Verify mode-prompt routing + the patch-format-instructions
 * boilerplate is on every mutating-mode prompt.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  isMutatingMode,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/system-prompt.js';

describe('isMutatingMode', () => {
  it.each([
    ['fix', true],
    ['build', true],
    ['refactor', true],
    ['test', true],
    ['review', false],
    ['analyze', false],
    ['explain', false],
  ] as const)('%s → %s', (mode, expected) => {
    expect(isMutatingMode(mode)).toBe(expected);
  });
});

describe('buildSystemPrompt — mutating modes carry the PATCH format spec', () => {
  it.each(['fix', 'build', 'refactor', 'test'] as const)('%s prompt includes PATCH format', (mode) => {
    const prompt = buildSystemPrompt(mode);
    expect(prompt).toContain('<<<PATCH>>>');
    expect(prompt).toContain('<<<END>>>');
    expect(prompt).toContain('str_replace');
    expect(prompt).toContain('insert_after');
    expect(prompt).toContain('create_file');
    expect(prompt).toContain('delete_file');
  });
  it('fix prompt mentions root-cause discipline', () => {
    expect(buildSystemPrompt('fix')).toMatch(/root cause/i);
  });
  it('build prompt mentions production-ready discipline', () => {
    expect(buildSystemPrompt('build')).toMatch(/production-ready/i);
  });
  it('refactor prompt explicitly preserves behavior', () => {
    expect(buildSystemPrompt('refactor')).toMatch(/behavior.*preserve|preserve.*behavior/i);
  });
});

describe('buildSystemPrompt — read-only modes explicitly forbid PATCH', () => {
  it.each(['review', 'analyze', 'explain'] as const)('%s prompt forbids PATCH block', (mode) => {
    const prompt = buildSystemPrompt(mode);
    expect(prompt).toMatch(/do NOT emit a PATCH block/i);
  });
  it('review prompt requires file:line citations', () => {
    expect(buildSystemPrompt('review')).toMatch(/file:line/i);
  });
  it('analyze prompt requires the 7 dimensions', () => {
    const p = buildSystemPrompt('analyze');
    for (const dim of ['What it does', 'Architecture', 'Security', 'Performance', 'Code quality']) {
      expect(p).toMatch(new RegExp(dim, 'i'));
    }
  });
});

describe('buildSystemPrompt — rules section', () => {
  it('demands single-line anchors', () => {
    expect(buildSystemPrompt('fix')).toMatch(/SINGLE LINE/);
  });
  it('demands unique anchors / surrounding context', () => {
    expect(buildSystemPrompt('fix')).toMatch(/EXACTLY ONE occurrence|EXACTLY ONCE/);
  });
  it('forbids partial files', () => {
    expect(buildSystemPrompt('fix')).toMatch(/Never output partial files/);
  });
  it('forbids absolute paths and ".." segments', () => {
    expect(buildSystemPrompt('fix')).toMatch(/never absolute, never contains "\.\."|project-relative/i);
  });
});
