/**
 * @file self-improvement/frontier-ledger.ts
 * @description AL10.1 frontier ledger — the machine-appended opportunity
 * store behind docs/FRONTIER.md. AL10 ships as a PROPOSAL ENGINE, not an
 * autonomous builder: open-endedness lives in what this ledger can SUGGEST;
 * Frank owns what gets built (AL10.5 closes the loop through the human).
 *
 * Entries carry signal, evidence, a proposed capability, cost/value
 * estimates, and dependencies. Statuses: open → picked (becomes a normal
 * roadmap feature with an ID) or declined. Nothing here executes anything.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('self-improvement:frontier');

export type FrontierSource =
  | 'signals'
  | 'failure-cluster'
  | 'eval-saturation'
  | 'abstraction-miner'
  | 'objective-saturation'
  | 'model-delta'
  | 'manual';

export interface FrontierEntryInput {
  /** Stable dedup key (e.g. 'failure-cluster:browser.scrape'). */
  key: string;
  signal: string;
  evidence: string;
  proposedCapability: string;
  /** Rough effort/cost scale 1 (trivial) … 5 (campaign). */
  estCost: number;
  /** Rough value scale 1 … 5. */
  estValue: number;
  dependencies: string[];
  source: FrontierSource;
}

export interface FrontierEntry extends FrontierEntryInput {
  id: number;
  status: 'open' | 'picked' | 'declined';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Roadmap feature id assigned when picked (e.g. 'F131'). */
  featureId: string | null;
}

interface Row {
  id: number;
  key: string;
  signal: string;
  evidence: string;
  proposed_capability: string;
  est_cost: number;
  est_value: number;
  dependencies: string;
  source: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  feature_id: string | null;
}

const toEntry = (r: Row): FrontierEntry => ({
  id: r.id,
  key: r.key,
  signal: r.signal,
  evidence: r.evidence,
  proposedCapability: r.proposed_capability,
  estCost: r.est_cost,
  estValue: r.est_value,
  dependencies: JSON.parse(r.dependencies) as string[],
  source: r.source as FrontierSource,
  status: r.status as FrontierEntry['status'],
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  featureId: r.feature_id,
});

export class FrontierLedger {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS frontier_entries (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        key                 TEXT NOT NULL UNIQUE,
        signal              TEXT NOT NULL,
        evidence            TEXT NOT NULL,
        proposed_capability TEXT NOT NULL,
        est_cost            INTEGER NOT NULL,
        est_value           INTEGER NOT NULL,
        dependencies        TEXT NOT NULL DEFAULT '[]',
        source              TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','picked','declined')),
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        decided_at          TEXT,
        decided_by          TEXT,
        feature_id          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fe_status ON frontier_entries(status);
    `);
  }

  /** Append (deduped by key). Fail-loud on garbage; returns true when new. */
  append(e: FrontierEntryInput): boolean {
    for (const [k, v] of [['signal', e.signal], ['evidence', e.evidence], ['proposedCapability', e.proposedCapability], ['key', e.key]] as const) {
      if (typeof v !== 'string' || !v.trim()) throw new Error(`FrontierLedger: ${k} must be a non-empty string`);
    }
    for (const [k, v] of [['estCost', e.estCost], ['estValue', e.estValue]] as const) {
      if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`FrontierLedger: ${k} must be an integer 1..5`);
    }
    const info = this.db.prepare(`
      INSERT INTO frontier_entries (key, signal, evidence, proposed_capability, est_cost, est_value, dependencies, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING
    `).run(e.key, e.signal, e.evidence, e.proposedCapability, e.estCost, e.estValue, JSON.stringify(e.dependencies), e.source);
    if (info.changes > 0) log.info({ key: e.key, source: e.source }, 'frontier entry appended');
    return info.changes > 0;
  }

  list(status?: FrontierEntry['status']): FrontierEntry[] {
    const rows = (status
      ? this.db.prepare(`SELECT * FROM frontier_entries WHERE status = ? ORDER BY id`).all(status)
      : this.db.prepare(`SELECT * FROM frontier_entries ORDER BY id`).all()) as Row[];
    return rows.map(toEntry);
  }

  /** Frank's pick: entry becomes a normal roadmap feature (id required). */
  pick(id: number, decidedBy: string, featureId: string): FrontierEntry {
    return this.decide(id, 'picked', decidedBy, featureId);
  }

  decline(id: number, decidedBy: string): FrontierEntry {
    return this.decide(id, 'declined', decidedBy, null);
  }

  private decide(id: number, status: 'picked' | 'declined', decidedBy: string, featureId: string | null): FrontierEntry {
    const info = this.db.prepare(`
      UPDATE frontier_entries
      SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ?, feature_id = ?
      WHERE id = ? AND status = 'open'
    `).run(status, decidedBy, featureId, id);
    if (info.changes === 0) throw new Error(`FrontierLedger: entry ${id} missing or already decided`);
    return toEntry(this.db.prepare(`SELECT * FROM frontier_entries WHERE id = ?`).get(id) as Row);
  }

  /** Render docs/FRONTIER.md content — ranked open entries + decided tail. */
  renderMarkdown(): string {
    const open = this.list('open').sort(
      (a, b) => b.estValue / b.estCost - a.estValue / a.estCost || a.id - b.id,
    );
    const decided = [...this.list('picked'), ...this.list('declined')];
    const lines = [
      '# FRONTIER — machine-proposed capability directions (AL10.1)',
      '',
      'Proposal engine output. The system suggests; Frank decides (AL10.5).',
      'Ranked by est. value / est. cost. Statuses move only by human decision.',
      '',
      '## Open',
      '| # | signal | proposed capability | value | cost | source | evidence |',
      '|---|--------|--------------------|-------|------|--------|----------|',
      ...open.map((e) =>
        `| ${e.id} | ${e.signal} | ${e.proposedCapability} | ${e.estValue} | ${e.estCost} | ${e.source} | ${e.evidence.slice(0, 120)} |`),
      '',
      '## Decided',
      ...decided.map((e) => `- #${e.id} ${e.status.toUpperCase()}${e.featureId ? ` as ${e.featureId}` : ''} by ${e.decidedBy}: ${e.signal}`),
      '',
    ];
    return lines.join('\n');
  }

  /** Write docs/FRONTIER.md (the human-facing mirror of the store). */
  syncMarkdown(filePath: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, this.renderMarkdown(), 'utf-8');
  }

  close(): void {
    this.db.close();
  }
}
