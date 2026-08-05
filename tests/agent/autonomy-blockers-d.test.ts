/**
 * Blockers #7 + #8 from the 2026-08-05 autonomy audit.
 * #7: hollow "Health Score 0/100" LEARNINGS.md blocks — a header-only learning
 *     block must never be produced; gate blocks must be loud, not silent.
 * #8: repair guidance arrived only AFTER a failed call — learnable lessons now
 *     ride the tool schema at call-construction time.
 */

import { describe, it, expect } from 'vitest';
import { lessonsForTool, REPAIR_LESSONS } from '../../src/core/learning/repair-flywheel.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';

describe('lessonsForTool (blocker #8)', () => {
  it('returns only learnable lessons with guidance for the tool', () => {
    const lessons = lessonsForTool('coder.read-file');
    expect(lessons.length).toBe(1);
    expect(lessons[0]!.id).toBe('readfile-relative-path');
  });
  it('excludes system-bug (non-learnable) lessons', () => {
    expect(REPAIR_LESSONS.some(l => !l.learnable)).toBe(true);
    for (const l of lessonsForTool('coder.read-file')) expect(l.learnable).toBe(true);
  });
});

describe('tool schema carries repair guidance at call-construction (blocker #8)', () => {
  it('appends KNOWN FAILURE TO AVOID to system.exec description', () => {
    const reg = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'system.exec',
      description: 'Run a command.',
      category: 'system',
      parameters: {},
      async execute() { return { success: true, output: '' }; },
    } as ToolDefinition;
    reg.register(tool);
    const schema = reg.getSchemaForLLM().find(s => s.function.name === 'system.exec');
    expect(schema!.function.description).toContain('KNOWN FAILURE TO AVOID');
    expect(schema!.function.description).toContain('read/verify');
  });
  it('leaves tools without lessons untouched', () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'custom.noop',
      description: 'Nothing.',
      category: 'meta',
      parameters: {},
      async execute() { return { success: true, output: '' }; },
    } as ToolDefinition);
    const schema = reg.getSchemaForLLM().find(s => s.function.name === 'custom.noop');
    expect(schema!.function.description).toBe('Nothing.');
  });
});

import { buildNewLearningBlock } from '../../src/core/self-improvement/engine.js';
import type { DetectedPatterns } from '../../src/core/self-improvement/pattern-detector.js';

describe('hollow LEARNINGS blocks (blocker #7)', () => {
  const empty: DetectedPatterns = {
    failingTools: [], unusedTools: [], badFeedbackTypes: [], routingGaps: [],
    cronIssues: [], healthScore: 0, analysedAt: '2026-08-05T00:00:00Z', windowDays: 14,
  };
  it('empty detection + empty analysis produces NO block at all', () => {
    expect(buildNewLearningBlock(empty, '')).toBe('');
  });
  it('a block with real content is still produced', () => {
    const withContent = { ...empty, healthScore: 82, failingTools: [{ name: 'x', failRate: 0.5, failures: 5, calls: 10 }] };
    const block = buildNewLearningBlock(withContent as DetectedPatterns, '');
    expect(block).toContain('Failing Tools');
    expect(block).toContain('82/100');
  });
});
