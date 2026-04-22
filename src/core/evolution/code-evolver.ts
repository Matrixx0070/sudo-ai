/**
 * CodeEvolver — SUDO analyzes and improves its own codebase.
 *
 * Capabilities:
 *   - Codebase analysis delegated to analyzer.ts (filesystem + regex)
 *   - Evolution proposal generation persisted to mind.db
 *   - Capability discovery logging for novel tool combinations
 *   - Numeric performance metric timeseries
 *
 * All DB access uses better-sqlite3 synchronous API with named parameters only.
 * No string interpolation in SQL statements.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { analyzeAll, collectFiles } from './analyzer.js';

const logger = createLogger('code-evolver');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodeAnalysis {
  file: string;
  lines: number;
  issues: CodeIssue[];
  complexity: number;
  lastModified: string;
}

export interface CodeIssue {
  type:
    | 'unused_export'
    | 'large_file'
    | 'missing_error_handling'
    | 'hardcoded_value'
    | 'duplicate_code'
    | 'complex_function'
    | 'missing_types'
    | 'dead_code';
  severity: 'low' | 'medium' | 'high';
  file: string;
  line?: number;
  description: string;
  suggestedFix?: string;
}

export interface EvolutionProposal {
  id: string;
  title: string;
  description: string;
  files: string[];
  impact: 'performance' | 'reliability' | 'capability' | 'cost';
  effort: 'small' | 'medium' | 'large';
  status: 'proposed' | 'approved' | 'applied' | 'rejected';
  createdAt: string;
}

export interface CapabilityDiscovery {
  tools: string[];
  result: string;
  useful: boolean;
  discoveredAt: string;
}

export interface CodebaseStats {
  totalFiles: number;
  totalLines: number;
  avgFileSize: number;
  largestFiles: { file: string; lines: number }[];
  moduleCount: number;
  issueCount: number;
}

// ---------------------------------------------------------------------------
// DDL — all schema statements executed in _applyDdl
// ---------------------------------------------------------------------------

const DDL_STMTS = [
  `CREATE TABLE IF NOT EXISTS evolution_proposals (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, files TEXT DEFAULT '[]', impact TEXT DEFAULT 'capability', effort TEXT DEFAULT 'medium', status TEXT DEFAULT 'proposed', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE TABLE IF NOT EXISTS capability_discoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, tools TEXT NOT NULL, result TEXT NOT NULL, useful INTEGER DEFAULT 0, discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE TABLE IF NOT EXISTS performance_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, metric TEXT NOT NULL, value REAL NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE INDEX IF NOT EXISTS idx_pm_metric ON performance_metrics(metric)`,
] as const;

// ---------------------------------------------------------------------------
// CodeEvolver
// ---------------------------------------------------------------------------

export class CodeEvolver {
  private readonly db: Database.Database;

  constructor(
    private readonly rootDir: string,
    private readonly dbPath: string,
  ) {
    if (!rootDir?.trim()) throw new TypeError('CodeEvolver: rootDir must be a non-empty string');
    if (!dbPath?.trim()) throw new TypeError('CodeEvolver: dbPath must be a non-empty string');

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this._applyDdl();
    logger.info({ rootDir, dbPath }, 'CodeEvolver initialised');
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _applyDdl(): void {
    for (const stmt of DDL_STMTS) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) logger.warn({ err: msg }, 'DDL warning');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Codebase analysis (delegates to analyzer.ts)
  // -------------------------------------------------------------------------

  async analyzeCodebase(): Promise<CodeAnalysis[]> {
    return analyzeAll(this.rootDir);
  }

  async findIssues(): Promise<CodeIssue[]> {
    logger.info('findIssues start');
    const analyses = await this.analyzeCodebase();
    const all: CodeIssue[] = analyses.flatMap(a => a.issues);
    logger.info({ issueCount: all.length }, 'findIssues complete');
    return all;
  }

  // -------------------------------------------------------------------------
  // Evolution proposals
  // -------------------------------------------------------------------------

  async proposeEvolution(): Promise<EvolutionProposal[]> {
    logger.info('proposeEvolution start');
    const issues = await this.findIssues();

    const toInsert: Omit<EvolutionProposal, 'createdAt'>[] = [];

    const largeFiles = issues.filter(i => i.type === 'large_file').map(i => i.file);
    if (largeFiles.length > 0) {
      toInsert.push({
        id: randomUUID(), title: `Split ${largeFiles.length} oversized file(s)`,
        description: 'Files exceeding 300-line limit reduce readability. Refactor into focused sub-modules.',
        files: largeFiles, impact: 'reliability', effort: largeFiles.length > 3 ? 'large' : 'medium', status: 'proposed',
      });
    }

    const noErrFiles = issues.filter(i => i.type === 'missing_error_handling').map(i => i.file);
    if (noErrFiles.length > 0) {
      toInsert.push({
        id: randomUUID(), title: `Add error handling to ${noErrFiles.length} file(s)`,
        description: 'Unprotected async functions throw uncaught exceptions. Wrap in try/catch.',
        files: noErrFiles, impact: 'reliability', effort: 'medium', status: 'proposed',
      });
    }

    const hardcodedFiles = [...new Set(issues.filter(i => i.type === 'hardcoded_value').map(i => i.file))];
    if (hardcodedFiles.length > 0) {
      toInsert.push({
        id: randomUUID(), title: `Extract hardcoded values in ${hardcodedFiles.length} file(s)`,
        description: 'Hardcoded URLs/tokens prevent config-based deployment. Move to env vars.',
        files: hardcodedFiles, impact: 'reliability', effort: 'small', status: 'proposed',
      });
    }

    const typeFiles = [...new Set(issues.filter(i => i.type === 'missing_types').map(i => i.file))];
    if (typeFiles.length > 0) {
      toInsert.push({
        id: randomUUID(), title: `Improve type safety in ${typeFiles.length} file(s)`,
        description: 'Excessive `any` usage defeats TypeScript. Replace with specific interfaces.',
        files: typeFiles, impact: 'reliability', effort: 'medium', status: 'proposed',
      });
    }

    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO evolution_proposals (id, title, description, files, impact, effort, status)
       VALUES (@id, @title, @description, @files, @impact, @effort, @status)`,
    );
    this.db.transaction((rows: typeof toInsert) => {
      for (const row of rows) insertStmt.run({ ...row, files: JSON.stringify(row.files) });
    })(toInsert);

    type ProposalRow = { id: string; title: string; description: string; files: string; impact: string; effort: string; status: string; created_at: string };
    const rows = this.db.prepare(
      `SELECT id, title, description, files, impact, effort, status, created_at FROM evolution_proposals ORDER BY created_at DESC`,
    ).all() as ProposalRow[];

    logger.info({ count: rows.length }, 'proposeEvolution complete');
    return rows.map(r => ({
      id: r.id, title: r.title, description: r.description,
      files: JSON.parse(r.files) as string[],
      impact: r.impact as EvolutionProposal['impact'],
      effort: r.effort as EvolutionProposal['effort'],
      status: r.status as EvolutionProposal['status'],
      createdAt: r.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Capability discovery
  // -------------------------------------------------------------------------

  async discoverCapabilities(): Promise<CapabilityDiscovery[]> {
    logger.info('discoverCapabilities start');
    const toolFiles = collectFiles(join(this.rootDir, 'src', 'core', 'tools', 'builtin'), '.ts');
    const toolNames = toolFiles.map(f => f.replace(this.rootDir, '').replace(/\\/g, '/'))
      .filter(f => !f.includes('index') && !f.includes('types'));

    if (toolNames.length >= 2) {
      const sample = toolNames.slice(0, 6);
      this.db.prepare(
        `INSERT INTO capability_discoveries (tools, result, useful) VALUES (@tools, @result, @useful)`,
      ).run({
        tools: JSON.stringify(sample),
        result: `Scanned ${toolNames.length} tool files. ${sample.length} sampled for cross-tool pattern discovery.`,
        useful: toolNames.length > 5 ? 1 : 0,
      });
    }

    type DiscoveryRow = { tools: string; result: string; useful: number; discovered_at: string };
    const rows = this.db.prepare(
      `SELECT tools, result, useful, discovered_at FROM capability_discoveries ORDER BY discovered_at DESC LIMIT 20`,
    ).all() as DiscoveryRow[];

    logger.info({ count: rows.length }, 'discoverCapabilities complete');
    return rows.map(r => ({
      tools: JSON.parse(r.tools) as string[],
      result: r.result,
      useful: r.useful === 1,
      discoveredAt: r.discovered_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Performance metrics
  // -------------------------------------------------------------------------

  async trackPerformance(metric: string, value: number): Promise<void> {
    if (!metric?.trim()) throw new TypeError('trackPerformance: metric must be a non-empty string');
    if (!Number.isFinite(value)) throw new TypeError('trackPerformance: value must be a finite number');
    this.db.prepare(`INSERT INTO performance_metrics (metric, value) VALUES (@metric, @value)`)
      .run({ metric: metric.trim(), value });
    logger.info({ metric, value }, 'Performance metric recorded');
  }

  async getPerformanceHistory(metric: string): Promise<{ value: number; timestamp: string }[]> {
    if (!metric?.trim()) throw new TypeError('getPerformanceHistory: metric must be a non-empty string');
    type MetricRow = { value: number; recorded_at: string };
    const rows = this.db.prepare(
      `SELECT value, recorded_at FROM performance_metrics WHERE metric = @metric ORDER BY recorded_at DESC LIMIT 100`,
    ).all({ metric: metric.trim() }) as MetricRow[];
    return rows.map(r => ({ value: r.value, timestamp: r.recorded_at }));
  }

  // -------------------------------------------------------------------------
  // Codebase stats
  // -------------------------------------------------------------------------

  async getStats(): Promise<CodebaseStats> {
    logger.info('getStats start');
    const analyses = await this.analyzeCodebase();
    if (analyses.length === 0) {
      return { totalFiles: 0, totalLines: 0, avgFileSize: 0, largestFiles: [], moduleCount: 0, issueCount: 0 };
    }
    const totalLines = analyses.reduce((s, a) => s + a.lines, 0);
    const issueCount = analyses.reduce((s, a) => s + a.issues.length, 0);
    const largestFiles = [...analyses].sort((a, b) => b.lines - a.lines).slice(0, 10)
      .map(a => ({ file: a.file, lines: a.lines }));
    const modules = new Set(analyses.map(a => a.file.split('/')[0] ?? a.file));

    const stats: CodebaseStats = {
      totalFiles: analyses.length,
      totalLines,
      avgFileSize: Math.round(totalLines / analyses.length),
      largestFiles,
      moduleCount: modules.size,
      issueCount,
    };
    logger.info(stats, 'getStats complete');
    return stats;
  }
}
