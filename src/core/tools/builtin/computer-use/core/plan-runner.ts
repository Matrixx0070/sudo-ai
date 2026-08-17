/**
 * @file core/plan-runner.ts
 * @description Durable, resumable execution of an {@link ActionPlan}.
 *
 * Long GUI workflows must survive a process restart (the OSWorld-2 lesson:
 * long-horizon state is the frontier). The PlanRunStore persists the plan plus
 * a step cursor to disk after every completed step; PlanRunner resumes from the
 * cursor, so a run that dies at step 37 of 60 continues at 37 — no replay, no
 * lost progress. Durable typed state, refreshed per step.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import type { Action, StepResult } from './types.js';
import type { ActionExecutor } from './executor.js';

const log = createLogger('computer:plan-runner');

export type PlanRunStatus = 'running' | 'done' | 'failed' | 'paused';

export interface PlanRunState {
  runId: string;
  sessionId: string;
  display: string;
  subgoal: string;
  actions: Action[];
  /** Index of the next action to execute (0-based). */
  cursor: number;
  status: PlanRunStatus;
  /** Results of completed steps (length === cursor when consistent). */
  results: StepResult[];
  createdAt: number;
  updatedAt: number;
}

export class PlanRunStore {
  constructor(private readonly baseDir = join(process.cwd(), 'data', 'computer-use', 'runs')) {}

  private pathFor(runId: string): string {
    const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return join(this.baseDir, `${safe}.json`);
  }

  async save(state: PlanRunState): Promise<void> {
    state.updatedAt = Date.now();
    const p = this.pathFor(state.runId);
    await mkdir(dirname(p), { recursive: true });
    // Write via a temp file then rename — never leave a half-written state that
    // a resume would choke on.
    const tmp = `${p}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, p);
  }

  async load(runId: string): Promise<PlanRunState | null> {
    try {
      const raw = await readFile(this.pathFor(runId), 'utf8');
      return JSON.parse(raw) as PlanRunState;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.baseDir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }
}

export interface PlanRunnerDeps {
  store: PlanRunStore;
  /** Build an executor bound to the run's session/display. Called on (re)start. */
  makeExecutor: (state: PlanRunState) => ActionExecutor;
  /** Optional per-step callback (telemetry / viewport nudge). */
  onStep?: (state: PlanRunState, step: StepResult) => void;
}

export interface PlanRunResult {
  runId: string;
  status: PlanRunStatus;
  completed: number;
  total: number;
  lastMessage?: string;
}

export class PlanRunner {
  constructor(private readonly deps: PlanRunnerDeps) {}

  /** Start a brand-new run and drive it to completion (or first failure). */
  async start(seed: Omit<PlanRunState, 'cursor' | 'status' | 'results' | 'createdAt' | 'updatedAt'>): Promise<PlanRunResult> {
    const now = Date.now();
    const state: PlanRunState = { ...seed, cursor: 0, status: 'running', results: [], createdAt: now, updatedAt: now };
    await this.deps.store.save(state);
    return this.drive(state);
  }

  /** Resume a persisted run from its saved cursor (restart survival). */
  async resume(runId: string): Promise<PlanRunResult> {
    const state = await this.deps.store.load(runId);
    if (!state) throw new Error(`plan run ${runId} not found`);
    // Only a completed run is terminal. A 'failed' run is resumable: it retries
    // from the cursor of the step that failed (durable retry, not replay).
    if (state.status === 'done') {
      return { runId, status: 'done', completed: state.cursor, total: state.actions.length };
    }
    state.status = 'running';
    log.info({ runId, cursor: state.cursor, total: state.actions.length }, 'resuming plan run');
    return this.drive(state);
  }

  private async drive(state: PlanRunState): Promise<PlanRunResult> {
    const exec = this.deps.makeExecutor(state);
    while (state.cursor < state.actions.length) {
      const action = state.actions[state.cursor];
      const step = await exec.step(state.subgoal, action);
      state.results.push(step);
      this.deps.onStep?.(state, step);
      if (step.verdict !== 'ok') {
        state.status = 'failed';
        await this.deps.store.save(state);
        return { runId: state.runId, status: 'failed', completed: state.cursor, total: state.actions.length, lastMessage: step.message };
      }
      state.cursor++;
      // Persist AFTER advancing the cursor: a crash now resumes at the next
      // action, never re-running the one just completed.
      await this.deps.store.save(state);
    }
    state.status = 'done';
    await this.deps.store.save(state);
    return { runId: state.runId, status: 'done', completed: state.cursor, total: state.actions.length };
  }
}
