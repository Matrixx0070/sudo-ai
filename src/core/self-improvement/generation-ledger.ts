/**
 * @file self-improvement/generation-ledger.ts
 * @description AL9.3 generation ledger — lineage from manifest version to
 * outcomes. Every pipeline proposal is stamped with its manifest version
 * (AL9.5 pin) and every adoption lands a retention row; this module DERIVES
 * the generational scorecard from those two existing stores rather than
 * keeping a third copy of the truth (no parallel plumbing):
 *
 *   manifest vN → proposals made under vN → adoptions + their score deltas
 *   → flagged-on-recheck count → the evidence a meta-proposal must cite.
 *
 * AL9.4 eval self-expansion rides beside it: the ONE recursion allowed to
 * run semi-autonomously — observed prod failures become CANDIDATE eval
 * cases in a review queue. Candidates are ADDITIVE ONLY: this module has no
 * removal or weakening API by construction (never-weaken-tests rule);
 * accepting a candidate means a human writes the real test in a normal PR.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { AgentConfigProposal } from '../shared/wave10-types.js';
import type { RetentionRow } from './retention-ledger.js';
import type { DetectedPatterns } from './pattern-detector.js';

const log = createLogger('self-improvement:generations');

// ---------------------------------------------------------------------------
// AL9.3 — generational scorecard (derived, no new source of truth)
// ---------------------------------------------------------------------------

export interface GenerationRow {
  manifestVersion: string;
  proposals: number;
  byStatus: Record<string, number>;
  adopted: number;
  /** Mean (candidateScore - baselineScore) over this generation's adoptions. */
  meanScoreDelta: number | null;
  /** Adoptions later FLAGGED by the quarterly recheck. */
  flagged: number;
}

export interface GenerationScorecard {
  generatedAt: string;
  generations: GenerationRow[];
}

