/**
 * @file ladder.ts
 * @description ADR-0002 Verifiability Ladder — golden sets, rung grading
 * engines (0–1), and admission verdicts. The eval-sandbox platform (ADR-0007)
 * is the ladder's engine: this module runs a rung's golden set against a route
 * and returns an admission verdict cached per (route, model, rung, version).
 *
 * Rungs 0–3 are code-graded, 4–5 judged (invariant 7 — see judge.ts). Rungs 2–5
 * are NOT implemented here: they need the math/tolerance, sandboxed-unit-test,
 * and judged-completion engines that ADR-0002 scopes as later slices. They
 * return an explicit `notImplemented` verdict — never a fake pass.
 *
 * Budget (invariant 10): SUDO_EVAL_LADDER_MAX_USD (default $1.00) caps a run;
 * exhaustion halts gracefully with partial results and `haltedOnBudget: true`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../shared/paths.js';
import { estimateCostUsd } from '../../../llm/limits.js';
import { isEmptyReply } from '../../channels/empty-reply.js';
import type { IRContentBlock, IRTool } from '../../../../shared-types/ir/v1.js';
import { gradeRung0, gradeRung1, gradeRung2, type GradeOutcome } from './ladder-graders.js';

const log = createLogger('eval:ladder');

/** One golden-set item. `expect` is a rung-specific check descriptor. */
export interface GoldenItem {
  id: string;
  input: string;
  expect: Record<string, unknown>;
  /** Rung-1 only: tool schemas offered to the model for this item. */
  tools?: IRTool[];
}

export interface GoldenSet {
  /** Bumped when any item changes — invalidates cached verdicts (ADR-0002). */
  version: string;
  items: GoldenItem[];
}

/**
 * Admission thresholds (ADR-0002 "Admission thresholds"). The ADR states these
 * are policy data (`config/sudo-ai.json5 → evals.ladder`); these are the ADR's
 * documented initial values used as defaults until that config block exists.
 */
export const RUNG_THRESHOLDS: Record<number, { passRate: number; minN: number }> = {
  0: { passRate: 1.0, minN: 50 },   // brain-chain entry: 100% (n>=50)
  1: { passRate: 0.99, minN: 100 }, // tool-call contract: >=99% (n>=100)
  2: { passRate: 0.95, minN: 30 },  // judge eligibility: >=95%
  3: { passRate: 0.85, minN: 30 },  // code-task routing: >=85% (n>=30)
  4: { passRate: 0.9, minN: 20 },   // tool-task completion: >=90% (n>=20)
  5: { passRate: 0.9, minN: 20 },   // self-consistency: >=90%
};

/** Rungs with a code-graded engine implemented here. */
export const IMPLEMENTED_RUNGS = [0, 1, 2] as const;

export interface LadderItemResult {
  id: string;
  passed: boolean;
  detail: string;
  /** Repeat index (0-based) — items are repeated to reach the ADR's minN. */
  repeat: number;
}

export interface LadderRungReport {
  rung: number;
  route: string;
  goldenSetVersion: string;
  n: number;
  passed: number;
  failed: number;
  passRate: number;
  threshold: number;
  minN: number;
  admitted: boolean;
  /** Why admission was refused despite the pass rate (e.g. thin sample). */
  reason?: string;
  notImplemented?: boolean;
  haltedOnBudget?: boolean;
  spentUsd: number;
  results: LadderItemResult[];
}

