/**
 * @file self-improvement/frontier-miners.ts
 * @description AL10.2-10.5 — the scanners that feed the frontier ledger and
 * the human review ritual. Everything here SUGGESTS; nothing builds:
 *
 *   mineSignals            — SIGNALS.md rows (usage beyond design) → entries
 *   mineFailureClusters    — learning-store failure clusters → harden/replace
 *   mineEvalSaturation     — bench maxed → propose a harder objective
 *                            (AL10.4: objectives are config the system may
 *                            propose against but never edit)
 *   mineAbstractions       — recurring artifact/graph patterns → one general
 *                            engine (capability > feature, automated as
 *                            suggestion) + a draft ADR skeleton (AL10.3 —
 *                            always human-decided)
 *   buildReviewPack        — the quarterly pack for Frank (AL10.5): ranked
 *                            frontier + generational scorecard + saturation
 *   registerFrontierScanCron — monthly scan job, SUDO_AL_FRONTIER=1 gated
 *                            (default OFF — AL10.6 budget gate)
 *
 * All data arrives through injected seams (patterns, bench results, ledger
 * rows, graph summaries) — miners are pure over their inputs, deterministic,
 * and testable without prod state.
 */

import { createLogger } from '../shared/logger.js';
import type { CronJob } from '../cron/types.js';
import type { DetectedPatterns } from './pattern-detector.js';
import type { GenerationRow } from './generation-ledger.js';
import type { RetentionRow } from './retention-ledger.js';
import type { FrontierEntryInput, FrontierLedger } from './frontier-ledger.js';

const log = createLogger('self-improvement:frontier-miners');

// ---------------------------------------------------------------------------
// AL10.1 sources
// ---------------------------------------------------------------------------

/** Parse SIGNALS.md rows: `YYYY-MM-DD | observation | evidence | opportunity`. */
export function mineSignals(signalsMd: string): FrontierEntryInput[] {
  const out: FrontierEntryInput[] = [];
  for (const line of signalsMd.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    out.push({
      key: `signals:${m[1]}:${m[2]!.slice(0, 60)}`,
      signal: m[2]!,
      evidence: `${m[3]} (SIGNALS.md ${m[1]})`,
      proposedCapability: m[4]!,
      estCost: 3,
      estValue: 3,
      dependencies: [],
      source: 'signals',
    });
  }
  return out;
}

/** Failure clusters: a tool failing hard and often is a capability gap. */
export function mineFailureClusters(patterns: DetectedPatterns): FrontierEntryInput[] {
  return patterns.failingTools
    .filter((t) => t.failRate >= 0.3 && t.calls >= 5)
    .map((t) => ({
      key: `failure-cluster:${t.name}`,
      signal: `tool ${t.name} fails ${(t.failRate * 100).toFixed(0)}% over ${t.calls} calls`,
      evidence: `learning store window ${patterns.analysedAt.slice(0, 10)}: ${t.failures}/${t.calls} failures`,
      proposedCapability: `Harden or replace \`${t.name}\` (root-cause the dominant failure; consider a general engine if siblings share it)`,
      estCost: 2,
      estValue: Math.min(5, 2 + Math.round(t.failRate * 3)),
      dependencies: [],
      source: 'failure-cluster' as const,
    }));
}

export interface BenchSuiteResult {
  suite: string;
  passRate: number;
  tasks: number;
}

/** Saturation: a maxed bench means the objective stopped discriminating. */
export function mineEvalSaturation(results: BenchSuiteResult[]): FrontierEntryInput[] {
  return results
    .filter((r) => r.passRate >= 0.95 && r.tasks >= 5)
    .map((r) => ({
      key: `eval-saturation:${r.suite}`,
      signal: `bench suite "${r.suite}" saturated at ${(r.passRate * 100).toFixed(0)}% over ${r.tasks} tasks`,
      evidence: `objective exhausted — the suite no longer discriminates improvements`,
      proposedCapability: `Propose a harder objective for "${r.suite}" (new task classes from AL9.4 candidates); objectives are config the system proposes against, never edits`,
      estCost: 2,
      estValue: 4,
      dependencies: ['AL9.4 candidate eval cases'],
      source: 'objective-saturation' as const,
    }));
}

// ---------------------------------------------------------------------------
// AL10.2 abstraction miner + AL10.3 draft ADR
// ---------------------------------------------------------------------------

export interface GraphSummarySeam {
  /** e.g. graphify god nodes: name + degree. */
  godNodes: Array<{ name: string; degree: number }>;
}

