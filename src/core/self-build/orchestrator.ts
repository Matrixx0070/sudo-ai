/**
 * @file self-build/orchestrator.ts
 * @description SelfBuild orchestrator — called every 30 minutes by the cron job.
 *
 * Flow (each tick, sequential, fail-fast):
 *   1. Kill-switch checks (disabled, killed, halted)
 *   2. Alignment gate (score < threshold → abort)
 *   3. Budget gate (daily LLM spend >= cap → abort)
 *   4. Mistake auto-block gate
 *   5. Git branch gate (must be on 'self-build')
 *   6. Dirty-tree cleanup
 *   7. Agent turn (LLM produces edits)
 *   8. Post-agent gates (tsc, vitest, protected-path diff)
 *   9. Commit + journal update
 *
 * See docs/SELFBUILD_CHARTER.md for operating mandate.
 * See spec §8 R7 for the three-layer protected-path defense.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isProtectedPath, PROTECTED_PATHS } from './protected-paths.js';
import { PROJECT_ROOT } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status values returned by runSelfBuildTick. */
export type TickStatus =
  | 'disabled'
  | 'killed'
  | 'halted'
  | 'align-low'
  | 'budget-exceeded'
  | 'mistake-blocked'
  | 'wrong-branch'
  | 'dirty-state'
  | 'no-action'
  | 'test-fail-reverted'
  | 'protected-path-reverted'
  | 'committed';

export interface TickResult {
  status: TickStatus;
  commitSha?: string;
  message?: string;
  alignScore?: number;
  budgetUsdToday?: number;
}

/**
 * Dependencies injected by cli.ts (Builder L).
 * All optional fields are fail-open — absence skips the related gate.
 */
export interface SelfBuildDeps {
  /** The running agent loop — used to call the self-build agent turn. */
  agentLoop: {
    run(sessionId: string, message: string): Promise<{ text: string }>;
  };
  /** Open better-sqlite3 database handle (data/mind.db). */
  mindDb: Database.Database;
  /**
   * AlignmentAggregator — optional. When absent the alignment gate is skipped
   * (treat as warming-up → abort if score is provided below threshold).
   */
  alignmentAggregator?: {
    getLastReport(): { score?: number; overallScore?: number } | null;
  } | null;
  /** MistakeAutoBlockGuard — optional. When absent the block gate is skipped. */
  mistakeAutoBlockGuard?: {
    decide(text: string): { verdict: 'PASS' | 'WARN' | 'BLOCK' };
  } | null;
  /** Structured logger. */
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
  };
  /** Absolute path to the project root. Defaults to the resolved PROJECT_ROOT (SUDO_AI_HOME or cwd). */
  gitCwd?: string;
}

// ---------------------------------------------------------------------------
// Internal state schema (persisted to data/self-build-state.json)
// ---------------------------------------------------------------------------

