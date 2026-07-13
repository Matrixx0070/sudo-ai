/**
 * @file sessions-pipeline.ts
 * @description sessions.pipeline (Spec 6) — run a fixed chain of sessions,
 * threading each one's reply into the next (input → step1 → step2 → …). Sugar
 * over the sessions.send delivery path: the orchestrating session drives each
 * step directly (waitForReply), so it's a same-owner, bounded pipeline. Steps
 * are capped; each step is validated + audited.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getSessionManager, getAgentLoop } from './index.js';
import { buildEnvelope, auditSend } from '../../../agents/session-bus.js';

const logger = createLogger('meta.sessions.pipeline');
const MAX_STEPS = 8;
const STEP_TIMEOUT_MS = 120_000;

interface SessionManagerLike { get(sessionId: string): Promise<{ id: string | number } | undefined> }
interface AgentLoopLike {
  run(sessionId: string, message: string, onEvent?: undefined, opts?: { race?: boolean; caller?: { isOwner?: boolean; channel?: string; peerId?: string } }): Promise<{ text: string }>;
}

interface StepResult { sessionId: string; ok: boolean; output: string }

export const sessionsPipelineTool: ToolDefinition = {
  name: 'sessions.pipeline',
  description:
    'Run a multi-agent pipeline: pass `input` through an ordered list of sessions, threading each ' +
    "session's reply into the next (e.g. researcher → writer → editor). Returns the final output plus " +
    'each step. Owner-tier only; steps capped. Each step waits for its reply before the next runs.',
  category: 'meta',
  timeout: 600_000,
  parameters: {
    steps: { type: 'array', required: true, description: 'Ordered session ids to run, e.g. ["sess-research","sess-write"]. Each may also be {sessionId, prompt}.' },
    input: { type: 'string', required: true, description: 'Initial input fed to the first step.' },
    stopOnError: { type: 'boolean', required: false, description: 'Abort the pipeline if a step fails (default true).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.isOwner === false) {
      return { success: false, output: 'sessions.pipeline: refused — only owner-tier sessions may run pipelines.' };
    }
    const rawSteps = Array.isArray(params['steps']) ? params['steps'] : [];
    const input = typeof params['input'] === 'string' ? params['input'] : '';
    const stopOnError = params['stopOnError'] !== false;
    if (rawSteps.length === 0 || !input) {
      return { success: false, output: 'sessions.pipeline: non-empty "steps" and "input" are required.' };
    }
    if (rawSteps.length > MAX_STEPS) {
      return { success: false, output: `sessions.pipeline: too many steps (max ${MAX_STEPS}).` };
    }
    const steps = rawSteps.map((s) => (typeof s === 'string' ? { sessionId: s } : (s as { sessionId?: string; prompt?: string })))
      .filter((s): s is { sessionId: string; prompt?: string } => typeof s?.sessionId === 'string' && s.sessionId.trim().length > 0);
    if (steps.length !== rawSteps.length) {
      return { success: false, output: 'sessions.pipeline: every step must be a sessionId string or {sessionId, prompt}.' };
    }

    const sm = getSessionManager() as SessionManagerLike | null;
    const loop = getAgentLoop() as AgentLoopLike | null;
    if (!sm || !loop) return { success: false, output: 'sessions.pipeline: session manager / agent loop not initialised.' };

    const results: StepResult[] = [];
    let carry = input;
    for (const step of steps) {
      const target = await sm.get(step.sessionId).catch(() => undefined);
      if (!target) {
        results.push({ sessionId: step.sessionId, ok: false, output: 'unknown session' });
        if (stopOnError) break; else continue;
      }
      const body = (step.prompt ? `${step.prompt}\n\n` : '') + carry;
      const envelope = buildEnvelope(ctx.sessionId, ctx.channel, body);
      auditSend({ event: 'pipeline-step', from: ctx.sessionId, target: step.sessionId });
      try {
        const raced = await Promise.race([
          loop.run(step.sessionId, envelope, undefined, { race: true, caller: { isOwner: ctx.isOwner, channel: 'session', peerId: ctx.sessionId } }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('step timeout')), STEP_TIMEOUT_MS)),
        ]);
        carry = raced.text;
        results.push({ sessionId: step.sessionId, ok: true, output: raced.text });
      } catch (err) {
        results.push({ sessionId: step.sessionId, ok: false, output: err instanceof Error ? err.message : String(err) });
        if (stopOnError) break;
      }
    }

    const allOk = results.length === steps.length && results.every((r) => r.ok);
    logger.info({ from: ctx.sessionId, steps: steps.length, ok: allOk }, 'sessions.pipeline complete');
    return {
      success: allOk,
      output: allOk
        ? `Pipeline complete (${steps.length} steps). Final output:\n${carry}`
        : `Pipeline stopped after ${results.length}/${steps.length} step(s). Last: ${results.at(-1)?.output ?? ''}`,
      data: { steps: results, final: carry },
    };
  },
};
