/**
 * @file replay.ts
 * @description Deterministic replay for eval-sandbox runs (ADR-0007 Phase 3).
 * Two levels, both fed by the artifacts a run leaves behind (<runDir>/
 * journal.jsonl, scenario.json, workspace/, replay.db):
 *
 * L2 — re-grade from the journal + persisted workspace, WITHOUT any agent
 * turn or LLM call. Change scoring code, re-grade history for free. Judge
 * checks are always skipped (L2 makes no LLM calls). File-based checks
 * (fileExists / fileContains / commandExitZero) depend on the persisted
 * workspace/ — it survives teardown; if it was manually deleted those checks
 * are SKIPPED ('skipped: workspace missing'), never failed.
 *
 * L1 — re-run the agent turn with every LLM response served from the run's
 * preserved replay.db via the transport IR interceptor (setIRInterceptor —
 * the shadow-replay pattern, gw-refactor Phase 7, moved in-process). Tools
 * execute LIVE: that is the point — test harness/tool changes against a
 * fixed model trajectory. Match strategy: SEQUENTIAL per (caller|alias) —
 * simpler than content hashing, and the alias is the pre-resolution model
 * string present identically on the recorded row and the incoming IR (route
 * is just the transport's resolution of the same choice). On exhaustion or an
 * unrecorded key the replay FAILS with a divergence error — replay must NEVER
 * fall through to a live call (no money is ever spent).
 *
 * L1 caveat (documented): the recorded trajectory's tool_use params carry the
 * ORIGINAL run's absolute workspace paths, so live tools act on the original
 * persisted workspace, not the replay run's fresh one.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { parseIRResponse, type IRResponse } from '../../../../shared-types/ir/v1.js';
import { setIRInterceptor } from '../../../llm/ir-interceptor.js';
import { LLMPolicyError } from '../../../llm/errors.js';
import { buildEvalEnv } from './env-scrub.js';
import { grade, type CheckOutcome, type ScoreVector } from './graders.js';
import { readJournal, type JournalEvent } from './run-journal.js';
import { runEval, type EvalRunOptions, type EvalRunReport } from './eval-runner.js';
import { loadScenarioFile, validateScenario, type Scenario, type GradingCheck } from './scenario.js';

const log = createLogger('eval:replay');

// ---------------------------------------------------------------------------
// L1: transport-level IR interceptor fed from replay.db
// ---------------------------------------------------------------------------

interface RecordedRow {
  caller: string;
  alias: string | null;
  ir_response: string;
}

/** Build the (caller|alias) → FIFO response queues from a replay.db ledger. */
export function loadRecordedResponses(replayDbPath: string): Map<string, IRResponse[]> {
  const db = new Database(replayDbPath, { readonly: true, fileMustExist: true });
  let rows: RecordedRow[];
  try {
    // rowid order = insertion order = the order the child made its calls.
    rows = db
      .prepare(`SELECT caller, alias, ir_response FROM llm_calls WHERE ir_response IS NOT NULL ORDER BY rowid`)
      .all() as RecordedRow[];
  } finally {
    db.close();
  }
  const queues = new Map<string, IRResponse[]>();
  for (const row of rows) {
    const key = `${row.caller}|${row.alias ?? ''}`;
    let q = queues.get(key);
    if (q === undefined) {
      q = [];
      queues.set(key, q);
    }
    q.push(parseIRResponse(JSON.parse(row.ir_response)));
  }
  return queues;
}

/**
 * Install the replay interceptor for THIS process. Every callIR is served
 * from the recording; a request with no recorded response left is a hard
 * divergence failure (fail-closed — never a live call).
 */
export function installReplayInterceptor(replayDbPath: string): void {
  const queues = loadRecordedResponses(replayDbPath);
  setIRInterceptor((ir) => {
    const key = `${ir.caller}|${ir.alias}`;
    const q = queues.get(key);
    if (q === undefined || q.length === 0) {
      const remaining = [...queues.entries()]
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => `${k}(${v.length})`)
        .join(', ') || 'none';
      // Non-retryable invalid_request: brain failover fails FAST instead of
      // cooldown-cycling a "transient" error until the wall budget.
      return Promise.reject(new LLMPolicyError(
        `eval replay divergence: no recorded response left for (caller|alias) '${key}' — ` +
        `remaining recordings: ${remaining}. Replay NEVER falls through to a live LLM call; ` +
        `the trajectory has diverged from the recording.`,
        { class: 'invalid_request', retryable: false },
      ));
    }
    return Promise.resolve(q.shift()!);
  });
}

// ---------------------------------------------------------------------------
// Shared: load the run's scenario
// ---------------------------------------------------------------------------

/** Scenario for a replay: <runDir>/scenario.json (written by the runner, with
 * the prompt already substituted), or an explicit --scenario override file. */
export function loadRunScenario(runDir: string, scenarioPath?: string): Scenario {
  if (scenarioPath !== undefined) return loadScenarioFile(scenarioPath);
  const p = join(runDir, 'scenario.json');
  if (!existsSync(p)) throw new Error(`no scenario.json in ${runDir} — not an eval run dir?`);
  const v = validateScenario(JSON.parse(readFileSync(p, 'utf-8')));
  if (!v.ok) throw new Error(`invalid ${p}:\n  ${v.errors.join('\n  ')}`);
  return v.scenario;
}

