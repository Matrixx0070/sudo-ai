/**
 * @file tests/commands/forge.test.ts
 * @description Theme 1 (learning flywheel, slice 3) — the /forge command scans
 * traces and PROPOSES skills to a review dir; nothing goes live, opt-in gated.
 *
 *   FORGE-1  proposeSkills writes candidate markdown to the proposals dir
 *   FORGE-2  no candidates → a friendly "nothing yet" message, no files
 *   FORGE-3  the command is gated (disabled without SUDO_SKILL_FORGE; needs DATA_DIR)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proposeSkills, forgeCommand, listProposals, acceptProposal, rejectProposal } from '../../src/core/commands/builtin/forge.js';
import type { SkillCandidate } from '../../src/core/learning/skill-forge.js';
import type { CommandContext } from '../../src/core/commands/types.js';

const PROPOSALS = path.join(os.tmpdir(), 'sudo-forge-test-proposals');
const ctx = {} as CommandContext;

function candidate(tools: string[], conf: number): SkillCandidate {
  return {
    pattern: { toolSequence: tools, intentPattern: 'demo', successRate: 0.9, occurrenceCount: 4, avgLatencyMs: 100 },
    generatedSkill: `# ${tools.join(' + ')}\n\nGenerated skill body.`,
    confidence: conf,
  };
}

describe('Theme 1: /forge skill proposals', () => {
  beforeEach(() => { rmSync(PROPOSALS, { recursive: true, force: true }); });
  afterEach(() => { rmSync(PROPOSALS, { recursive: true, force: true }); });

  it('FORGE-1: proposes candidates to the review dir (nothing live)', async () => {
    const forge = { scan: async (): Promise<SkillCandidate[]> => [candidate(['web-search', 'summarize'], 0.85), candidate(['read-file', 'edit-file'], 0.7)] };

    const summary = await proposeSkills(forge, PROPOSALS);

    const files = readdirSync(PROPOSALS).sort();
    expect(files).toEqual(['read-file-edit-file.md', 'web-search-summarize.md']);
    expect(readFileSync(path.join(PROPOSALS, 'web-search-summarize.md'), 'utf8')).toContain('Generated skill body');
    expect(summary).toContain('Proposed 2 skill');
    expect(summary).toContain('NONE are live');
  });

  it('FORGE-2: no candidates → friendly message, no dir created', async () => {
    const forge = { scan: async (): Promise<SkillCandidate[]> => [] };
    const summary = await proposeSkills(forge, PROPOSALS);
    expect(summary).toMatch(/no skill candidates/i);
    expect(existsSync(PROPOSALS)).toBe(false);
  });

  describe('command gating', () => {
    const KEYS = ['SUDO_SKILL_FORGE', 'DATA_DIR'];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
    afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    it('FORGE-3a: disabled without SUDO_SKILL_FORGE=1', async () => {
      const out = await forgeCommand.execute('', ctx);
      expect(out).toMatch(/disabled/i);
    });

    it('FORGE-3b: enabled but DATA_DIR missing → clear message, no crash', async () => {
      process.env['SUDO_SKILL_FORGE'] = '1';
      const out = await forgeCommand.execute('', ctx);
      expect(out).toMatch(/DATA_DIR/);
    });
  });
});

describe('Theme 1: /forge review flow (list / accept / reject)', () => {
  const ROOT = path.join(os.tmpdir(), 'sudo-forge-flow');
  const PROP = path.join(ROOT, 'proposals');
  const LIVE = path.join(ROOT, 'skills');

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(PROP, { recursive: true });
  });
  afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); });

  it('FLOW-list: empty vs populated', () => {
    expect(listProposals(PROP)).toMatch(/no pending/i);
    writeFileSync(path.join(PROP, 'web-search-summarize.md'), '# x', 'utf8');
    expect(listProposals(PROP)).toContain('web-search-summarize');
  });

  it('FLOW-accept: promotes a proposal to the live dir and removes it', () => {
    writeFileSync(path.join(PROP, 'do-thing.md'), '# Do Thing\nbody', 'utf8');
    const out = acceptProposal(PROP, LIVE, 'do-thing');
    expect(out).toMatch(/accepted/i);
    // Now live, no longer pending.
    expect(existsSync(path.join(LIVE, 'do-thing.md'))).toBe(true);
    expect(existsSync(path.join(PROP, 'do-thing.md'))).toBe(false);
    expect(readFileSync(path.join(LIVE, 'do-thing.md'), 'utf8')).toContain('Do Thing');
  });

  it('FLOW-accept: refuses to clobber an existing live skill', () => {
    writeFileSync(path.join(PROP, 'dup.md'), 'new', 'utf8');
    mkdirSync(LIVE, { recursive: true });
    writeFileSync(path.join(LIVE, 'dup.md'), 'ORIGINAL', 'utf8');
    const out = acceptProposal(PROP, LIVE, 'dup');
    expect(out).toMatch(/already exists/i);
    expect(readFileSync(path.join(LIVE, 'dup.md'), 'utf8')).toBe('ORIGINAL'); // untouched
  });

  it('FLOW-accept: missing proposal → friendly message, nothing written', () => {
    const out = acceptProposal(PROP, LIVE, 'nope');
    expect(out).toMatch(/no proposal/i);
    expect(existsSync(LIVE)).toBe(false);
  });

  it('FLOW-security: a path-traversal name cannot escape the dirs', () => {
    // The sanitized name strips path separators → resolves to a non-existent
    // in-dir proposal, never the traversal target.
    const out = acceptProposal(PROP, LIVE, '../../etc/passwd');
    expect(out).toMatch(/no proposal/i);
    expect(existsSync(LIVE)).toBe(false);
  });

  it('FLOW-reject: deletes a proposal', () => {
    writeFileSync(path.join(PROP, 'gone.md'), 'x', 'utf8');
    expect(rejectProposal(PROP, 'gone')).toMatch(/rejected/i);
    expect(existsSync(path.join(PROP, 'gone.md'))).toBe(false);
    expect(rejectProposal(PROP, 'gone')).toMatch(/no proposal/i);
  });
});
