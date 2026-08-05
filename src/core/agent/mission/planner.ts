/**
 * @file agent/mission/planner.ts
 * @description Turn a goal into a plan of VERIFIABLE steps.
 *
 * The unit of a plan is not "a thing to do" but "a thing to do plus how we will
 * know it is done". Without the second half a mission can march its cursor
 * forward on vibes — which is precisely the failure mode ("Health Score 0/100",
 * hollow LEARNINGS blocks) this codebase has already been bitten by.
 *
 * The LLM proposes; this module enforces shape. Anything the model returns that
 * lacks a description or a criterion is dropped, and a plan that ends up empty
 * falls back to a single self-describing step so the mission still runs rather
 * than silently doing nothing.
 */

import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';
import type { MissionStep } from './types.js';

const log = createLogger('agent:mission:planner');

/** Minimal brain surface the planner needs (duck-typed, like task-decomposer). */
export interface PlannerBrain {
  call(input: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
  }): Promise<{ content?: string }>;
}

/** Upper bound on plan size — a 3-day goal is not a 200-step Gantt chart. */
const MAX_STEPS = 24;
const MIN_STEPS = 1;

const PLAN_PROMPT = `You are planning a long-running mission that will be executed over MANY separate runs, possibly across days, by an autonomous agent with shell, file, git, browser and web-search tools.

Break the goal into sequential steps. RULES:
- Each step must be completable in ONE focused work session (roughly 10-40 tool calls).
- Each step MUST have a "doneWhen" that is objectively checkable by inspecting the system afterwards: a file exists at a path, a command exits 0, a test count passes, a PR is merged, a URL returns 200. NEVER "looks good", "is improved", "is understood".
- Order matters: earlier steps must not depend on later ones.
- Prefer 4-12 steps. Fewer is fine for a small goal.
- If the goal needs something only the owner can supply (money, credentials, a product decision), make that an EARLY step whose doneWhen names the artifact you need from them.

Return ONLY a JSON array, no prose, no code fence:
[{"description":"...","doneWhen":"..."}]`;

/** Coerce whatever the model returned into clean, shaped steps. */
export function parsePlan(raw: string): MissionStep[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  // Tolerate a fenced block or leading prose: take the outermost [ ... ].
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const steps: MissionStep[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const description = typeof rec['description'] === 'string' ? rec['description'].trim() : '';
    const doneWhen = typeof rec['doneWhen'] === 'string' ? rec['doneWhen'].trim() : '';
    // A step without a checkable criterion is exactly what lets a mission fake
    // progress — drop it rather than inventing one.
    if (!description || !doneWhen) continue;
    steps.push({
      id: `step-${genId()}`,
      description: description.slice(0, 500),
      doneWhen: doneWhen.slice(0, 300),
      status: 'pending',
      attempts: 0,
      artifacts: [],
    });
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

/**
 * Build a plan for `goal`. Never throws: a model failure yields a single
 * fallback step so the mission still advances (and the owner sees it try)
 * instead of sitting in 'planning' forever.
 */
export async function planMission(brain: PlannerBrain, goal: string): Promise<MissionStep[]> {
  try {
    const res = await brain.call({
      messages: [
        { role: 'system', content: PLAN_PROMPT },
        { role: 'user', content: `GOAL: ${goal}` },
      ],
      maxTokens: 2000,
    });
    const steps = parsePlan(res?.content ?? '');
    if (steps.length >= MIN_STEPS) {
      log.info({ steps: steps.length, goal: goal.slice(0, 80) }, 'Mission plan built');
      return steps;
    }
    log.warn({ goal: goal.slice(0, 80) }, 'Planner returned no usable steps — using fallback plan');
  } catch (err) {
    log.warn({ err: String(err), goal: goal.slice(0, 80) }, 'Planner call failed — using fallback plan');
  }
  return [
    {
      id: `step-${genId()}`,
      description: `Work directly toward this goal and report concrete progress: ${goal}`,
      doneWhen: 'A concrete artifact (file, commit, PR, or written report) exists that a reviewer can inspect.',
      status: 'pending',
      attempts: 0,
      artifacts: [],
    },
  ];
}
