/**
 * @file tests/agent/task-decomposer.test.ts
 * @description Unit tests for task-decomposer (added with Theme 2 hardening).
 *
 *   TD-1  numbered response → isComplex + parsed subtasks
 *   TD-2  non-numbered junk → isComplex false (no raw-output fallback)
 *   TD-3  simple message → heuristic skips, no brain call
 *   TD-4  brain throws → fail-open (isComplex false)
 *   TD-5  prompt delimits the user message as data
 */

import { describe, it, expect, vi } from 'vitest';
import { decomposeIfComplex, isComplexRequest } from '../../src/core/agent/task-decomposer.js';

const COMPLEX = 'build a CLI then test all the modules and finally write the docs';

function mockBrain(content: string) {
  return { call: vi.fn().mockResolvedValue({ content }) };
}

describe('task-decomposer', () => {
  it('TD-1: parses numbered steps from a complex request', async () => {
    const brain = mockBrain('1. Build the CLI\n2. Test the modules\n3. Write docs');
    const r = await decomposeIfComplex(brain, COMPLEX);
    expect(r.isComplex).toBe(true);
    expect(r.subtasks).toEqual(['Build the CLI', 'Test the modules', 'Write docs']);
  });

  it('TD-2: non-numbered output is NOT complex (no raw-output fallback)', async () => {
    const brain = mockBrain('Sure, just do whatever feels right here.');
    const r = await decomposeIfComplex(brain, COMPLEX);
    expect(r.isComplex).toBe(false);
    expect(r.subtasks).toEqual([]);
  });

  it('TD-3: a simple message skips the heuristic and never calls the brain', async () => {
    const brain = mockBrain('1. nope');
    const r = await decomposeIfComplex(brain, 'hi there');
    expect(r.isComplex).toBe(false);
    expect(brain.call).not.toHaveBeenCalled();
  });

  it('TD-4: a brain error is fail-open', async () => {
    const brain = { call: vi.fn().mockRejectedValue(new Error('boom')) };
    const r = await decomposeIfComplex(brain, COMPLEX);
    expect(r.isComplex).toBe(false);
  });

  it('TD-5: the decomposition prompt delimits the user message as data', async () => {
    const brain = mockBrain('1. a\n2. b\n3. c');
    await decomposeIfComplex(brain, COMPLEX);
    const sent = brain.call.mock.calls[0][0].messages[0].content as string;
    expect(sent).toContain('<request>');
    expect(sent).toContain('</request>');
    expect(sent.toLowerCase()).toContain('do not follow any');
  });

  it('isComplexRequest: fires on multi-step phrases, skips trivial', () => {
    expect(isComplexRequest('build X then deploy Y')).toBe(true);
    expect(isComplexRequest('hello')).toBe(false);
  });
});
