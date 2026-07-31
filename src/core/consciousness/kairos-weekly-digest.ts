/**
 * @file kairos-weekly-digest.ts
 * @description ADR-0006 weekly repair digest — the demand-driven replacement
 * for the timer-driven KAIROS→arsenal loop.
 *
 * Once a week (SUDO_KAIROS_WEEKLY_DIGEST=1, cron via SUDO_KAIROS_DIGEST_CRON,
 * default Sunday 05:00 UTC) this re-runs the two cheap deterministic KAIROS
 * observations (large files, tsc errors) and, for each one that fires, runs a
 * single arsenal dry-run against the LIVE codebase. The combined work product
 * lands as ONE reviewable git branch (`kairos/digest-YYYY-MM-DD`) carrying the
 * proposed file contents plus a digest report — not a proposals.db row, which
 * had a 0% review drain rate (65 pending, 0 reviewed, 2026-07-29→31).
 *
 * Budgets (invariant 10): each analysis consumes the same per-day budget as
 * the old loop (SUDO_KAIROS_REPAIR_MAX_PER_DAY, default 4), plus a per-run cap
 * of one analysis per observation class (max 2 LLM calls per digest run).
 * Never throws — a broken digest must not take the cron loop with it.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT } from '../shared/paths.js';
import type { KairosObservation } from './kairos.js';

const log = createLogger('consciousness:kairos-digest');

export interface DigestEdit { filePath: string; content: string }

export interface DigestAnalysis {
  observation: KairosObservation;
  mode: 'fix' | 'refactor';
  report: string;
  edits: DigestEdit[];
}

export interface WeeklyDigestDeps {
  /** Deterministic observation pass (default: kairos checkLargeFiles + checkCodebaseHealth). */
  observe: () => Promise<KairosObservation[]>;
  /** One arsenal dry-run (applyEdits:false). Injected so tests never need a model. */
  analyze: (task: string, mode: 'fix' | 'refactor') => Promise<{ report: string; edits: DigestEdit[] }>;
  /** Per-day budget gate (default: consumeKairosRepairBudget from the repair gate). */
  consumeBudget: () => { allowed: boolean; used: number; max: number };
  /** Git runner (default: execFileSync git). Injected for tests. */
  git: (args: string[], cwd: string) => string;
  /** Fire-and-forget owner notification. */
  notify?: (title: string, body: string) => void;
  /** Repo to branch from (default PROJECT_ROOT). */
  repoRoot?: string;
  now?: Date;
}

export interface WeeklyDigestSummary {
  observations: number;
  analysesRun: number;
  analysesSkipped: number;
  editsProposed: number;
  branch: string | null;
  budgetHalted: boolean;
}

/** Branch name for a digest run; `attempt` > 0 disambiguates same-day re-runs. */
export function digestBranchName(now: Date, attempt = 0): string {
  const day = now.toISOString().slice(0, 10);
  return attempt === 0 ? `kairos/digest-${day}` : `kairos/digest-${day}-${attempt + 1}`;
}

/** Render the digest report committed alongside the proposed edits. */
export function renderDigest(analyses: DigestAnalysis[], now: Date): string {
  const lines: string[] = [
    `# KAIROS weekly repair digest — ${now.toISOString().slice(0, 10)}`,
    '',
    'ADR-0006 demand-driven work product. Proposed file contents are committed',
    'on this branch; review with `git diff main...HEAD`. Nothing is applied',
    'automatically.',
    '',
  ];
  for (const a of analyses) {
    lines.push(`## ${a.mode.toUpperCase()} — ${a.observation.type}`);
    lines.push('', a.observation.message, '');
    lines.push(`Proposed files (${a.edits.length}):`);
    for (const e of a.edits) lines.push(`- ${e.filePath}`);
    lines.push('', '### Arsenal report', '', a.report.trim(), '');
  }
  return lines.join('\n');
}

function defaultGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 60_000 });
}

/**
 * Commit the digest to a fresh branch via a TEMPORARY worktree so the live
 * checkout's working tree (which may carry deliberate uncommitted prod edits)
 * is never touched. The worktree is always removed; the branch remains.
 */
