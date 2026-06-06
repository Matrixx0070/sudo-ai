/**
 * @file best-of-n.ts
 * @description Best-of-N Parallel Execution — spawns N sub-agents in isolated
 * worktrees, each independently solving the same task. A dedicated judge prompt
 * evaluates all candidates and selects the best one. Grok Build CLI parity.
 *
 * Grok's approach:
 *   - GROK_BEST_OF_N_CANDIDATES env var (default 3)
 *   - Each candidate runs in its own git worktree
 *   - Judge prompt evaluates: Correctness > Code Quality > Safety
 *   - Winner is merged back to the main branch
 *
 * SUDO-AI implementation uses AgentSwarm + WorktreeManager for isolation.
 */

import { createLogger } from '../shared/logger.js';
import { WorktreeManager } from './worktree-manager.js';
import { AgentSwarm } from './swarm.js';
import type { SpawnOptions } from './swarm.js';
import { genId } from '../shared/utils.js';

const log = createLogger('agent:best-of-n');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default number of parallel candidates. */
export const DEFAULT_N = Number(process.env['SUDO_BEST_OF_N_CANDIDATES']) || 3;

/** Maximum allowed candidates (safety cap). */
export const MAX_N = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JudgeCriteria = 'correctness' | 'code_quality' | 'safety';

export interface CandidateResult {
  /** Candidate index (0-based). */
  index: number;
  /** Worktree branch name. */
  branch: string;
  /** The task prompt given to this candidate. */
  prompt: string;
  /** Final text output from the candidate. */
  output: string;
  /** File changes made by this candidate. */
  filesChanged: string[];
  /** Whether the candidate completed successfully. */
  success: boolean;
  /** Error message if the candidate failed. */
  error?: string;
}

export interface JudgeScore {
  /** Candidate index. */
  candidateIndex: number;
  /** Per-criteria score (0-10). */
  scores: Record<JudgeCriteria, number>;
  /** Weighted total score. */
  totalScore: number;
  /** Judge's reasoning. */
  reasoning: string;
}

export interface BestOfNResult {
  /** Index of the winning candidate. */
  winnerIndex: number;
  /** All candidate results. */
  candidates: CandidateResult[];
  /** All judge scores. */
  scores: JudgeScore[];
  /** The winning candidate's output. */
  winnerOutput: string;
  /** Whether the best-of-N run succeeded. */
  success: boolean;
}

// ---------------------------------------------------------------------------
// Judge prompt (Grok-parity: Correctness > Code Quality > Safety)
// ---------------------------------------------------------------------------

export const JUDGE_SYSTEM_PROMPT = `You are a Best-of-N judge evaluating multiple candidate solutions to the same task.

Evaluate each candidate on three criteria in priority order:
1. CORRECTNESS (weight 50%): Does the solution correctly accomplish the stated task? Are there bugs, logic errors, or missing functionality?
2. CODE QUALITY (weight 30%): Is the code clean, readable, well-structured, and following best practices? Does it have proper error handling and edge cases?
3. SAFETY (weight 20%): Does the solution avoid security vulnerabilities, data loss, or destructive side effects? Is it safe to deploy?

Score each criterion 0-10. Calculate the weighted total.
Select the candidate with the highest total score as the winner.

If all candidates are poor (total < 5), indicate that no candidate is acceptable.

Respond in this JSON format:
{
  "scores": [
    {
      "candidateIndex": 0,
      "scores": { "correctness": 8, "code_quality": 7, "safety": 9 },
      "totalScore": 8.0,
      "reasoning": "..."
    }
  ],
  "winnerIndex": 0,
  "acceptable": true
}`;

// ---------------------------------------------------------------------------
// BestOfNExecutor
// ---------------------------------------------------------------------------

/**
 * Executes Best-of-N parallel candidates and judges the results.
 *
 * Usage:
 * ```ts
 * const executor = new BestOfNExecutor(swarm, worktreeManager, brain);
 * const result = await executor.execute('Fix the login bug', 3);
 * // result.winnerIndex = 1, result.winnerOutput = '...'
 * ```
 */
