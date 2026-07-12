/**
 * @file self-eval.ts (meta.self-eval)
 * @description Tool surface for gap #4 — SUDO evaluates a change to its OWN
 * behaviour. Give it a candidate system-prompt directive plus a small task set;
 * it A/Bs directive-vs-baseline, scores pass-rate, and reports keep/revert. With
 * adopt=true AND SUDO_SELF_EVAL_ADOPT=1, a winning directive is persisted into
 * the learned-directives store the system-prompt assembler injects (live next
 * turn, no restart). Without the flag it only measures and recommends — the loop
 * can never silently rewrite SUDO's behaviour.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import {
  runSelfEval, adoptDirective, isSelfEvalAdoptEnabled,
  type SelfEvalBrain, type SelfEvalTask,
} from '../../../eval/self-eval.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.self-eval');

function parseTasks(raw: unknown): SelfEvalTask[] {
  if (!Array.isArray(raw)) return [];
  const out: SelfEvalTask[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const prompt = typeof o['prompt'] === 'string' ? o['prompt'] : '';
    if (!prompt) continue;
    const task: SelfEvalTask = { prompt };
    if (Array.isArray(o['mustInclude'])) task.mustInclude = o['mustInclude'].filter((x): x is string => typeof x === 'string');
    if (typeof o['expect'] === 'string') task.expect = o['expect'];
    out.push(task);
  }
  return out;
}

export const selfEvalTool: ToolDefinition = {
  name: 'meta.self-eval',
  description:
    'Measure a proposed change to your OWN behaviour before keeping it. Give a candidate ' +
    'system-prompt directive and a small task set (each task: prompt + expect/mustInclude ' +
    'pass criteria); this A/B-runs directive-vs-baseline, scores pass-rate on both, and ' +
    'returns a keep/revert/inconclusive verdict with the delta. Set adopt=true to persist a ' +
    'winning directive into your Learned Behaviour Directives (requires SUDO_SELF_EVAL_ADOPT=1; ' +
    'takes effect next turn, no restart). This is how you hypothesise → eval → keep/revert ' +
    'improvements to yourself — it reorganises your instructions from measured outcomes, it does ' +
    'NOT change the underlying model.',
  category: 'meta',
  timeout: 300_000,
  parameters: {
    directive: { type: 'string', required: true, description: 'The candidate behaviour directive (a system-prompt addition) to test.' },
    tasks: {
      type: 'array',
      required: true,
      description: 'Task set. Each item: { prompt: string, expect?: string, mustInclude?: string[] }. Pass = all criteria substrings present (case-insensitive); non-empty fallback if none.',
    },
    adopt: { type: 'boolean', required: false, description: 'If true and verdict=keep, persist the directive (requires SUDO_SELF_EVAL_ADOPT=1).' },
    keepThreshold: { type: 'number', required: false, description: 'Min pass-rate improvement to call it a keep. Default 0.15.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const brain = (ctx.config as { brain?: SelfEvalBrain } | null)?.brain;
    if (!brain || typeof brain.call !== 'function') {
      return { success: false, output: 'meta.self-eval: brain is not available on ctx.config — cannot run evaluations.' };
    }
    const directive = typeof params['directive'] === 'string' ? params['directive'].trim() : '';
    if (!directive) return { success: false, output: 'meta.self-eval: directive is required.' };
    const tasks = parseTasks(params['tasks']);
    if (tasks.length === 0) return { success: false, output: 'meta.self-eval: at least one task with a prompt is required.' };
    const keepThreshold = typeof params['keepThreshold'] === 'number' ? params['keepThreshold'] : undefined;
    const wantAdopt = params['adopt'] === true;

    try {
      logger.info({ session: ctx.sessionId, directive: directive.slice(0, 60), tasks: tasks.length }, 'meta.self-eval invoked');
      const r = await runSelfEval(brain, { directive, tasks, keepThreshold, source: 'self-eval' });

      let adoptNote = '';
      if (wantAdopt) {
        if (r.verdict !== 'keep') {
          adoptNote = `\nAdopt skipped — verdict is "${r.verdict}", not keep.`;
        } else if (!isSelfEvalAdoptEnabled()) {
          adoptNote = '\nAdopt skipped — SUDO_SELF_EVAL_ADOPT=1 is required to persist directives.';
        } else {
          const ok = adoptDirective(directive, `self-eval passΔ=${(r.passDelta * 100).toFixed(0)}pp over ${r.n} tasks`);
          adoptNote = ok
            ? '\nADOPTED — directive is now in Learned Behaviour Directives (active next turn, no restart).'
            : '\nAdopt skipped — duplicate, too long, or write failed.';
        }
      }

      const lines = [
        `Self-eval verdict: ${r.verdict.toUpperCase()} (passΔ ${(r.passDelta * 100).toFixed(0)}pp over ${r.n} tasks)`,
        `  baseline pass-rate:  ${(r.baselinePass * 100).toFixed(0)}%`,
        `  candidate pass-rate: ${(r.candidatePass * 100).toFixed(0)}%`,
        r.scored ? '' : '  (weak signal — no task had explicit pass criteria; used non-empty fallback)',
        adoptNote,
      ].filter(Boolean);

      return { success: true, output: lines.join('\n'), data: { result: r, adopted: adoptNote.includes('ADOPTED') } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ session: ctx.sessionId, err: msg }, 'meta.self-eval failed');
      return { success: false, output: `meta.self-eval failed: ${msg}` };
    }
  },
};
