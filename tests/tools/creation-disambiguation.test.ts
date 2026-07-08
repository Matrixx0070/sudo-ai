/**
 * @file tests/tools/creation-disambiguation.test.ts
 * @description Description-level contract for the skill-vs-tool creation split.
 *
 * A live user asked "build yourself a new skill called email-polish ... actually
 * save it" (a behavioral SKILL.md request) and the model picked meta.skill-creator
 * (executable code-tool generator) instead of skill.apply, because both
 * descriptions claimed the word "skill". Tool descriptions are the routing
 * signal the model uses — these tests pin the disambiguating language so a
 * future description edit cannot silently re-blur the split:
 *   - skill.apply OWNS "build/create/author a skill" → behavioral SKILL.md
 *   - meta.skill-creator / meta.tool-creator / meta.hot-deploy are for
 *     executable CODE tools and must point behavioral requests at skill.apply.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { applyTool } from '../../src/core/tools/builtin/skill/tools/apply.js';
import { skillCreatorTool } from '../../src/core/tools/builtin/meta/index.js';
import { toolCreatorTool } from '../../src/core/tools/builtin/meta/tool-creator.js';
import { hotDeployTool } from '../../src/core/tools/builtin/meta/hot-deploy.js';

describe('skill.apply — owns behavioral skill authoring', () => {
  it('claims "build/create/author a skill" for behavioral SKILL.md', () => {
    const d = applyTool.description;
    expect(d).toContain('SKILL.md');
    expect(d).toMatch(/behavioral/i);
    expect(d).toMatch(/build\/create\/author\s+.?a skill/i);
  });

  it('keeps gate/dryRun/restart semantics accurate', () => {
    const d = applyTool.description;
    expect(d).toMatch(/dryRun=true \(default\)/);
    expect(d).toMatch(/security gate/i);
    expect(d).toContain('SUDO_SKILL_WORKSHOP=1');
    expect(d).toMatch(/next\s+restart/i);
  });

  it('points executable-code requests at meta.tool-creator', () => {
    expect(applyTool.description).toContain('meta.tool-creator');
  });
});

describe('meta.skill-creator — executable code tool, defers behavioral skills', () => {
  it('leads with executable TOOL (code), not behavioral skill', () => {
    const d = skillCreatorTool.description;
    expect(d).toMatch(/^Create a new executable TOOL \(code\)/);
    expect(d).toContain('ToolDefinition');
  });

  it('no longer sells itself as the behavioral-skill path', () => {
    const d = skillCreatorTool.description;
    // Old description opened with "Create a new SUDO-AI tool/skill ..."
    expect(d).not.toMatch(/tool\/skill/i);
    expect(d).toMatch(/not behavioral guidance/i);
  });

  it('explicitly steers behavioral SKILL requests to skill.apply', () => {
    const d = skillCreatorTool.description;
    expect(d).toContain('skill.apply');
    expect(d).toMatch(/behavioral SKILL/);
    expect(d).toMatch(/NOT this tool/);
  });
});

describe('meta.tool-creator — executable code tool, cross-references skill.apply', () => {
  it('describes itself as an executable code TOOL creator', () => {
    expect(toolCreatorTool.description).toMatch(/executable code TOOL/i);
  });

  it('steers behavioral SKILL.md authoring to skill.apply', () => {
    const d = toolCreatorTool.description;
    expect(d).toContain('skill.apply');
    expect(d).toContain('SKILL.md');
  });
});

describe('meta.hot-deploy — code tool deploy, cross-references skill.apply', () => {
  it('describes compiling a code TOOL and steers SKILL.md to skill.apply', () => {
    const d = hotDeployTool.description;
    expect(d).toMatch(/TypeScript code TOOL/);
    expect(d).toContain('skill.apply');
  });
});