export function buildGenerationScorecard(deps: {
  /** All pipeline proposals (ProposalStore.list page-through result). */
  proposals: AgentConfigProposal[];
  /** Retention rows (RetentionLedger.list()). */
  retention: RetentionRow[];
}): GenerationScorecard {
  const byVersion = new Map<string, GenerationRow>();
  const rowFor = (v: string): GenerationRow => {
    let r = byVersion.get(v);
    if (!r) {
      r = { manifestVersion: v, proposals: 0, byStatus: {}, adopted: 0, meanScoreDelta: null, flagged: 0 };
      byVersion.set(v, r);
    }
    return r;
  };

  const versionOfProposal = new Map<string, string>();
  for (const p of deps.proposals) {
    if (!p.agentId?.startsWith('pipeline:')) continue; // only pipeline lineage
    const v = String((p.delta as { manifestVersion?: string })?.manifestVersion ?? 'pre-manifest');
    versionOfProposal.set(p.id, v);
    const r = rowFor(v);
    r.proposals++;
    r.byStatus[p.status] = (r.byStatus[p.status] ?? 0) + 1;
  }

  const deltas = new Map<string, number[]>();
  for (const ret of deps.retention) {
    const v = versionOfProposal.get(ret.proposalId) ?? 'pre-manifest';
    const r = rowFor(v);
    r.adopted++;
    if (ret.recheckStatus === 'flagged') r.flagged++;
    const arr = deltas.get(v) ?? [];
    arr.push(ret.candidateScore - ret.baselineScore);
    deltas.set(v, arr);
  }
  for (const [v, arr] of deltas) {
    rowFor(v).meanScoreDelta = arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  const generations = [...byVersion.values()].sort((a, b) =>
    a.manifestVersion.localeCompare(b.manifestVersion, undefined, { numeric: true }),
  );
  return { generatedAt: new Date().toISOString(), generations };
}

// ---------------------------------------------------------------------------
// AL9.4 — eval self-expansion (additive-only review queue)
// ---------------------------------------------------------------------------

export interface CandidateEvalCase {
  id: number;
  /** Stable dedup key, e.g. `tool-failure:browser.scrape`. */
  key: string;
  title: string;
  source: 'tool-failure' | 'bad-feedback';
  /** What the human-authored eval case should exercise. */
  sketch: string;
  evidence: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

interface CandidateRow {
  id: number;
  key: string;
  title: string;
  source: string;
  sketch: string;
  evidence: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const toCase = (r: CandidateRow): CandidateEvalCase => ({
  id: r.id,
  key: r.key,
  title: r.title,
  source: r.source as CandidateEvalCase['source'],
  sketch: r.sketch,
  evidence: r.evidence,
  status: r.status as CandidateEvalCase['status'],
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
});

/**
 * Review queue for candidate eval cases. ADDITIVE ONLY by construction:
 * there is no API to remove or weaken existing eval cases here — accepting
 * a candidate means a HUMAN writes the real test in a normal PR; rejecting
 * just closes the suggestion. The queue is the weekly-review artifact.
 */
export class EvalExpansionQueue {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_eval_cases (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL UNIQUE,
        title      TEXT NOT NULL,
        source     TEXT NOT NULL CHECK (source IN ('tool-failure','bad-feedback')),
        sketch     TEXT NOT NULL,
        evidence   TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        decided_at TEXT,
        decided_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cec_status ON candidate_eval_cases(status);
    `);
  }

  /**
   * Mine candidates from detectPatterns output. Deduped by key — a failure
   * that already has a pending/decided candidate is not re-proposed.
   * Returns the number of NEW candidates queued.
   */
  proposeFromPatterns(patterns: DetectedPatterns): number {
    let added = 0;
    const insert = this.db.prepare(`
      INSERT INTO candidate_eval_cases (key, title, source, sketch, evidence)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING
    `);
    for (const t of patterns.failingTools) {
      const info = insert.run(
        `tool-failure:${t.name}`,
        `Eval case: ${t.name} failure mode`,
        'tool-failure',
        `Reproduce the dominant failure of \`${t.name}\` as a bench task; assert the agent recovers or degrades gracefully.`,
        `failRate ${(t.failRate * 100).toFixed(0)}% (${t.failures}/${t.calls} calls), window ${patterns.analysedAt.slice(0, 10)}`,
      );
      added += info.changes;
    }
    for (const f of patterns.badFeedbackTypes) {
      const info = insert.run(
        `bad-feedback:${f.taskType}`,
        `Eval case: "${f.taskType}" quality bar`,
        'bad-feedback',
        `Add a verifier-scored task for "${f.taskType}" capturing what the owner rated bad.`,
        `owner feedback pattern, window ${patterns.analysedAt.slice(0, 10)}`,
      );
      added += info.changes;
    }
    if (added > 0) log.info({ added }, 'candidate eval cases queued for human review');
    return added;
  }

  listPending(): CandidateEvalCase[] {
    return (this.db.prepare(`SELECT * FROM candidate_eval_cases WHERE status = 'pending' ORDER BY id`).all() as CandidateRow[]).map(toCase);
  }

  list(): CandidateEvalCase[] {
    return (this.db.prepare(`SELECT * FROM candidate_eval_cases ORDER BY id`).all() as CandidateRow[]).map(toCase);
  }

  /** Human decision. Accepting means: now write the real test in a PR. */
  decide(id: number, accepted: boolean, decidedBy: string): CandidateEvalCase {
    const info = this.db.prepare(`
      UPDATE candidate_eval_cases
      SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(accepted ? 'accepted' : 'rejected', decidedBy, id);
    if (info.changes === 0) throw new Error(`EvalExpansionQueue: candidate ${id} missing or already decided`);
    return toCase(this.db.prepare(`SELECT * FROM candidate_eval_cases WHERE id = ?`).get(id) as CandidateRow);
  }

  close(): void {
    this.db.close();
  }
}
