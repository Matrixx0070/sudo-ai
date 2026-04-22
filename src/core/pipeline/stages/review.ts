/**
 * Review stage — second LLM pass critiques the DirectorPlan.
 * Returns the plan approved or a revised plan with fixes applied.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import type { PipelineRun, DirectorPlan } from '../types.js';

const log = createLogger('pipeline:review');

const REVIEW_SYSTEM_PROMPT = `You are a senior YouTube Shorts creative director. Review the production plan strictly.
Check: 1) Hook does NOT spoil the twist. 2) Exactly 8 scenes. 3) Scene 8 mirrors scene 1 for loop.
4) Each scene has a unique location. 5) Narration under 25 words per scene. 6) CTA question present.
If all checks pass respond: { "approved": true, "plan": <original plan unchanged> }
If fixes needed respond: { "approved": false, "issues": ["issue 1", ...], "plan": <corrected plan> }
Return ONLY valid JSON.`;

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runReview(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id }, 'Review stage start');

  const apiKey = process.env['XAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError('No LLM API key for review stage', 'pipeline_review_no_key');
  }

  const directionOutput = checkpoint['direction'] as { plan?: DirectorPlan } | undefined;
  const plan = directionOutput?.plan;
  if (!plan) {
    throw new PipelineError(
      'Direction checkpoint missing — cannot review',
      'pipeline_review_no_plan',
    );
  }

  const userMessage = `Review this YouTube Shorts production plan:\n\n${JSON.stringify(plan, null, 2)}`;

  log.debug({ runId: run.id }, 'Calling LLM for plan review');

  let reviewedPlan: DirectorPlan;
  let approved: boolean;
  let issues: string[] = [];

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
        messages: [
          { role: 'system', content: REVIEW_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new PipelineError(
        `Review LLM call failed: ${response.status} ${body.slice(0, 200)}`,
        'pipeline_review_llm_error',
        { status: response.status },
      );
    }

    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const content = json.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(content) as Record<string, unknown>;

    approved = parsed['approved'] === true;
    issues = Array.isArray(parsed['issues']) ? (parsed['issues'] as unknown[]).map(String) : [];

    if (!parsed['plan'] || typeof parsed['plan'] !== 'object') {
      throw new PipelineError('Review response missing plan', 'pipeline_review_invalid');
    }

    // Use the reviewer's plan (may be corrected).
    reviewedPlan = parsed['plan'] as DirectorPlan;
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `Review stage failed: ${String(err)}`,
      'pipeline_review_llm_error',
    );
  }

  if (!approved) {
    log.warn({ runId: run.id, issues }, 'Director plan had issues — reviewer applied corrections');
  } else {
    log.info({ runId: run.id }, 'Director plan approved by reviewer');
  }

  return {
    plan: reviewedPlan,
    approved,
    issues,
    costUsd: 0.005,
  };
}
