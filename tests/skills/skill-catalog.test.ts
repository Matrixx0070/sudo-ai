/**
 * @file skill-catalog.test.ts
 * @description BO6/S3 — the always-visible skill catalog. Locks the invariants
 * the beat-OpenClaw hybrid depends on:
 *  (a) each catalog entry costs ≤30 tokens (name/desc/path/hash, never a body);
 *  (b) the block is byte-stable for a fixed skill set (deterministic sort) and
 *      changes ONLY when a skill's body hash changes (version-marker invalidation);
 *  (d) the deterministic whole-word triggers still fire alongside the catalog
 *      (the fast path is preserved — catalog is the baseline, not a replacement).
 */

import { describe, it, expect } from 'vitest';
import {
  buildSkillCatalog,
  renderSkillCatalog,
  renderCatalogEntry,
  entryTokens,
  skillHash,
  buildAndRenderSkillCatalog,
  MAX_ENTRY_TOKENS,
  type CatalogSkillInput,
} from '../../src/core/skills/skill-catalog.js';
import { selectSkills, type ActivatableSkill } from '../../src/core/skills/skill-activator.js';

const skills: CatalogSkillInput[] = [
  { name: 'tldr', description: 'Summarize a long thread into a few crisp bullet points.', content: '# tldr\nbody one', filePath: `${process.cwd()}/skills/tldr/SKILL.md` },
  { name: 'debug-stacktrace', description: 'Parse a stack trace and locate the failing frame.', content: '# debug\nbody two', filePath: `${process.cwd()}/skills/debug-stacktrace/skill.md` },
  { name: 'email-polish', description: 'Rewrite a draft email to be clearer and warmer while keeping intent.', content: '# email\nbody three', filePath: `${process.cwd()}/skills/email-polish/SKILL.md` },
];

describe('BO6/S3 skill catalog — (a) per-skill token budget', () => {
  it('every rendered catalog entry is ≤30 tokens and carries name/desc/path/hash but NO body', () => {
    const entries = buildSkillCatalog(skills);
    expect(entries.length).toBe(3);
    for (const e of entries) {
      expect(entryTokens(e)).toBeLessThanOrEqual(MAX_ENTRY_TOKENS);
      const line = renderCatalogEntry(e);
      expect(line).toContain(e.name);
      expect(line).toContain(e.hash);
      expect(line).toContain(e.path);
      // Body must never appear in the catalog line.
      expect(line).not.toContain('body one');
      expect(line).not.toContain('body two');
      expect(line).not.toContain('body three');
    }
  });

  it('a pathologically long description is truncated to keep the ≤30-token budget', () => {
    const fat: CatalogSkillInput = {
      name: 'x',
      description: 'lorem ipsum '.repeat(200),
      content: 'b',
      filePath: `${process.cwd()}/skills/x/SKILL.md`,
    };
    const [entry] = buildSkillCatalog([fat]);
    expect(entryTokens(entry!)).toBeLessThanOrEqual(MAX_ENTRY_TOKENS);
    // Identity + marker + path survive the trim.
    const line = renderCatalogEntry(entry!);
    expect(line).toContain(entry!.hash);
    expect(line).toContain(entry!.name);
  });
});

describe('BO6/S3 skill catalog — (b) byte-stability + version invalidation', () => {
  it('is byte-identical across two assemblies of the same skill set (regardless of input order)', () => {
    const a = buildAndRenderSkillCatalog(skills);
    const shuffled = [skills[2]!, skills[0]!, skills[1]!];
    const b = buildAndRenderSkillCatalog(shuffled);
    expect(a).toBe(b);
    // Deterministic sort by name.
    const names = buildSkillCatalog(skills).map((e) => e.name);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
  });

  it('changes ONLY when a skill body changes — a body edit flips exactly that hash', () => {
    const before = buildAndRenderSkillCatalog(skills);
    // Edit ONE skill's body; everything else identical.
    const edited = skills.map((s) => (s.name === 'tldr' ? { ...s, content: '# tldr\nEDITED BODY' } : s));
    const after = buildAndRenderSkillCatalog(edited);
    expect(after).not.toBe(before);
    // Only tldr's hash moved.
    expect(skillHash('# tldr\nbody one')).not.toBe(skillHash('# tldr\nEDITED BODY'));
    expect(skillHash('# debug\nbody two')).toBe(
      buildSkillCatalog(edited).find((e) => e.name === 'debug-stacktrace')!.hash,
    );
  });

  it('same body always hashes the same (pure function of the bytes)', () => {
    expect(skillHash('hello')).toBe(skillHash('hello'));
    expect(skillHash('hello')).not.toBe(skillHash('hell0'));
  });

  it('empty catalog renders nothing; the block is wrapped in <available_skills> tags', () => {
    expect(renderSkillCatalog([])).toBe('');
    const block = buildAndRenderSkillCatalog(skills);
    expect(block.startsWith('<available_skills>')).toBe(true);
    expect(block.trimEnd().endsWith('</available_skills>')).toBe(true);
  });
});

describe('BO6/S3 skill catalog — (d) deterministic triggers still fire (hybrid, not replacement)', () => {
  it('a whole-word trigger match is still selected — the fast path co-exists with the catalog', () => {
    const activatable: ActivatableSkill[] = [
      { name: 'tldr', description: 'summarize', content: '# tldr body', triggers: ['tldr', 'summarize this'] },
      { name: 'other', description: 'nope', content: '# other', triggers: ['unrelated phrase'] },
    ];
    const hits = selectSkills('please tldr this thread', activatable);
    expect(hits.length).toBe(1);
    expect(hits[0]!.skill.name).toBe('tldr');
    expect(hits[0]!.phrase).toBe('tldr');
  });
});
