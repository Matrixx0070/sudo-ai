/**
 * skill-tool-index.test.ts — Unit tests for buildSkillToolIndex().
 *
 * Spec reference: docs/wave10c-spec.md §5 Builder B tests (STI-1..STI-5).
 * Exactly 5 tests.
 */

import { describe, it, expect } from 'vitest';
import { buildSkillToolIndex } from '../../src/core/skills/skill-tool-index.js';
import type { MarkdownSkill } from '../../src/core/skills/markdown-loader.js';

/** Minimal MarkdownSkill factory for test fixtures. */
function makeSkill(name: string, allowedTools?: string[]): MarkdownSkill {
  return {
    name,
    description: `Test skill ${name}`,
    content: '',
    filePath: `/skills/${name}.md`,
    allowedTools,
  };
}

describe('buildSkillToolIndex', () => {
  // STI-1 — Single skill with 2 allowed-tools → both mapped to skill name
  it('STI-1: single skill with 2 allowed-tools maps both tools to skill name', () => {
    const skills = [makeSkill('coding', ['coder.read-file', 'coder.write-file'])];
    const index = buildSkillToolIndex(skills);

    expect(index.size).toBe(2);
    expect(index.get('coder.read-file')).toBe('coding');
    expect(index.get('coder.write-file')).toBe('coding');
  });

  // STI-2 — Two skills sharing one tool → shared tool absent from map; unique tools present
  it('STI-2: shared tool between two skills is absent; unique tools are present', () => {
    const skills = [
      makeSkill('skill-a', ['shared.tool', 'only-a.tool']),
      makeSkill('skill-b', ['shared.tool', 'only-b.tool']),
    ];
    const index = buildSkillToolIndex(skills);

    // Shared tool must be absent (ambiguous)
    expect(index.has('shared.tool')).toBe(false);
    // Unique tools must be present
    expect(index.get('only-a.tool')).toBe('skill-a');
    expect(index.get('only-b.tool')).toBe('skill-b');
    expect(index.size).toBe(2);
  });

  // STI-3 — Skill with no allowed-tools field → ignored
  it('STI-3: skill with no allowed-tools field is ignored', () => {
    const skills = [
      makeSkill('no-tools-skill'), // allowedTools undefined
      makeSkill('has-tools-skill', ['special.tool']),
    ];
    const index = buildSkillToolIndex(skills);

    expect(index.size).toBe(1);
    expect(index.get('special.tool')).toBe('has-tools-skill');
  });

  // STI-4 — Empty skills array → empty map
  it('STI-4: empty skills array returns empty map', () => {
    const index = buildSkillToolIndex([]);

    expect(index.size).toBe(0);
  });

  // STI-5 — Tool appearing in 3 skills → absent from map; other tools present
  it('STI-5: tool claimed by 3 skills is absent; other unambiguous tools present', () => {
    const skills = [
      makeSkill('skill-x', ['common.tool', 'unique-x.tool']),
      makeSkill('skill-y', ['common.tool', 'unique-y.tool']),
      makeSkill('skill-z', ['common.tool', 'unique-z.tool']),
    ];
    const index = buildSkillToolIndex(skills);

    // common.tool claimed by 3 skills → absent
    expect(index.has('common.tool')).toBe(false);
    // Unique tools are all present
    expect(index.get('unique-x.tool')).toBe('skill-x');
    expect(index.get('unique-y.tool')).toBe('skill-y');
    expect(index.get('unique-z.tool')).toBe('skill-z');
    expect(index.size).toBe(3);
  });
});