export function mineAbstractions(deps: {
  generations: GenerationRow[];
  retention: RetentionRow[];
  graph?: GraphSummarySeam;
}): FrontierEntryInput[] {
  const out: FrontierEntryInput[] = [];

  // N ≥ 3 adoptions of the same artifact type → the pattern wants an engine.
  const byType = new Map<string, number>();
  for (const r of deps.retention) byType.set(r.artifactType, (byType.get(r.artifactType) ?? 0) + 1);
  for (const [type, n] of byType) {
    if (n < 3) continue;
    out.push({
      key: `abstraction:artifact:${type}`,
      signal: `${n} adopted improvements of the same artifact type "${type}"`,
      evidence: `retention ledger: ${n} rows share artifactType=${type} — recurring shape, not a one-off`,
      proposedCapability: `Generalize the "${type}" pattern into one reusable engine (capability > feature; engine > workflow)`,
      estCost: 3,
      estValue: 4,
      dependencies: ['AL8 pipeline', 'AL9.3 generation ledger'],
      source: 'abstraction-miner',
    });
  }

  // God nodes → restructure suggestion (AL10.3: draft ADR, human-decided).
  for (const g of deps.graph?.godNodes ?? []) {
    if (g.degree < 50) continue;
    out.push({
      key: `abstraction:god-node:${g.name}`,
      signal: `graph god node "${g.name}" (degree ${g.degree})`,
      evidence: `graphify community data: ${g.name} concentrates ${g.degree} edges`,
      proposedCapability: `Restructure: split "${g.name}" along its communities (draft ADR attached; mechanical refactor only AFTER ADR approval, through the AL8 pipeline)`,
      estCost: 4,
      estValue: 3,
      dependencies: ['ADR approval'],
      source: 'abstraction-miner',
    });
  }
  return out;
}

/** AL10.3: an ADR skeleton for a frontier entry — a draft for a HUMAN to finish. */
export function draftAdr(entry: FrontierEntryInput): string {
  return [
    `# ADR (DRAFT — machine-proposed, human-decided): ${entry.proposedCapability}`,
    '',
    `## Problem`,
    `${entry.signal}. Evidence: ${entry.evidence}`,
    '',
    `## Alternatives`,
    `- Do nothing (status quo; the signal persists)`,
    `- ${entry.proposedCapability}`,
    `- <human: add at least one more alternative before deciding>`,
    '',
    `## Decision`,
    `<human decision required — this draft carries NO authority>`,
    '',
    `## Tradeoffs`,
    `Estimated cost ${entry.estCost}/5, value ${entry.estValue}/5. Dependencies: ${entry.dependencies.join(', ') || 'none'}.`,
    '',
    `## Consequences`,
    `<human: fill after decision>`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// AL10.5 review pack + AL10.6 cron (flag-OFF)
// ---------------------------------------------------------------------------

export function buildReviewPack(deps: {
  ledger: FrontierLedger;
  generations?: GenerationRow[];
  saturation?: BenchSuiteResult[];
}): string {
  const open = deps.ledger
    .list('open')
    .sort((a, b) => b.estValue / b.estCost - a.estValue / a.estCost);
  return [
    `# Quarterly frontier review pack (AL10.5) — ${new Date().toISOString().slice(0, 10)}`,
    '',
    'The loop closes through the human: your picks become normal roadmap features with IDs.',
    '',
    `## Frontier (ranked, ${open.length} open)`,
    ...open.map((e, i) => `${i + 1}. [value ${e.estValue}/cost ${e.estCost}] ${e.proposedCapability} — ${e.signal} (${e.source})`),
    '',
    '## Generational scorecard (AL9.3)',
    ...(deps.generations?.map((g) =>
      `- manifest ${g.manifestVersion}: ${g.proposals} proposals, ${g.adopted} adopted, Δ ${g.meanScoreDelta?.toFixed(3) ?? 'n/a'}, ${g.flagged} flagged`) ?? ['- (no generations recorded yet)']),
    '',
    '## Saturation report',
    ...(deps.saturation?.map((s) => `- ${s.suite}: ${(s.passRate * 100).toFixed(0)}% over ${s.tasks} tasks${s.passRate >= 0.95 ? ' — SATURATED' : ''}`) ?? ['- (no bench results supplied)']),
    '',
  ].join('\n');
}

export const FRONTIER_SCAN_JOB_NAME = 'AL10 frontier scan (monthly)';

interface SchedulerLike {
  listJobs(): CronJob[];
  removeJob(id: string): void;
  addJob(job: Omit<CronJob, 'id'> & { id: string }): CronJob;
}

/** Monthly scan job — SUDO_AL_FRONTIER=1 gated, default OFF (AL10.6 budget gate). */
export function registerFrontierScanCron(scheduler: SchedulerLike): CronJob {
  const enabled = process.env['SUDO_AL_FRONTIER'] === '1';
  for (const job of scheduler.listJobs()) {
    if (job.name === FRONTIER_SCAN_JOB_NAME) scheduler.removeJob(job.id);
  }
  const job = scheduler.addJob({
    id: 'al10-frontier-scan',
    name: FRONTIER_SCAN_JOB_NAME,
    schedule: { kind: 'cron', expr: '0 5 2 * *', tz: 'UTC' },
    payload: {
      kind: 'agentTurn',
      message:
        '[AL10 frontier scan] Run the frontier miners (mineSignals over SIGNALS.md, mineFailureClusters over detectPatterns, ' +
        'mineEvalSaturation over the latest bench, mineAbstractions over retention+generation ledgers), append NEW entries to ' +
        'the frontier ledger, sync docs/FRONTIER.md, and report the count. SUGGEST ONLY — never build from a frontier entry.',
    },
    sessionTarget: 'isolated',
    enabled,
    consecutiveErrors: 0,
  } satisfies Omit<CronJob, 'id'> & { id: string });
  log.info({ jobId: job.id, enabled }, `Registered cron job: ${FRONTIER_SCAN_JOB_NAME}`);
  return job;
}
