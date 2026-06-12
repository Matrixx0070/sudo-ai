/**
 * @file tests/skills/agentskills-compat.test.ts
 * @description agentskills.io skill-format consumption (gap #12).
 * loadMarkdownSkills discovers <skill>/SKILL.md directories (case-insensitive,
 * depth-capped, flat-file-first dedupe); SkillRegistry.scanBundledSkills
 * matches skill.md case-insensitively; both frontmatter parsers skip nested
 * blocks instead of leaking their keys to the top level.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadMarkdownSkills } from '../../src/core/skills/markdown-loader.js';
import { SkillRegistry } from '../../src/core/skills/registry.js';
import { parseFrontmatter } from '../../src/core/skills/registry-types.js';

function skillMd(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: test skill ${name}\n${extra}---\n\nBody of ${name}.\n`;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'agentskills-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadMarkdownSkills — agentskills.io directory layout', () => {
  it('loads flat .md files, <skill>/SKILL.md, and category-nested skill.md', async () => {
    writeFileSync(path.join(root, 'flat.md'), skillMd('flat'));
    mkdirSync(path.join(root, 'dir-skill'));
    writeFileSync(path.join(root, 'dir-skill', 'SKILL.md'), skillMd('dir-skill'));
    mkdirSync(path.join(root, 'category', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'category', 'nested', 'skill.md'), skillMd('nested'));

    const skills = await loadMarkdownSkills(root);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['dir-skill', 'flat', 'nested']);
    expect(skills.find((s) => s.name === 'nested')?.content).toContain('Body of nested');
  });

  it('falls back to the directory name when SKILL.md has no name field', async () => {
    mkdirSync(path.join(root, 'unnamed'));
    writeFileSync(path.join(root, 'unnamed', 'SKILL.md'), 'No frontmatter here, just a body.');
    const skills = await loadMarkdownSkills(root);
    expect(skills.map((s) => s.name)).toEqual(['unnamed']);
  });

  it('prefers a flat file over a directory skill with the same name', async () => {
    writeFileSync(path.join(root, 'dup.md'), skillMd('dup') + 'FLAT-MARKER\n');
    mkdirSync(path.join(root, 'dup'));
    writeFileSync(path.join(root, 'dup', 'SKILL.md'), skillMd('dup') + 'DIR-MARKER\n');

    const skills = await loadMarkdownSkills(root);
    const dups = skills.filter((s) => s.name === 'dup');
    expect(dups).toHaveLength(1);
    expect(dups[0]?.content).toContain('FLAT-MARKER');
  });

  it('does not follow symlinked directories', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'agentskills-outside-'));
    try {
      mkdirSync(path.join(outside, 'escape'));
      writeFileSync(path.join(outside, 'escape', 'SKILL.md'), skillMd('escape'));
      symlinkSync(path.join(outside, 'escape'), path.join(root, 'linked'), 'dir');

      const skills = await loadMarkdownSkills(root);
      expect(skills.find((s) => s.name === 'escape')).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not load symlinked SKILL.md or .md files', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'agentskills-outside-'));
    try {
      writeFileSync(path.join(outside, 'real-skill.md'), skillMd('linked-flat'));
      writeFileSync(path.join(outside, 'real-manifest.md'), skillMd('linked-manifest'));
      symlinkSync(path.join(outside, 'real-skill.md'), path.join(root, 'linked-flat.md'), 'file');
      mkdirSync(path.join(root, 'linked-dir-skill'));
      symlinkSync(
        path.join(outside, 'real-manifest.md'),
        path.join(root, 'linked-dir-skill', 'SKILL.md'),
        'file',
      );

      const skills = await loadMarkdownSkills(root);
      expect(skills.find((s) => s.name === 'linked-flat')).toBeUndefined();
      expect(skills.find((s) => s.name === 'linked-manifest')).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stops descending past the depth cap', async () => {
    const deep = path.join(root, 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'SKILL.md'), skillMd('too-deep'));
    const skills = await loadMarkdownSkills(root);
    expect(skills.find((s) => s.name === 'too-deep')).toBeUndefined();
  });

  it('does not leak nested metadata block keys into top-level frontmatter', async () => {
    mkdirSync(path.join(root, 'meta-skill'));
    writeFileSync(
      path.join(root, 'meta-skill', 'SKILL.md'),
      '---\nname: meta-skill\ndescription: nested test\nmetadata:\n  trust_tier: workspace\n  hermes: something\n---\n\nBody.\n',
    );
    const skills = await loadMarkdownSkills(root);
    const skill = skills.find((s) => s.name === 'meta-skill');
    expect(skill).toBeDefined();
    // The nested trust_tier must NOT surface as the skill's trust tier.
    expect(skill?.trust_tier).toBeUndefined();
  });
});

describe('SkillRegistry.scanBundledSkills — case-insensitive SKILL.md', () => {
  it('registers lowercase skill.md directory skills', () => {
    mkdirSync(path.join(root, 'lower'));
    writeFileSync(path.join(root, 'lower', 'skill.md'), skillMd('lower'));
    mkdirSync(path.join(root, 'upper'));
    writeFileSync(path.join(root, 'upper', 'SKILL.md'), skillMd('upper'));

    const db = new Database(':memory:');
    try {
      const registry = new SkillRegistry(db, path.join(root, 'no-flat-dir'));
      const registered = registry.scanBundledSkills(root);
      expect(registered).toBe(2);
      expect(registry.getSkillMeta('lower')).not.toBeNull();
      expect(registry.getSkillMeta('upper')).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('registers a same-name directory skill as a new version of a flat skill', () => {
    const flatDir = path.join(root, 'flat-skills');
    mkdirSync(flatDir);
    writeFileSync(path.join(flatDir, 'dup.md'), skillMd('dup') + 'FLAT-BODY\n');
    mkdirSync(path.join(root, 'dup'));
    writeFileSync(path.join(root, 'dup', 'SKILL.md'), skillMd('dup') + 'DIR-BODY\n');

    const db = new Database(':memory:');
    try {
      const registry = new SkillRegistry(db, flatDir);
      expect(registry.scanAndRegister()).toBe(1);
      expect(registry.scanBundledSkills(path.join(root, 'dup'))).toBe(1);
      // Versioned-by-design: different sha256 under the same name becomes the
      // latest version, so registry reads serve the directory body while the
      // prompt-path loader keeps the flat file (loader dedupe is flat-wins).
      const meta = registry.getSkillMeta('dup');
      expect(meta?.version).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('registry-types parseFrontmatter — nested block safety', () => {
  it('skips indented continuation lines instead of promoting them to top level', () => {
    const { meta, body } = parseFrontmatter(
      '---\nname: x\nmetadata:\n  trust_tier: workspace\n  tags: [a, b]\n---\nBody text\n',
    );
    expect(meta['name']).toBe('x');
    expect(meta['trust_tier']).toBeUndefined();
    expect(meta['tags']).toBeUndefined();
    expect(body).toContain('Body text');
  });

  it('still parses flat scalar and bracket-array fields', () => {
    const { meta } = parseFrontmatter(
      '---\nname: y\ncaps: [net.fetch, db.read]\nlicense: MIT\n---\nBody\n',
    );
    expect(meta['name']).toBe('y');
    expect(meta['caps']).toEqual(['net.fetch', 'db.read']);
    expect(meta['license']).toBe('MIT');
  });
});
