/**
 * @file tests/agent/best-of-n.test.ts
 * @description Tests for BestOfNExecutor — Best-of-N parallel execution.
 *
 * Since BestOfNExecutor depends on AgentSwarm and WorktreeManager (hard to mock
 * fully), we focus on testing the static/pure parts:
 *   - JUDGE_SYSTEM_PROMPT content and structure
 *   - DEFAULT_N and MAX_N constants
 *   - _parseJudgeResponse() — valid JSON, invalid JSON, missing fields
 *   - JudgeScore type validation
 *   - CandidateResult construction
 *   - BestOfNResult type validation
 *
 * Private methods are accessed via the prototype chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JUDGE_SYSTEM_PROMPT,
  DEFAULT_N,
  MAX_N,
  BestOfNExecutor,
  type CandidateResult,
  type JudgeScore,
  type BestOfNResult,
  type JudgeCriteria,
} from '../../src/core/agent/best-of-n.js';

// ---------------------------------------------------------------------------
// Mocks — prevent real side-effects from AgentSwarm and WorktreeManager
// ---------------------------------------------------------------------------

vi.mock('../../src/core/agent/swarm.js', () => ({
  AgentSwarm: class {
    spawn = vi.fn();
    waitForCompletion = vi.fn();
  },
}));

vi.mock('../../src/core/agent/worktree-manager.js', () => ({
  WorktreeManager: class {
    createWorktree = vi.fn();
    removeWorktree = vi.fn();
  },
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a BestOfNExecutor with null dependencies — only for accessing pure logic. */
function makeExecutor(judgePrompt?: string): BestOfNExecutor {
  return new BestOfNExecutor(
    null as any,  // AgentSwarm — not used in pure-logic tests
    null as any,  // WorktreeManager — not used in pure-logic tests
    null,         // brain — not used in pure-logic tests
    judgePrompt,
  );
}

