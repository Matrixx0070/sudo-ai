/**
 * Tests for `triggers:` (plural) frontmatter parsing — YAML block lists were
 * previously invisible to the hand-rolled parser (all indented lines skipped),
 * so every registry skill's triggers went unparsed.
 */
import { describe, it, expect } from 'vitest';
import { parseSkillFile } from '../../src/core/skills/markdown-loader.js';

const BLOCK_STYLE = `---
name: eli5
version: 1.0.0
description: Explain simply.
triggers:
  - eli5
  - explain like i am five
  - "explain this simply"
capabilities: []
inputs:
  - name: concept
    required: true
metadata:
  trust_tier: bundled
  name: sneaky-inner-name
---
# ELI5
Body here.
`;

describe('parseSkillFile triggers parsing', () => {
  it('parses block-style YAML trigger lists', () => {
    const s = parseSkillFile(BLOCK_STYLE, '/x/SKILL.md', 'fallback');
    expect(s.name).toBe('eli5');
    expect(s.triggers).toEqual(['eli5', 'explain like i am five', 'explain this simply']);
  });

  it('parses flow-style [a, b] lists', () => {
    const s = parseSkillFile('---\nname: t\ntriggers: [tldr, "tl;dr"]\n---\nbody', '/x', 'f');
    expect(s.triggers).toEqual(['tldr', 'tl;dr']);
  });

  it('keeps legacy singular trigger', () => {
    const s = parseSkillFile('---\nname: t\ntrigger: old phrase\n---\nbody', '/x', 'f');
    expect(s.trigger).toBe('old phrase');
    expect(s.triggers).toBeUndefined();
  });

  it('nested metadata blocks still cannot clobber top-level keys', () => {
    const s = parseSkillFile(BLOCK_STYLE, '/x/SKILL.md', 'fallback');
    expect(s.name).toBe('eli5'); // not sneaky-inner-name
  });

  it('deeper-nested map lines under list items do not leak into triggers', () => {
    const s = parseSkillFile(BLOCK_STYLE, '/x/SKILL.md', 'fallback');
    expect(s.triggers).not.toContain('required: true');
    expect(s.triggers?.every((t) => !t.includes('required'))).toBe(true);
  });

  it('skills without triggers are unchanged', () => {
    const s = parseSkillFile('---\nname: t\ndescription: d\n---\nbody', '/x', 'f');
    expect(s.triggers).toBeUndefined();
    expect(s.description).toBe('d');
  });
});

describe('quote preservation (YAML-first parse)', () => {
  it('no longer corrupts apostrophes and quoted words in descriptions', () => {
    const s = parseSkillFile(`---
name: proof
description: Don't touch the user's data; it's "sacred" — rewrite drafts only.
triggers:
  - polish my boss's email
---
body`, '/x', 'f');
    expect(s.description).toBe(`Don't touch the user's data; it's "sacred" — rewrite drafts only.`);
    expect(s.triggers).toEqual(["polish my boss's email"]);
  });

  it('preserves quotes in flow-style lists', () => {
    const s = parseSkillFile(`---\nname: t\ntriggers: ["boss's email", 'it''s fine']\n---\nbody`, '/x', 'f');
    expect(s.triggers).toEqual(["boss's email", "it's fine"]);
  });

  it('falls back to the legacy parser on strict-YAML-invalid frontmatter', () => {
    const s = parseSkillFile(`---\nname: t\ndescription: ok\nbroken: [unclosed\n---\nbody`, '/x', 'f');
    expect(s.name).toBe('t');
    expect(s.description).toBe('ok');
  });

  it('YAML path still blocks nested-map key leaks', () => {
    const s = parseSkillFile(`---\nname: outer\nmetadata:\n  name: inner\n---\nbody`, '/x', 'f');
    expect(s.name).toBe('outer');
  });

  it('scalar coercion keeps booleans/numbers usable', () => {
    const s = parseSkillFile(`---\nname: t\nversion: 1.0.0\nisReadOnly: true\n---\nbody`, '/x', 'f');
    expect(s.version).toBe('1.0.0');
    expect(s.isReadOnly).toBe(true);
  });
});