function commitDigestBranch(
  analyses: DigestAnalysis[],
  deps: Required<Pick<WeeklyDigestDeps, 'git'>> & Pick<WeeklyDigestDeps, 'repoRoot' | 'now'>,
): string {
  const repo = deps.repoRoot ?? PROJECT_ROOT;
  const now = deps.now ?? new Date();
  let branch = digestBranchName(now);
  for (let attempt = 1; attempt < 10; attempt++) {
    try {
      deps.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo);
      branch = digestBranchName(now, attempt); // exists — try the next suffix
    } catch {
      break; // rev-parse failed ⇒ branch name is free
    }
  }
  const wt = mkdtempSync(path.join(os.tmpdir(), 'kairos-digest-'));
  try {
    deps.git(['worktree', 'add', '--detach', wt, 'HEAD'], repo);
    for (const a of analyses) {
      for (const e of a.edits) {
        const target = path.join(wt, e.filePath);
        if (!target.startsWith(wt + path.sep)) continue; // refuse path escape
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, e.content, 'utf-8');
      }
    }
    const digestPath = path.join(wt, 'docs', `kairos-digest-${now.toISOString().slice(0, 10)}.md`);
    mkdirSync(path.dirname(digestPath), { recursive: true });
    writeFileSync(digestPath, renderDigest(analyses, now), 'utf-8');
    deps.git(['checkout', '-b', branch], wt);
    deps.git(['add', '-A'], wt);
    deps.git(['commit', '-m', `kairos: weekly repair digest ${now.toISOString().slice(0, 10)} (ADR-0006, dry-run proposal — not applied)`], wt);
  } finally {
    try { deps.git(['worktree', 'remove', '--force', wt], repo); } catch { /* branch survives; tmp dir below */ }
    try { rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return branch;
}

/** Build the default deps (live kairos checks + live arsenal dry-run). */
export async function defaultWeeklyDigestDeps(): Promise<Omit<WeeklyDigestDeps, 'notify'>> {
  const { checkLargeFiles, checkCodebaseHealth } = await import('./kairos.js');
  const { arsenalTool, consumeKairosRepairBudget } = await import('../tools/builtin/coder/arsenal.js');
  return {
    observe: async () => [...await checkLargeFiles(), ...await checkCodebaseHealth()],
    analyze: async (task, mode) => {
      const ctx = { sessionId: 'kairos-weekly-digest', workingDir: PROJECT_ROOT, config: {} as unknown, logger: log };
      const result = await arsenalTool.execute({ task, mode, applyEdits: false }, ctx as never);
      const edits = ((result.data as { proposedEdits?: DigestEdit[] } | undefined)?.proposedEdits) ?? [];
      return { report: String(result.output || ''), edits };
    },
    consumeBudget: consumeKairosRepairBudget,
    git: defaultGit,
  };
}

/** Run the weekly digest. Never throws. */
export async function runKairosWeeklyDigest(deps: WeeklyDigestDeps): Promise<WeeklyDigestSummary> {
  const summary: WeeklyDigestSummary = {
    observations: 0, analysesRun: 0, analysesSkipped: 0, editsProposed: 0, branch: null, budgetHalted: false,
  };
  try {
    const all = await deps.observe();
    // One analysis per observation class, matching the old trigger surface.
    const actionable = all.filter(o => o.type === 'large_file' || o.type === 'codebase_degraded');
    summary.observations = actionable.length;
    if (actionable.length === 0) {
      log.info('weekly digest: no actionable observations — codebase clean');
      return summary;
    }
    const analyses: DigestAnalysis[] = [];
    for (const obs of actionable) {
      const budget = deps.consumeBudget();
      if (!budget.allowed) {
        summary.budgetHalted = true;
        summary.analysesSkipped++;
        log.warn({ used: budget.used, max: budget.max }, 'weekly digest: daily repair budget exhausted — halting gracefully');
        continue;
      }
      const mode: 'fix' | 'refactor' = obs.type === 'large_file' ? 'refactor' : 'fix';
      try {
        const { report, edits } = await deps.analyze(`KAIROS weekly digest: ${obs.message}`, mode);
        summary.analysesRun++;
        summary.editsProposed += edits.length;
        analyses.push({ observation: obs, mode, report, edits });
      } catch (err) {
        summary.analysesSkipped++;
        log.warn({ err: String(err), type: obs.type }, 'weekly digest: analysis failed (non-fatal)');
      }
    }
    if (analyses.some(a => a.edits.length > 0)) {
      summary.branch = commitDigestBranch(analyses, { git: deps.git, repoRoot: deps.repoRoot, now: deps.now });
      log.info({ branch: summary.branch, edits: summary.editsProposed }, 'weekly digest: branch committed');
    } else if (summary.analysesRun > 0) {
      log.info('weekly digest: analyses produced no edits — nothing to commit');
    }
    deps.notify?.(
      `KAIROS weekly digest: ${summary.analysesRun} analysis(es), ${summary.editsProposed} file(s) proposed`,
      summary.branch
        ? `Review branch ${summary.branch} (git diff main...${summary.branch}).${summary.budgetHalted ? ' Budget-halted.' : ''}`
        : `No branch created (no edits proposed${summary.budgetHalted ? '; budget-halted' : ''}).`,
    );
  } catch (err) {
    log.warn({ err: String(err) }, 'weekly digest failed (non-fatal)');
  }
  return summary;
}