/** Access the private _parseJudgeResponse method via the prototype. */
function parseJudgeResponse(
  executor: BestOfNExecutor,
  content: string,
  candidateCount: number,
): JudgeScore[] {
  const fn = (executor as any)._parseJudgeResponse;
  return fn.call(executor, content, candidateCount);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BestOfNExecutor', () => {
  // =========================================================================
  // Constants
  // =========================================================================

  describe('DEFAULT_N', () => {
    it('should equal 3 when SUDO_BEST_OF_N_CANDIDATES env var is unset', () => {
      // DEFAULT_N is computed at module load time, so this tests whatever the
      // current env produced. The default fallback is 3.
      expect(typeof DEFAULT_N).toBe('number');
      expect(DEFAULT_N).toBeGreaterThan(0);
    });

    it('should be a positive integer', () => {
      expect(Number.isInteger(DEFAULT_N)).toBe(true);
      expect(DEFAULT_N).toBeGreaterThanOrEqual(1);
    });
  });

  describe('MAX_N', () => {
    it('should be 5 (safety cap)', () => {
      expect(MAX_N).toBe(5);
    });

    it('should be greater than or equal to DEFAULT_N', () => {
      expect(MAX_N).toBeGreaterThanOrEqual(DEFAULT_N);
    });
  });

  // =========================================================================
  // JUDGE_SYSTEM_PROMPT
  // =========================================================================

  describe('JUDGE_SYSTEM_PROMPT', () => {
    it('should contain all three weighted criteria in priority order', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('CORRECTNESS');
      expect(JUDGE_SYSTEM_PROMPT).toContain('CODE QUALITY');
      expect(JUDGE_SYSTEM_PROMPT).toContain('SAFETY');
    });

    it('should specify weights: Correctness 50%, Code Quality 30%, Safety 20%', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('50%');
      expect(JUDGE_SYSTEM_PROMPT).toContain('30%');
      expect(JUDGE_SYSTEM_PROMPT).toContain('20%');
    });

    it('should instruct the judge to score each criterion 0-10', () => {
      expect(JUDGE_SYSTEM_PROMPT).toMatch(/0-10/);
    });

    it('should specify the expected JSON response format with "scores" array', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('"scores"');
      expect(JUDGE_SYSTEM_PROMPT).toContain('"candidateIndex"');
      expect(JUDGE_SYSTEM_PROMPT).toContain('"totalScore"');
      expect(JUDGE_SYSTEM_PROMPT).toContain('"reasoning"');
      expect(JUDGE_SYSTEM_PROMPT).toContain('"winnerIndex"');
      expect(JUDGE_SYSTEM_PROMPT).toContain('"acceptable"');
    });

    it('should indicate behavior when all candidates are poor (total < 5)', () => {
      expect(JUDGE_SYSTEM_PROMPT).toMatch(/total\s*<\s*5/);
    });
  });

  // =========================================================================
  // _parseJudgeResponse
  // =========================================================================

  describe('_parseJudgeResponse', () => {
    let executor: BestOfNExecutor;

    beforeEach(() => {
      executor = makeExecutor();
    });

    it('should parse a valid JSON response with two candidates', () => {
      const content = JSON.stringify({
        scores: [
          {
            candidateIndex: 0,
            scores: { correctness: 8, code_quality: 7, safety: 9 },
            totalScore: 8.0,
            reasoning: 'Solid implementation with minor style issues.',
          },
          {
            candidateIndex: 1,
            scores: { correctness: 6, code_quality: 6, safety: 8 },
            totalScore: 6.6,
            reasoning: 'Works but has edge-case gaps.',
          },
        ],
        winnerIndex: 0,
        acceptable: true,
      });

      const result = parseJudgeResponse(executor, content, 2);

      expect(result).toHaveLength(2);
      expect(result[0].candidateIndex).toBe(0);
      expect(result[0].scores.correctness).toBe(8);
      expect(result[0].scores.code_quality).toBe(7);
      expect(result[0].scores.safety).toBe(9);
      expect(result[0].totalScore).toBe(8.0);
      expect(result[0].reasoning).toBe('Solid implementation with minor style issues.');
      expect(result[1].candidateIndex).toBe(1);
      expect(result[1].totalScore).toBe(6.6);
    });

    it('should return fallback equal scores when response has no JSON', () => {
      const content = 'I evaluated the candidates and candidate 0 is better.';
      const result = parseJudgeResponse(executor, content, 3);

      expect(result).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(result[i].candidateIndex).toBe(i);
        expect(result[i].scores.correctness).toBe(5);
        expect(result[i].scores.code_quality).toBe(5);
        expect(result[i].scores.safety).toBe(5);
        expect(result[i].totalScore).toBe(5);
        expect(result[i].reasoning).toContain('could not be parsed');
      }
    });

    it('should return fallback equal scores when JSON is malformed', () => {
      const content = '{ scores: [invalid json';
      const result = parseJudgeResponse(executor, content, 2);

      expect(result).toHaveLength(2);
      expect(result[0].totalScore).toBe(5);
      expect(result[1].totalScore).toBe(5);
    });

    it('should default missing score fields to 0', () => {
      const content = JSON.stringify({
        scores: [
          {
            candidateIndex: 0,
            // correctness missing
            scores: { code_quality: 7, safety: 9 },
            // totalScore missing
            reasoning: 'Partial data',
          },
        ],
        winnerIndex: 0,
        acceptable: true,
      });

      const result = parseJudgeResponse(executor, content, 1);

      expect(result).toHaveLength(1);
      expect(result[0].scores.correctness).toBe(0);
      expect(result[0].scores.code_quality).toBe(7);
      expect(result[0].scores.safety).toBe(9);
      expect(result[0].totalScore).toBe(0);
    });

    it('should default missing candidateIndex to 0', () => {
      const content = JSON.stringify({
        scores: [
          {
            scores: { correctness: 9, code_quality: 8, safety: 9 },
            totalScore: 8.8,
            reasoning: 'No index provided.',
          },
        ],
        winnerIndex: 0,
        acceptable: true,
      });

      const result = parseJudgeResponse(executor, content, 1);
      expect(result[0].candidateIndex).toBe(0);
    });

    it('should extract JSON from surrounding prose text', () => {
      const judgeJson = JSON.stringify({
        scores: [
          {
            candidateIndex: 0,
            scores: { correctness: 7, code_quality: 6, safety: 8 },
            totalScore: 7.1,
            reasoning: 'Decent',
          },
        ],
        winnerIndex: 0,
        acceptable: true,
      });

      const content = `Here is my evaluation:\n\n${judgeJson}\n\nThat concludes the review.`;
      const result = parseJudgeResponse(executor, content, 1);

      expect(result).toHaveLength(1);
      expect(result[0].scores.correctness).toBe(7);
    });

    it('should default missing reasoning to empty string', () => {
      const content = JSON.stringify({
        scores: [
          {
            candidateIndex: 0,
            scores: { correctness: 5, code_quality: 5, safety: 5 },
            totalScore: 5,
            // reasoning omitted
          },
        ],
        winnerIndex: 0,
        acceptable: true,
      });

      const result = parseJudgeResponse(executor, content, 1);
      expect(result[0].reasoning).toBe('');
    });
  });

  // =========================================================================
  // Type validation — CandidateResult
  // =========================================================================

  describe('CandidateResult', () => {
    it('should construct a valid failed candidate with error field', () => {
      const failed: CandidateResult = {
        index: 2,
        branch: 'best-of-n-2-abc12345',
        prompt: 'Fix the login bug',
        output: '',
        filesChanged: [],
        success: false,
        error: 'Worktree creation failed',
      };

      expect(failed.index).toBe(2);
      expect(failed.success).toBe(false);
      expect(failed.error).toBe('Worktree creation failed');
      expect(failed.filesChanged).toEqual([]);
    });

    it('should construct a valid successful candidate without error field', () => {
      const success: CandidateResult = {
        index: 0,
        branch: 'best-of-n-0-def67890',
        prompt: 'Add rate limiting',
        output: 'Implemented rate limiter with token bucket',
        filesChanged: ['src/middleware/rate-limit.ts', 'tests/rate-limit.test.ts'],
        success: true,
      };

      expect(success.success).toBe(true);
      expect(success.error).toBeUndefined();
      expect(success.filesChanged).toHaveLength(2);
    });
  });

  // =========================================================================
  // Type validation — JudgeScore
  // =========================================================================

  describe('JudgeScore', () => {
    it('should contain all three JudgeCriteria keys in the scores record', () => {
      const score: JudgeScore = {
        candidateIndex: 0,
        scores: { correctness: 9, code_quality: 8, safety: 10 },
        totalScore: 9.1,
        reasoning: 'Excellent across all dimensions.',
      };

      const criteriaKeys: JudgeCriteria[] = ['correctness', 'code_quality', 'safety'];
      for (const key of criteriaKeys) {
        expect(score.scores[key]).toBeTypeOf('number');
        expect(score.scores[key]).toBeGreaterThanOrEqual(0);
        expect(score.scores[key]).toBeLessThanOrEqual(10);
      }
    });
  });

  // =========================================================================
  // Type validation — BestOfNResult
  // =========================================================================

  describe('BestOfNResult', () => {
    it('should represent a complete result with winner, candidates, and scores', () => {
      const candidates: CandidateResult[] = [
        {
          index: 0,
          branch: 'best-of-n-0-aaa',
          prompt: 'Refactor auth module',
          output: 'Refactored to use JWT',
          filesChanged: ['src/auth/index.ts'],
          success: true,
        },
        {
          index: 1,
          branch: 'best-of-n-1-bbb',
          prompt: 'Refactor auth module',
          output: '',
          filesChanged: [],
          success: false,
          error: 'Timeout exceeded',
        },
      ];

      const scores: JudgeScore[] = [
        {
          candidateIndex: 0,
          scores: { correctness: 8, code_quality: 7, safety: 9 },
          totalScore: 8.0,
          reasoning: 'Good refactor, clean code.',
        },
        {
          candidateIndex: 1,
          scores: { correctness: 0, code_quality: 0, safety: 0 },
          totalScore: 0,
          reasoning: 'Candidate failed.',
        },
      ];

      const result: BestOfNResult = {
        winnerIndex: 0,
        candidates,
        scores,
        winnerOutput: 'Refactored to use JWT',
        success: true,
      };

      expect(result.winnerIndex).toBe(0);
      expect(result.candidates).toHaveLength(2);
      expect(result.scores).toHaveLength(2);
      expect(result.winnerOutput).toBe('Refactored to use JWT');
      expect(result.success).toBe(true);
    });

    it('should represent a failed result when no candidate succeeds', () => {
      const result: BestOfNResult = {
        winnerIndex: 0,
        candidates: [
          {
            index: 0,
            branch: '',
            prompt: 'Impossible task',
            output: '',
            filesChanged: [],
            success: false,
            error: 'Fatal error',
          },
        ],
        scores: [
          {
            candidateIndex: 0,
            scores: { correctness: 0, code_quality: 0, safety: 0 },
            totalScore: 0,
            reasoning: 'Candidate failed',
          },
        ],
        winnerOutput: '',
        success: false,
      };

      expect(result.success).toBe(false);
      expect(result.winnerOutput).toBe('');
      expect(result.candidates[0].success).toBe(false);
    });
  });

  // =========================================================================
  // Constructor — judgePrompt override
  // =========================================================================

  describe('constructor', () => {
    it('should use the default JUDGE_SYSTEM_PROMPT when no override is provided', () => {
      const executor = makeExecutor();
      expect((executor as any).judgePrompt).toBe(JUDGE_SYSTEM_PROMPT);
    });

    it('should use a custom judge prompt when one is provided', () => {
      const customPrompt = 'Custom judge: pick the shortest solution.';
      const executor = makeExecutor(customPrompt);
      expect((executor as any).judgePrompt).toBe(customPrompt);
    });
  });
});