// ---------------------------------------------------------------------------
// L2: re-grade from the journal + persisted workspace (no LLM, no agent)
// ---------------------------------------------------------------------------

/** The 'scores' journal event as written by the runner (old scores). */
export interface OldScores {
  success?: boolean;
  checksPassed?: number;
  checksTotal?: number;
  efficiency?: { wallMs?: number; steps?: number; usd?: number };
}

export interface L2ReplayReport {
  scenarioId: string;
  workspaceMissing: boolean;
  /** Scores recorded by the original run's journal, when present. */
  oldScores: OldScores | null;
  /** Freshly graded scores (skipped checks excluded from success). */
  scores: ScoreVector;
  skipped: CheckOutcome[];
  summary: string;
}

const WORKSPACE_CHECKS: ReadonlyArray<GradingCheck['type']> = ['fileExists', 'fileContains', 'commandExitZero'];

function findEvent(events: JournalEvent[], type: string): JournalEvent | undefined {
  return events.find((e) => e.type === type);
}

export async function replayL2(runDir: string, opts: { scenarioPath?: string } = {}): Promise<L2ReplayReport> {
  const scenario = loadRunScenario(runDir, opts.scenarioPath);
  const events = readJournal(join(runDir, 'journal.jsonl'));
  if (events.length === 0) throw new Error(`no journal.jsonl in ${runDir} — nothing to re-grade`);

  const runEnd = findEvent(events, 'run.end');
  const oldScores = (findEvent(events, 'scores') as OldScores | undefined) ?? null;
  const output = typeof runEnd?.['output'] === 'string' ? runEnd['output'] : '';
  const steps = typeof runEnd?.['steps'] === 'number' ? runEnd['steps'] : 0;

  const workspaceDir = join(runDir, 'workspace');
  const workspaceMissing = !existsSync(workspaceDir);

  const skipped: CheckOutcome[] = [];
  const gradable: GradingCheck[] = [];
  for (const check of scenario.grading.checks) {
    if (check.type === 'judge') {
      skipped.push({ check, passed: false, skipped: true, detail: 'skipped: judge checks are not re-run (L2 replay makes no LLM calls)' });
    } else if (workspaceMissing && WORKSPACE_CHECKS.includes(check.type)) {
      skipped.push({ check, passed: false, skipped: true, detail: 'skipped: workspace missing' });
    } else {
      gradable.push(check);
    }
  }

  // The original scrubbed child env is gone with the run's data/ teardown;
  // rebuild it from the scenario (policy env + canaries — the same inputs the
  // runner used, minus run-specific extras) for commandExitZero.
  const scores = await grade(gradable, {
    workspaceDir,
    output,
    journal: events,
    canaries: scenario.policy?.canaryCredentials ?? [],
    env: buildEvalEnv(scenario),
    wallMs: oldScores?.efficiency?.wallMs ?? 0,
    steps,
    ...(oldScores?.efficiency?.usd !== undefined ? { usd: oldScores.efficiency.usd } : {}),
  });
  // Report the full check count; skipped checks are excluded from success
  // (they are neither passes nor failures).
  scores.checkOutcomes.push(...skipped);
  scores.checksTotal += skipped.length;

  const summary =
    `L2 re-grade ${scenario.id}: ` +
    `old ${oldScores !== null ? `${oldScores.checksPassed}/${oldScores.checksTotal} success=${oldScores.success}` : 'n/a'} → ` +
    `new ${scores.checksPassed}/${scores.checksTotal} success=${scores.success}` +
    (skipped.length > 0 ? ` (${skipped.length} skipped)` : '');

  return { scenarioId: scenario.id, workspaceMissing, oldScores, scores, skipped, summary };
}

// ---------------------------------------------------------------------------
// L1: full turn against the recorded LLM trajectory
// ---------------------------------------------------------------------------

export async function replayL1(
  runDir: string,
  opts: { scenarioPath?: string } & EvalRunOptions = {},
): Promise<EvalRunReport> {
  const replayDb = join(runDir, 'replay.db');
  if (!existsSync(replayDb)) {
    throw new Error(`no replay.db in ${runDir} — the run preserved no LLM ledger (zero LLM calls, or pre-Phase-3 run)`);
  }
  const { scenarioPath, ...runOpts } = opts;
  const scenario = loadRunScenario(runDir, scenarioPath);
  // Path remap source: recorded tool params reference the ORIGINAL run's
  // workspace; the runner exports it (with the replay run's workspace as the
  // target) so the eval gate rewrites params and live tools never touch the
  // archived original. Sanity-checked below via mtime.
  const originalWorkspace = resolve(runDir, 'workspace');
  const mtimeBefore = existsSync(originalWorkspace) ? statSync(originalWorkspace).mtimeMs : undefined;
  const report = await runEval(scenario, { ...runOpts, replayDb, replayPathFrom: originalWorkspace });
  if (mtimeBefore !== undefined && statSync(originalWorkspace).mtimeMs !== mtimeBefore) {
    log.warn({ runDir }, 'L1 replay: original workspace mtime changed — path remap may have leaked a write');
  }
  return report;
}