export class BestOfNExecutor {
  private readonly swarm: AgentSwarm;
  private readonly worktreeManager: WorktreeManager;
  private readonly brain: unknown; // BrainLike — duck-typed
  private readonly judgePrompt: string;

  constructor(
    swarm: AgentSwarm,
    worktreeManager: WorktreeManager,
    brain: unknown,
    judgePrompt?: string,
  ) {
    this.swarm = swarm;
    this.worktreeManager = worktreeManager;
    this.brain = brain;
    this.judgePrompt = judgePrompt ?? JUDGE_SYSTEM_PROMPT;
    log.info('BestOfNExecutor initialised');
  }

  /**
   * Execute Best-of-N: spawn N candidates in parallel, judge, select winner.
   *
   * @param task      - The task description for all candidates.
   * @param n         - Number of candidates (default from env or 3).
   * @param opts      - Optional spawn options override.
   * @returns BestOfNResult with winner and all candidate results.
   */
  async execute(
    task: string,
    n: number = DEFAULT_N,
    opts?: Partial<SpawnOptions>,
  ): Promise<BestOfNResult> {
    const candidateCount = Math.min(Math.max(1, n), MAX_N);
    log.info({ task: task.slice(0, 80), candidateCount }, 'Starting Best-of-N execution');

    // Phase 1: Create worktrees and spawn candidates
    const candidates: CandidateResult[] = [];
    const spawnPromises: Promise<CandidateResult>[] = [];

    for (let i = 0; i < candidateCount; i++) {
      spawnPromises.push(this._spawnCandidate(task, i, opts));
    }

    // Run all candidates in parallel
    const results = await Promise.allSettled(spawnPromises);

    for (let i = 0; i < results.length; i++) {
      const settled = results[i];
      if (settled.status === 'fulfilled') {
        candidates.push(settled.value);
      } else {
        candidates.push({
          index: i,
          branch: '',
          prompt: task,
          output: '',
          filesChanged: [],
          success: false,
          error: settled.reason?.message ?? String(settled.reason),
        });
      }
    }

    log.info(
      { total: candidates.length, succeeded: candidates.filter(c => c.success).length },
      'Best-of-N candidates completed',
    );

    // Phase 2: Judge the candidates
    const scores = await this._judgeCandidates(task, candidates);

    // Phase 3: Select winner
    const validScores = scores.filter(s => s.totalScore > 0);
    let winnerIndex = 0;

    if (validScores.length > 0) {
      validScores.sort((a, b) => b.totalScore - a.totalScore);
      winnerIndex = validScores[0].candidateIndex;
    } else {
      // Fallback: pick the first successful candidate
      const firstSuccess = candidates.find(c => c.success);
      winnerIndex = firstSuccess?.index ?? 0;
    }

    // Guard against a judge returning an out-of-range/NaN candidateIndex.
    // Fall back to the first successful candidate (or 0) rather than pointing
    // at a non-existent candidate and silently discarding the real winner.
    if (
      !Number.isInteger(winnerIndex) ||
      winnerIndex < 0 ||
      winnerIndex >= candidates.length
    ) {
      const firstSuccess = candidates.find(c => c.success);
      winnerIndex = firstSuccess?.index ?? 0;
    }

    const winner = candidates[winnerIndex];

    log.info(
      { winnerIndex, winnerScore: validScores[0]?.totalScore ?? 'N/A', totalCandidates: candidates.length },
      'Best-of-N winner selected',
    );

    return {
      winnerIndex,
      candidates,
      scores,
      winnerOutput: winner?.output ?? '',
      success: winner?.success ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _spawnCandidate(
    task: string,
    index: number,
    opts?: Partial<SpawnOptions>,
  ): Promise<CandidateResult> {
    const branchName = `best-of-n-${index}-${genId().slice(0, 8)}`;

    try {
      // Create a worktree for this candidate
      const worktreeInfo = await this.worktreeManager.createWorktree(`best-of-n-${index}-${genId()}`);

      const spawnOpts: SpawnOptions = {
        ...opts,
        isolationMode: 'worktree',
        timeout: 5 * 60 * 1000, // 5 minutes per candidate
      };

      // Spawn the sub-agent via AgentSwarm
      const agentId = await this.swarm.spawn(task, spawnOpts);

      // Wait for completion (with timeout)
      const result = await this.swarm.waitForCompletion(agentId, spawnOpts.timeout);

      // Collect file changes
      const filesChanged = await this._getFilesChanged(worktreeInfo.path);

      // Clean up worktree
      try {
        await this.worktreeManager.removeWorktree(worktreeInfo.sessionId);
      } catch (err) {
        log.warn({ err: String(err) }, 'Failed to clean up candidate worktree');
      }

      return {
        index,
        branch: worktreeInfo.branch,
        prompt: task,
        output: result?.text ?? '',
        filesChanged,
        success: true,
      };
    } catch (err) {
      log.error({ index, err: String(err) }, 'Candidate failed');
      return {
        index,
        branch: branchName,
        prompt: task,
        output: '',
        filesChanged: [],
        success: false,
        error: String(err),
      };
    }
  }

  private async _judgeCandidates(
    task: string,
    candidates: CandidateResult[],
  ): Promise<JudgeScore[]> {
    const scores: JudgeScore[] = [];

    // Build the judge prompt with all candidate outputs
    const candidateDescriptions = candidates
      .map((c, i) => `--- Candidate ${i} ---\n${c.success ? c.output : `FAILED: ${c.error}`}\nFiles changed: ${c.filesChanged.join(', ') || 'none'}`)
      .join('\n\n');

    const judgePrompt = `Task: ${task}\n\n${candidateDescriptions}\n\nEvaluate each candidate and select the best one.`;

    try {
      // Use the brain to evaluate candidates via the judge prompt
      const brainLike = this.brain as { call?: (messages: Array<{ role: string; content: string }>, opts?: unknown) => Promise<{ content: string }> };
      if (brainLike.call && typeof brainLike.call === 'function') {
        const response = await brainLike.call(
          [
            { role: 'system', content: this.judgePrompt },
            { role: 'user', content: judgePrompt },
          ],
          { model: 'ollama/deepseek-v4-pro:cloud' },
        );

        // Parse the judge response
        const parsed = this._parseJudgeResponse(response.content, candidates.length);
        return parsed;
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Judge evaluation failed — using fallback scoring');
    }

    // Fallback: simple scoring based on success + output length
    return candidates.map((c, i) => ({
      candidateIndex: i,
      scores: {
        correctness: c.success ? 6 : 0,
        code_quality: c.success ? 5 : 0,
        safety: c.success ? 5 : 0,
      },
      totalScore: c.success ? 5.5 : 0,
      reasoning: c.success ? 'Candidate completed successfully (fallback scoring)' : 'Candidate failed',
    }));
  }

  private _parseJudgeResponse(content: string, candidateCount: number): JudgeScore[] {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in judge response');

      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.scores)) {
        return parsed.scores.map((s: Record<string, unknown>) => ({
          candidateIndex: Number(s.candidateIndex ?? 0),
          scores: {
            correctness: Number(s.scores?.correctness ?? 0),
            code_quality: Number(s.scores?.code_quality ?? 0),
            safety: Number(s.scores?.safety ?? 0),
          },
          totalScore: Number(s.totalScore ?? 0),
          reasoning: String(s.reasoning ?? ''),
        }));
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to parse judge response');
    }

    // Fallback: equal scores for all
    return Array.from({ length: candidateCount }, (_, i) => ({
      candidateIndex: i,
      scores: { correctness: 5, code_quality: 5, safety: 5 },
      totalScore: 5,
      reasoning: 'Judge response could not be parsed — equal scores assigned',
    }));
  }

  private async _getFilesChanged(worktreePath: string): Promise<string[]> {
    try {
      const { execSync } = await import('node:child_process');
      const output = execSync('git diff --name-only HEAD', {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return output ? output.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }
}