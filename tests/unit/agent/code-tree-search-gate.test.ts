/**
 * @file tests/unit/agent/code-tree-search-gate.test.ts
 * @description Tests for the code-authoring tree-search gate predicate and
 *   verifier composition.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  codeTreeSearchEnabled,
  shouldUseCodeTreeSearch,
  buildCodeTreeSearchVerifier,
} from '../../../src/core/agent/code-tree-search-gate.js';
import type { BrainResponse, BrainRequest } from '../../../src/core/brain/types.js';

const ENV_ON: NodeJS.ProcessEnv = { SUDO_BRAIN_CODE_TREE_SEARCH: '1' };

describe('shouldUseCodeTreeSearch', () => {
  it('flag off → never matches', () => {
    expect(codeTreeSearchEnabled({})).toBe(false);
    expect(shouldUseCodeTreeSearch('write a function that sorts', 0.9, {})).toBe(false);
  });

  it('matches code-authoring text above the complexity floor', () => {
    expect(shouldUseCodeTreeSearch('Write a standalone node script that prints primes', 0.7, ENV_ON)).toBe(true);
    expect(shouldUseCodeTreeSearch('implement an algorithm for interval merging', 0.6, ENV_ON)).toBe(true);
  });

  it('rejects non-code requests and low complexity', () => {
    expect(shouldUseCodeTreeSearch('what time is it in Tokyo?', 0.9, ENV_ON)).toBe(false);
    expect(shouldUseCodeTreeSearch('write a poem about rivers', 0.9, ENV_ON)).toBe(false);
    expect(shouldUseCodeTreeSearch('write a function for parsing', 0.1, ENV_ON)).toBe(false);
  });

  it('honors a custom complexity floor', () => {
    const env = { ...ENV_ON, SUDO_BRAIN_CODE_TS_MIN_COMPLEXITY: '0.9' };
    expect(shouldUseCodeTreeSearch('write a function for parsing', 0.8, env)).toBe(false);
    expect(shouldUseCodeTreeSearch('write a function for parsing', 0.95, env)).toBe(true);
  });
});

describe('buildCodeTreeSearchVerifier', () => {
  function candidate(content: string): BrainResponse {
    return {
      content,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCost: 0 },
      model: 'm',
      finishReason: 'stop',
    };
  }
  const req: BrainRequest = { messages: [{ role: 'user', content: 'write code' }] };

  it('scores 0 on a candidate with no code (shape gate, no sandbox needed)', async () => {
    const verify = buildCodeTreeSearchVerifier();
    const result = await verify(candidate(''), req);
    expect(result.score).toBe(0);
    expect(result.reason).toContain('no code');
  });
});