/** Per-run ladder spend cap in USD (SUDO_EVAL_LADDER_MAX_USD, default 1.00). */
export function ladderBudgetUsd(): number {
  const n = Number(process.env['SUDO_EVAL_LADDER_MAX_USD']);
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

/** Golden-set path for a rung (repo-relative layout per ADR-0002). */
export function goldenSetPath(rung: number): string {
  return join(PROJECT_ROOT, 'evals', 'ladder', `rung-${rung}`, 'golden.json');
}

/**
 * Load + strictly validate a rung's golden set. Throws on a missing file or any
 * malformed item — an admission gate must never grade against a silently
 * half-loaded set. Accepts both the versioned object form
 * `{version, items:[...]}` and a bare array (version "1", the Phase-4 format).
 */
export function loadGoldenSet(rung: number): GoldenSet {
  const path = goldenSetPath(rung);
  if (!existsSync(path)) {
    throw new Error(`ladder: no golden set for rung ${rung} (expected ${path})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`ladder: golden set ${path} is not valid JSON: ${String(err)}`);
  }

  let version = '1';
  let items: unknown;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw !== null && typeof raw === 'object') {
    const obj = raw as { version?: unknown; items?: unknown };
    if (typeof obj.version !== 'string' || obj.version === '') {
      throw new Error(`ladder: ${path}.version must be a non-empty string`);
    }
    version = obj.version;
    items = obj.items;
  } else {
    throw new Error(`ladder: ${path} must be an array or {version, items}`);
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`ladder: golden set ${path} must have a non-empty items array`);
  }
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const it = item as Partial<GoldenItem> | null;
    if (it === null || typeof it !== 'object') throw new Error(`ladder: ${path}[${i}] is not an object`);
    if (typeof it.id !== 'string' || it.id === '') throw new Error(`ladder: ${path}[${i}].id must be a non-empty string`);
    if (seen.has(it.id)) throw new Error(`ladder: ${path} has duplicate id '${it.id}'`);
    seen.add(it.id);
    if (typeof it.input !== 'string' || it.input === '') throw new Error(`ladder: ${path}[${i}].input must be a non-empty string`);
    if (it.expect === null || typeof it.expect !== 'object' || Array.isArray(it.expect) || Object.keys(it.expect).length === 0) {
      throw new Error(`ladder: ${path}[${i}].expect must be a non-empty object`);
    }
    if (it.tools !== undefined && (!Array.isArray(it.tools) || it.tools.length === 0)) {
      throw new Error(`ladder: ${path}[${i}].tools must be a non-empty array when present`);
    }
  }
  return { version, items: items as GoldenItem[] };
}

// ---------------------------------------------------------------------------
// Verdict cache — gateway.db, keyed per ADR-0002
// ---------------------------------------------------------------------------

const CACHE_DDL = `
CREATE TABLE IF NOT EXISTS ladder_verdicts (
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  rung INTEGER NOT NULL,
  golden_set_version TEXT NOT NULL,
  admitted INTEGER NOT NULL,
  pass_rate REAL NOT NULL,
  n INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (route, model, rung, golden_set_version)
)`;

function openGatewayDb(dbPath?: string): Database.Database {
  const db = new Database(dbPath ?? dataPath('gateway.db'));
  db.exec(CACHE_DDL);
  return db;
}

/** Persist a verdict (ADR-0002: cached per route, model, rung, set version). */
export function cacheVerdict(report: LadderRungReport, dbPath?: string): void {
  try {
    const db = openGatewayDb(dbPath);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO ladder_verdicts
         (route, model, rung, golden_set_version, admitted, pass_rate, n, report_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        report.route,
        report.route,
        report.rung,
        report.goldenSetVersion,
        report.admitted ? 1 : 0,
        report.passRate,
        report.n,
        JSON.stringify(report),
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
  } catch (err) {
    // Caching is telemetry; the returned report is authoritative.
    log.warn({ err: String(err), rung: report.rung }, 'ladder: verdict cache write failed');
  }
}

/** Read a cached verdict, or null when absent/unreadable. */
export function readCachedVerdict(
  route: string,
  rung: number,
  goldenSetVersion: string,
  dbPath?: string,
): LadderRungReport | null {
  try {
    const db = openGatewayDb(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT report_json FROM ladder_verdicts
           WHERE route = ? AND rung = ? AND golden_set_version = ?`,
        )
        .get(route, rung, goldenSetVersion) as { report_json: string } | undefined;
      return row === undefined ? null : (JSON.parse(row.report_json) as LadderRungReport);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rung runner
// ---------------------------------------------------------------------------

export interface LadderCallResult {
  blocks: IRContentBlock[];
  usage: { in: number; out: number };
  stopReason: string;
}

export interface LadderRunOptions {
  /** Repeats × items = n. Default 1 (cheap smoke run, below the ADR's minN). */
  repeats?: number;
  /** Injected route call for tests. Default: callIR with caller 'eval-ladder'. */
  callRoute?: (route: string, item: GoldenItem) => Promise<LadderCallResult>;
  /** gateway.db path override (tests). */
  cacheDbPath?: string;
  /** Skip the verdict cache write (tests / dry runs). */
  noCache?: boolean;
}

async function defaultCallRoute(route: string, item: GoldenItem): Promise<LadderCallResult> {
  const { callIR } = await import('../../../llm/transport.js');
  const res = await callIR({
    alias: route,
    caller: 'eval-ladder',
    purpose: `ladder golden item ${item.id}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: item.input }] }],
    ...(item.tools !== undefined ? { tools: item.tools } : {}),
    priority: 'background',
    trace_id: '',
    max_tokens: 512,
  });
  return { blocks: res.blocks, usage: { in: res.usage.in, out: res.usage.out }, stopReason: res.stop_reason };
}

function gradeItem(rung: number, item: GoldenItem, call: LadderCallResult): GradeOutcome {
  if (call.stopReason === 'error') {
    return { passed: false, detail: 'route returned stop_reason=error' };
  }
  if (rung === 1) return gradeRung1(item.expect, call.blocks);
  const textOf = (): string =>
    call.blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  if (rung === 2) return gradeRung2(item.expect, textOf());
  // Rung 0 uses the delivery layer's OWN emptiness predicate (isEmptyReply —
  // the #751 content-filter empty-STRING class). Deliberately NOT
  // normalizeReplyText: that substitutes a fallback message for an empty
  // reply, which would mask the exact failure this rung exists to catch.
  const raw = call.blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (isEmptyReply(raw)) return { passed: false, detail: 'empty reply (isEmptyReply)' };
  return gradeRung0(item.expect, raw);
}

/**
 * Run a ladder rung against a route and return an admission verdict.
 *
 * Admission requires BOTH the ADR-0002 pass-rate threshold AND its minimum
 * sample size: a thin sample is never admitted, however perfect its rate.
 */
export async function runLadderRung(
  rung: number,
  route: string,
  opts: LadderRunOptions = {},
): Promise<LadderRungReport> {
  const threshold = RUNG_THRESHOLDS[rung] ?? { passRate: 1, minN: 1 };

  if (!(IMPLEMENTED_RUNGS as readonly number[]).includes(rung)) {
    // ADR-0002: rungs 2-5 need math/tolerance, sandboxed-unit-test and judged
    // engines — later slices. Never fake a verdict for them.
    return {
      rung, route, goldenSetVersion: '', n: 0, passed: 0, failed: 0, passRate: 0,
      threshold: threshold.passRate, minN: threshold.minN, admitted: false,
      reason: `rung ${rung} grading engine not implemented (ADR-0002 later slice)`,
      notImplemented: true, spentUsd: 0, results: [],
    };
  }

  const set = loadGoldenSet(rung);
  const repeats = Math.max(1, Math.floor(opts.repeats ?? 1));
  const call = opts.callRoute ?? defaultCallRoute;
  const budget = ladderBudgetUsd();

  const results: LadderItemResult[] = [];
  let spentUsd = 0;
  let haltedOnBudget = false;

  outer: for (let r = 0; r < repeats; r++) {
    for (const item of set.items) {
      if (spentUsd >= budget) {
        haltedOnBudget = true;
        log.warn({ rung, route, spentUsd, budget }, 'ladder: budget exhausted — halting');
        break outer;
      }
      let outcome: GradeOutcome;
      try {
        const res = await call(route, item);
        spentUsd += estimateCostUsd(route, res.usage.in, res.usage.out);
        outcome = gradeItem(rung, item, res);
      } catch (err) {
        // A failed call is a FAILED item, not a crashed run: an unreachable or
        // erroring route is exactly what admission must refuse.
        outcome = { passed: false, detail: `call failed: ${String(err).slice(0, 200)}` };
      }
      results.push({ id: item.id, passed: outcome.passed, detail: outcome.detail, repeat: r });
    }
  }

  const n = results.length;
  const passed = results.filter((x) => x.passed).length;
  const failed = n - passed;
  const passRate = n === 0 ? 0 : passed / n;

  let admitted = passRate >= threshold.passRate && n >= threshold.minN;
  let reason: string | undefined;
  if (n < threshold.minN) {
    admitted = false;
    reason = `insufficientSample: n=${n} < required ${threshold.minN} (ADR-0002) — run with --repeats to reach it`;
  } else if (passRate < threshold.passRate) {
    reason = `passRate ${(passRate * 100).toFixed(1)}% < required ${(threshold.passRate * 100).toFixed(1)}%`;
  }
  if (haltedOnBudget) {
    admitted = false;
    reason = reason ?? `halted on budget ($${budget.toFixed(2)}) with a partial sample`;
  }

  const report: LadderRungReport = {
    rung, route, goldenSetVersion: set.version, n, passed, failed, passRate,
    threshold: threshold.passRate, minN: threshold.minN, admitted,
    ...(reason !== undefined ? { reason } : {}),
    ...(haltedOnBudget ? { haltedOnBudget: true } : {}),
    spentUsd, results,
  };
  if (opts.noCache !== true) cacheVerdict(report, opts.cacheDbPath);
  return report;
}