interface SelfBuildState {
  consecutiveNoCommitTicks: number;
  consecutiveGateAbortTicks: number;
  halted: boolean;
  haltReason: string;
  haltedAt: string | null;
  lastCommitHash: string | null;
  lastTickAt: string | null;
  priorTestCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SELF_BUILD_CANDIDATE_ACTION = 'self-build agent tick — produce commits advancing SUDO-AI codebase';
const STATE_FILENAME = 'data/self-build-state.json';
const JOURNAL_DIR = 'data/self-build-reports';
const JOURNAL_FILE = join(JOURNAL_DIR, 'journal.md');
const CHARTER_FILE = 'docs/SELFBUILD_CHARTER.md';

const DEFAULT_MIN_ALIGN_SCORE = 0.6;
const DEFAULT_DAILY_BUDGET_USD = 20;
const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_MAX_NO_COMMIT_TICKS = 3;
const DEFAULT_MAX_GATE_ABORT_TICKS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Self-build daily LLM spend cap (USD). SUDO_DAILY_LLM_BUDGET_USD overrides the
 * $20 default. A value of 0, a negative number, or off/none/unlimited/inf/
 * infinity (case-insensitive) disables the gate entirely (returns Infinity) —
 * the self-build loop then runs regardless of daily spend. Unset ⇒ default.
 */
function resolveDailyLlmCap(): number {
  const raw = process.env['SUDO_DAILY_LLM_BUDGET_USD'];
  if (raw === undefined) return DEFAULT_DAILY_BUDGET_USD;
  const trimmed = raw.trim();
  if (['off', 'none', 'unlimited', 'inf', 'infinity'].includes(trimmed.toLowerCase())) {
    return Infinity;
  }
  const parsed = parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_BUDGET_USD;
  if (parsed <= 0) return Infinity;
  return parsed;
}

function loadState(cwd: string): SelfBuildState {
  const statePath = join(cwd, STATE_FILENAME);
  const defaults: SelfBuildState = {
    consecutiveNoCommitTicks: 0,
    consecutiveGateAbortTicks: 0,
    halted: false,
    haltReason: '',
    haltedAt: null,
    lastCommitHash: null,
    lastTickAt: null,
    priorTestCount: 0,
  };
  if (!existsSync(statePath)) return defaults;
  try {
    const raw = readFileSync(statePath, 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveState(cwd: string, state: SelfBuildState): void {
  const statePath = join(cwd, STATE_FILENAME);
  const dir = join(cwd, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function latchHalt(cwd: string, state: SelfBuildState, reason: string): SelfBuildState {
  const updated: SelfBuildState = {
    ...state,
    halted: true,
    haltReason: reason,
    haltedAt: new Date().toISOString(),
  };
  saveState(cwd, updated);
  return updated;
}

/**
 * Query daily LLM spend from api_call_log (the table the cost-tracker writes).
 * The legacy api_costs table is never populated, so it is no longer summed —
 * keeping it would only risk double-counting if it were ever backfilled.
 * Fail-CLOSED: returns Infinity if api_call_log is missing, so an agent cannot
 * bypass the budget gate by dropping the table that holds real spend.
 */
function queryDailySpend(db: Database.Database): number {
  try {
    // Assert the spend table exists — fail-closed if missing
    const exists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='api_call_log'`,
    ).get();
    if (!exists) {
      // Spend table missing — budget defense compromised. Return Infinity to abort.
      return Infinity;
    }
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    const row = db.prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS s FROM api_call_log WHERE called_at > ?`,
    ).get(cutoff) as { s: number };
    return row.s;
  } catch {
    // Query failed — fail closed
    return Infinity;
  }
}

function readCharter(cwd: string): string {
  const charterPath = join(cwd, CHARTER_FILE);
  if (!existsSync(charterPath)) return '(charter not found)';
  try {
    return readFileSync(charterPath, 'utf8');
  } catch {
    return '(charter unreadable)';
  }
}

function readJournalSummary(cwd: string): string {
  const journalPath = join(cwd, JOURNAL_FILE);
  if (!existsSync(journalPath)) return '(no prior journal entries)';
  try {
    const content = readFileSync(journalPath, 'utf8');
    // Return last 2000 chars as context for the agent
    return content.slice(-2000);
  } catch {
    return '(journal unreadable)';
  }
}

function appendJournal(
  cwd: string,
  entry: {
    commitSha: string | undefined;
    summary: string;
    testCount: number;
    alignScore: number | undefined;
    budget: number;
    status: string;
  },
): void {
  const journalPath = join(cwd, JOURNAL_FILE);
  mkdirSync(join(cwd, JOURNAL_DIR), { recursive: true });
  const ts = new Date().toISOString();
  const line = [
    `\n## ${ts}`,
    `- status: ${entry.status}`,
    `- commit: ${entry.commitSha ?? 'none'}`,
    `- summary: ${entry.summary}`,
    `- tests: ${entry.testCount}`,
    `- alignScore: ${entry.alignScore ?? 'unknown'}`,
    `- budgetUsd: ${entry.budget.toFixed(4)}`,
    '',
  ].join('\n');
  try {
    const existing = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '# Self-Build Journal\n';
    writeFileSync(journalPath, existing + line, 'utf8');
  } catch { /* non-fatal */ }
}

/**
 * Allowlist-based commit message sanitizer (LOW-1).
 * Only keeps safe ASCII characters; joining segments with space prevents
 * adjacent tokens from merging into something unexpected.
 */
function sanitizeSummary(s: string): string {
  return (s.slice(0, 100).match(/[a-zA-Z0-9 .,\-_/()+]+/g) ?? []).join(' ').trim().slice(0, 100) || 'self-build tick';
}

/**
 * Revert agent changes: reset tracked files and clean untracked files from
 * protected directories only (MEDIUM-3). Does NOT `git clean .` to avoid
 * destroying Frank's WIP outside protected paths.
 */
function revertAgentChanges(cwd: string): void {
  execSafe('git checkout -- .', { cwd });
  const targetedCleanRoots = ['src/core/self-build/', '.githooks/'];
  for (const root of targetedCleanRoots) {
    try { execSync(`git clean -fd -- ${root}`, { cwd, stdio: 'pipe' }); } catch {}
  }
}

function parseTestCount(vitestOutput: string): number {
  // Vitest dot-reporter: "Tests 3616 passed | 0 failed"
  // Also handles: "3616 passed"
  const match = vitestOutput.match(/(\d+)\s+passed/);
  return match ? parseInt(match[1], 10) : 0;
}

function execSafe(
  cmd: string,
  opts: { cwd: string; timeout?: number },
): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 30_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout ?? '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; status?: number };
    return {
      stdout: (e.stdout ?? '') as string,
      exitCode: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Main tick function
// ---------------------------------------------------------------------------

/**
 * Run a single self-build tick.
 *
 * This is the critical-path function. All gates are sequential and fail-fast.
 * The function never throws — all errors are caught and returned as status codes.
 */
export async function runSelfBuildTick(deps: SelfBuildDeps): Promise<TickResult> {
  const cwd = deps.gitCwd ?? PROJECT_ROOT;
  const log = deps.logger;

  // -------------------------------------------------------------------------
  // Gate 1: Mode enabled?
  // -------------------------------------------------------------------------
  if (process.env['SUDO_SELF_BUILD_MODE'] !== '1') {
    return { status: 'disabled' };
  }

  // -------------------------------------------------------------------------
  // Gate 2: Kill-switch
  // -------------------------------------------------------------------------
  if (process.env['SUDO_SELF_BUILD_DISABLE'] === '1') {
    log.warn({}, 'self-build: kill-switch SUDO_SELF_BUILD_DISABLE=1 — tick noop');
    return { status: 'killed' };
  }

  // -------------------------------------------------------------------------
  // Gate 3: Halted state check
  // -------------------------------------------------------------------------
  const state = loadState(cwd);
  if (state.halted) {
    log.warn({ haltReason: state.haltReason }, 'self-build: halted — tick noop');
    return { status: 'halted', message: state.haltReason };
  }

  // -------------------------------------------------------------------------
  // Gate 4: Alignment gate
  // -------------------------------------------------------------------------
  const rep = deps.alignmentAggregator?.getLastReport() ?? null;
  const rawScore: number | undefined = rep?.score ?? rep?.overallScore;
  const alignScore: number | null = typeof rawScore === 'number' ? rawScore : null;

  const minAlignScore = parseFloat(
    process.env['SUDO_SELF_BUILD_MIN_ALIGN_SCORE'] ?? String(DEFAULT_MIN_ALIGN_SCORE),
  );

  if (alignScore === null) {
    // null = warming-up (aggregator hasn't run evaluate() yet since process start).
    // This is a transient boot condition, NOT a safety violation — do NOT increment
    // consecutiveGateAbortTicks. Incrementing here caused permanent S4 halts after 3
    // restarts because the aggregator has no data until the first agent interaction.
    log.warn({ alignScore: null }, 'self-build: alignment score null (warming-up) — skip tick, counter unchanged');
    const updated: SelfBuildState = {
      ...state,
      lastTickAt: new Date().toISOString(),
    };
    saveState(cwd, updated);
    return { status: 'align-low', alignScore: undefined };
  }

  if (alignScore < minAlignScore) {
    log.warn(
      { alignScore, minAlignScore },
      'self-build: alignment score below threshold — abort',
    );
    const updated: SelfBuildState = {
      ...state,
      consecutiveGateAbortTicks: state.consecutiveGateAbortTicks + 1,
      lastTickAt: new Date().toISOString(),
    };
    const finalState = checkStopConditions(cwd, updated, log);
    saveState(cwd, finalState);
    return { status: 'align-low', alignScore };
  }

  // -------------------------------------------------------------------------
  // Gate 5: Budget gate
  // -------------------------------------------------------------------------
  const budgetUsdToday = queryDailySpend(deps.mindDb);
  const cap = resolveDailyLlmCap();
  // A non-finite cap means the gate is disabled (SUDO_DAILY_LLM_BUDGET_USD=off):
  // the self-build loop then runs regardless of daily spend. Finite caps keep
  // the fail-closed behaviour (queryDailySpend returns Infinity on missing
  // tables, which still trips the gate).
  if (Number.isFinite(cap) && budgetUsdToday >= cap) {
    log.warn(
      { budgetUsdToday, cap },
      'self-build: daily LLM budget exceeded — abort',
    );
    const updated: SelfBuildState = {
      ...state,
      consecutiveGateAbortTicks: state.consecutiveGateAbortTicks + 1,
      lastTickAt: new Date().toISOString(),
    };
    const finalState = checkStopConditions(cwd, updated, log);
    saveState(cwd, finalState);
    return { status: 'budget-exceeded', budgetUsdToday, alignScore };
  }

  // -------------------------------------------------------------------------
  // Gate 6: Mistake auto-block
  // -------------------------------------------------------------------------
  if (deps.mistakeAutoBlockGuard) {
    try {
      const decision = deps.mistakeAutoBlockGuard.decide(SELF_BUILD_CANDIDATE_ACTION);
      if (decision.verdict === 'BLOCK') {
        log.warn({ verdict: 'BLOCK' }, 'self-build: MistakeAutoBlockGuard BLOCK — abort');
        const updated: SelfBuildState = {
          ...state,
          consecutiveGateAbortTicks: state.consecutiveGateAbortTicks + 1,
          lastTickAt: new Date().toISOString(),
        };
        const finalState = checkStopConditions(cwd, updated, log);
        saveState(cwd, finalState);
        return { status: 'mistake-blocked', alignScore, budgetUsdToday };
      }
    } catch (err) {
      // Guard threw — fail-closed (LOW-3): treat as BLOCK to prevent bypass via exception
      log.warn({ err: String(err) }, 'self-build: MistakeAutoBlockGuard threw — fail-closed');
      return { status: 'mistake-blocked', message: 'guard threw — fail-closed', alignScore, budgetUsdToday };
    }
  }

  // -------------------------------------------------------------------------
  // Gate 7: Branch gate
  // -------------------------------------------------------------------------
  const branchResult = execSafe('git rev-parse --abbrev-ref HEAD', { cwd });
  const currentBranch = branchResult.stdout.trim();
  if (currentBranch !== 'self-build') {
    log.warn(
      { currentBranch },
      'self-build: HEAD not on self-build branch — abort',
    );
    const updated: SelfBuildState = {
      ...state,
      consecutiveGateAbortTicks: state.consecutiveGateAbortTicks + 1,
      lastTickAt: new Date().toISOString(),
    };
    const finalState = checkStopConditions(cwd, updated, log);
    saveState(cwd, finalState);
    return { status: 'wrong-branch', message: currentBranch, alignScore, budgetUsdToday };
  }

  // -------------------------------------------------------------------------
  // Gate 8: Dirty-tree gate — clean up if dirty, then proceed
  // -------------------------------------------------------------------------
  const dirtyResult = execSafe('git status --porcelain', { cwd });
  const isDirty = dirtyResult.stdout.trim().length > 0;
  if (isDirty) {
    log.warn({ porcelain: dirtyResult.stdout.slice(0, 200) }, 'self-build: dirty tree — cleaning before agent turn');
    execSafe('git checkout -- .', { cwd });
    // git checkout cannot remove untracked files (e.g. agent leftovers from a
    // failed prior tick that landed outside the targeted clean roots). Without
    // this, the recheck below stays dirty forever and every tick wedges in
    // 'dirty-state'. Remove ONLY the untracked paths git reports (porcelain
    // '?? '), never a blanket `git clean .`, so tracked content is untouched.
    const untrackedAfterCheckout = execSafe('git status --porcelain', { cwd }).stdout
      .split('\n')
      .filter((l) => l.startsWith('?? '))
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    for (const p of untrackedAfterCheckout) {
      try { execSync(`git clean -fd -- ${JSON.stringify(p)}`, { cwd, stdio: 'pipe' }); } catch {}
    }
    // Re-check after cleanup
    const recheckResult = execSafe('git status --porcelain', { cwd });
    if (recheckResult.stdout.trim().length > 0) {
      log.error({ porcelain: recheckResult.stdout.slice(0, 200) }, 'self-build: dirty tree persists after cleanup');
      return { status: 'dirty-state', alignScore, budgetUsdToday };
    }
  }

  // -------------------------------------------------------------------------
  // Step 9: Read charter + journal, build agent prompt
  // -------------------------------------------------------------------------
  const charter = readCharter(cwd);
  const journalSummary = readJournalSummary(cwd);
  const maxIterations = parseInt(
    process.env['SUDO_SELF_BUILD_MAX_ITERATIONS'] ?? String(DEFAULT_MAX_ITERATIONS),
    10,
  );

  const prompt = [
    '=== SELF-BUILD CHARTER ===',
    charter,
    '',
    '=== RECENT JOURNAL ===',
    journalSummary,
    '',
    '=== TASK ===',
    `Perform one self-build tick. Max agent iterations: ${maxIterations}.`,
    'Make exactly ONE focused, testable improvement to the codebase.',
    'You are on branch: self-build.',
    `Protected paths you must NOT touch: ${PROTECTED_PATHS.join(', ')}`,
    '',
    'When done: output a one-line summary of the change as your final message.',
    'Do NOT run git commit — the orchestrator will handle that.',
  ].join('\n');

  // -------------------------------------------------------------------------
  // Step 10: Agent turn
  // -------------------------------------------------------------------------
  const sessionId = `self-build-${randomUUID()}`;
  let agentSummary = 'self-build tick (no summary)';

  try {
    const result = await deps.agentLoop.run(sessionId, prompt);
    if (result?.text) {
      // Use first non-empty line of the response as the commit summary
      const firstLine = result.text.split('\n').find((l) => l.trim().length > 0);
      if (firstLine) agentSummary = firstLine.trim().slice(0, 200);
    }
  } catch (err) {
    log.error({ err: String(err) }, 'self-build: agent turn threw — reverting');
    revertAgentChanges(cwd);
    return { status: 'test-fail-reverted', message: `agent error: ${String(err)}`, alignScore, budgetUsdToday };
  }

  // -------------------------------------------------------------------------
  // Post-agent Gate A: Did the agent make any changes?
  // -------------------------------------------------------------------------
  const postDirty = execSafe('git status --porcelain', { cwd });
  if (postDirty.stdout.trim().length === 0) {
    log.info({}, 'self-build: agent made no changes — no-action');
    const updated: SelfBuildState = {
      ...state,
      consecutiveNoCommitTicks: state.consecutiveNoCommitTicks + 1,
      lastTickAt: new Date().toISOString(),
    };
    const finalState = checkStopConditions(cwd, updated, log);
    saveState(cwd, finalState);
    return { status: 'no-action', alignScore, budgetUsdToday };
  }

  // -------------------------------------------------------------------------
  // Post-agent Gate B: Protected path check (pre-commit, before staging)
  // -------------------------------------------------------------------------
  // Check all modified/added/deleted files in working tree
  const untrackedResult = execSafe('git diff --name-only && git ls-files --others --exclude-standard', { cwd });
  const changedFiles = untrackedResult.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  for (const file of changedFiles) {
    // HIGH-3: resolve symlinks — check both raw and resolved path
    let realRel = file;
    try {
      const abs = path.resolve(cwd, file);
      const realAbs = realpathSync(abs);
      realRel = path.relative(cwd, realAbs);
    } catch { /* file may not exist yet (untracked new file) — fall back to raw path */ }

    if (isProtectedPath(file) || isProtectedPath(realRel)) {
      log.error(
        { file, realRel },
        'self-build: agent modified protected path — reverting',
      );
      revertAgentChanges(cwd);
      const updated = latchHalt(cwd, state, `S8: protected path modified: ${file}`);
      void updated;
      return { status: 'protected-path-reverted', message: file, alignScore, budgetUsdToday };
    }
  }

  // -------------------------------------------------------------------------
  // Post-agent Gate C: TypeScript compile check
  // -------------------------------------------------------------------------
  log.info({}, 'self-build: running tsc --noEmit');
  const tscResult = execSafe('npx tsc --noEmit', { cwd, timeout: 120_000 });
  if (tscResult.exitCode !== 0) {
    log.warn({ stdout: tscResult.stdout.slice(0, 500) }, 'self-build: tsc failed — reverting');
    revertAgentChanges(cwd);
    return {
      status: 'test-fail-reverted',
      message: 'tsc failed',
      alignScore,
      budgetUsdToday,
    };
  }

  // -------------------------------------------------------------------------
  // Post-agent Gate D: Test suite (no regressions)
  // -------------------------------------------------------------------------
  log.info({}, 'self-build: running vitest');
  const vitestResult = execSafe('npx vitest run --reporter=dot', { cwd, timeout: 180_000 });
  const newTestCount = parseTestCount(vitestResult.stdout);
  const priorTestCount = state.priorTestCount > 0 ? state.priorTestCount : 0;

  if (vitestResult.exitCode !== 0) {
    log.warn(
      { exitCode: vitestResult.exitCode, stdout: vitestResult.stdout.slice(0, 500) },
      'self-build: vitest failed — reverting',
    );
    revertAgentChanges(cwd);
    return { status: 'test-fail-reverted', message: 'vitest failed', alignScore, budgetUsdToday };
  }

  if (priorTestCount > 0 && newTestCount < priorTestCount) {
    log.warn(
      { newTestCount, priorTestCount },
      'self-build: test count regression — reverting',
    );
    revertAgentChanges(cwd);
    return {
      status: 'test-fail-reverted',
      message: `test regression: ${newTestCount} < ${priorTestCount}`,
      alignScore,
      budgetUsdToday,
    };
  }

  // -------------------------------------------------------------------------
  // Step 11: Stage all and post-commit protected-path verify
  // -------------------------------------------------------------------------
  execSafe('git add -A', { cwd });

  // Check staged files against protected paths (pre-commit Layer 3 check)
  const stagedResult = execSafe('git diff --cached --name-only', { cwd });
  const stagedFiles = stagedResult.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  for (const file of stagedFiles) {
    // HIGH-3: resolve symlinks on staged paths too
    let realRelStaged = file;
    try {
      const absStaged = path.resolve(cwd, file);
      const realAbsStaged = realpathSync(absStaged);
      realRelStaged = path.relative(cwd, realAbsStaged);
    } catch { /* file may not exist — fall back to raw path */ }

    if (isProtectedPath(file) || isProtectedPath(realRelStaged)) {
      log.error(
        { file, realRelStaged },
        'self-build: staged protected path — reverting (pre-commit catch)',
      );
      execSafe('git reset HEAD .', { cwd });
      revertAgentChanges(cwd);
      const updated = latchHalt(cwd, state, `S8: protected path staged: ${file}`);
      void updated;
      return { status: 'protected-path-reverted', message: file, alignScore, budgetUsdToday };
    }
  }

  // Commit — use allowlist sanitizer to prevent shell injection (LOW-1).
  const sanitizedSummary = sanitizeSummary(agentSummary);
  const commitMsg = `self-build: ${sanitizedSummary || 'automated improvement'}`;
  const commitResult = execSafe(
    `git commit -m '${commitMsg}'`,
    { cwd },
  );
  if (commitResult.exitCode !== 0) {
    log.error({ stdout: commitResult.stdout.slice(0, 300) }, 'self-build: git commit failed');
    execSafe('git checkout -- .', { cwd });
    return { status: 'test-fail-reverted', message: 'git commit failed', alignScore, budgetUsdToday };
  }

  // Post-commit: verify no protected paths snuck through
  const postCommitDiff = execSafe('git show --name-only HEAD', { cwd });
  const postCommitFiles = postCommitDiff.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  for (const file of postCommitFiles) {
    if (isProtectedPath(file)) {
      log.error(
        { file },
        'self-build: protected path in committed diff — reverting commit + halting',
      );
      const revertResult = execSafe('git revert HEAD --no-edit', { cwd });
      let reverted = revertResult.exitCode === 0;
      let escalation = '';
      if (!reverted) {
        // git revert failed (conflict, hook, editor) — the bad commit is still
        // HEAD. Escalate: hard-reset the freshly-created tip commit so the
        // protected-path change cannot remain live on the branch.
        log.error(
          { file, exitCode: revertResult.exitCode, stdout: revertResult.stdout.slice(0, 300) },
          'self-build: git revert failed — escalating to hard reset of HEAD',
        );
        const resetResult = execSafe('git reset --hard HEAD~1', { cwd });
        reverted = resetResult.exitCode === 0;
        escalation = reverted
          ? ' (revert failed, hard-reset succeeded)'
          : ' (revert AND hard-reset FAILED — commit still live)';
      }
      latchHalt(cwd, state, `S8: protected path in commit: ${file}${escalation}`);
      return { status: 'protected-path-reverted', message: `${file}${escalation}`, alignScore, budgetUsdToday };
    }
  }

  // Get commit SHA
  const shaResult = execSafe('git rev-parse HEAD', { cwd });
  const commitSha = shaResult.stdout.trim();

  // -------------------------------------------------------------------------
  // Step 12: Update state and journal
  // -------------------------------------------------------------------------
  const finalState: SelfBuildState = {
    ...state,
    consecutiveNoCommitTicks: 0,
    consecutiveGateAbortTicks: 0,
    lastCommitHash: commitSha,
    lastTickAt: new Date().toISOString(),
    priorTestCount: newTestCount,
  };
  saveState(cwd, finalState);

  appendJournal(cwd, {
    commitSha,
    summary: agentSummary,
    testCount: newTestCount,
    alignScore: typeof alignScore === 'number' ? alignScore : undefined,
    budget: budgetUsdToday,
    status: 'committed',
  });

  log.info(
    { commitSha, testCount: newTestCount, alignScore, budgetUsdToday },
    'self-build: tick committed successfully',
  );

  return { status: 'committed', commitSha, alignScore, budgetUsdToday };
}

// ---------------------------------------------------------------------------
// Stop condition checker (S3, S4)
// Returns a possibly-halted copy of state. Caller MUST use the returned value
// for saveState — never pass `state` directly after calling this function.
// ---------------------------------------------------------------------------

function checkStopConditions(
  cwd: string,
  state: SelfBuildState,
  log: SelfBuildDeps['logger'],
): SelfBuildState {
  const maxNoCommit = parseInt(
    process.env['SUDO_SELF_BUILD_MAX_NO_COMMIT_TICKS'] ?? String(DEFAULT_MAX_NO_COMMIT_TICKS),
    10,
  );
  const maxGateAbort = parseInt(
    process.env['SUDO_SELF_BUILD_MAX_GATE_ABORT_TICKS'] ?? String(DEFAULT_MAX_GATE_ABORT_TICKS),
    10,
  );

  let current = state;

  if (current.consecutiveNoCommitTicks >= maxNoCommit) {
    log.error(
      { consecutiveNoCommitTicks: current.consecutiveNoCommitTicks },
      `self-build: S3 stop condition — ${maxNoCommit} consecutive no-commit ticks`,
    );
    current = latchHalt(cwd, current, `S3: ${current.consecutiveNoCommitTicks} consecutive no-commit ticks`);
  }

  if (current.consecutiveGateAbortTicks >= maxGateAbort) {
    log.error(
      { consecutiveGateAbortTicks: current.consecutiveGateAbortTicks },
      `self-build: S4 stop condition — ${maxGateAbort} consecutive gate-abort ticks`,
    );
    current = latchHalt(cwd, current, `S4: ${current.consecutiveGateAbortTicks} consecutive gate-abort ticks`);
  }

  return current;
}
// test
