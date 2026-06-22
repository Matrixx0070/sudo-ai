/**
 * @file system-prompt-pr-discipline.test.ts
 * @description Locks in two training tightenings after a live drill where SUDO
 * opened a PR before running its final scoped test and omitted the concrete
 * end-of-turn report: (1) the OPEN A PR playbook must verify BEFORE opening the
 * PR, and (2) a completed change-cycle must report concrete artifacts (branch,
 * scoped-test command + exit code, PR link). Both live above the cache boundary.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { assembleSystemPrompt } from '../../src/core/brain/system-prompt.js';

const BOUNDARY = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';

afterEach(() => {
  delete process.env['SUDO_PROMPT_CACHE'];
});

describe('system prompt — PR discipline', () => {
  it('verifies with a scoped test BEFORE opening the PR', async () => {
    const prompt = await assembleSystemPrompt({});
    const verifyIdx = prompt.indexOf('VERIFY FIRST — run the scoped test');
    const openPrIdx = prompt.indexOf('open_pr — let CI run');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(openPrIdx).toBeGreaterThan(-1);
    // The verify step must precede the open_pr step in the playbook.
    expect(verifyIdx).toBeLessThan(openPrIdx);
    expect(prompt).toContain('never before');
  });

  it('requires a concrete end-of-turn report (branch, exit code, PR link)', async () => {
    const prompt = await assembleSystemPrompt({});
    expect(prompt).toContain('the scoped-test command and its exit code');
    expect(prompt).toContain('the PR number/link');
    expect(prompt).toContain('is not a complete report');
  });

  it('keeps the PR-discipline guidance above the cache boundary', async () => {
    process.env['SUDO_PROMPT_CACHE'] = '1';
    const prompt = await assembleSystemPrompt({});
    const boundaryIdx = prompt.indexOf(BOUNDARY);
    const verifyIdx = prompt.indexOf('VERIFY FIRST');
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(boundaryIdx);
  });
});
