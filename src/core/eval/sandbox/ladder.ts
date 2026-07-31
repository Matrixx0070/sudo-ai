/**
 * @file ladder.ts
 * @description ADR-0002 Verifiability Ladder golden sets — format, loader, and
 * the rung-runner entry point (ADR-0007 Phase 4). Golden sets live under
 * evals/ladder/rung-<n>/golden.json as an array of {id, input, expect} items:
 * rung-0 = basic response validity probes, rung-1 = tool-schema conformance
 * shapes (rungs 0–3 are code-graded, 4–5 judged, per ADR-0002).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../shared/paths.js';

/** One golden-set item. `expect` is a rung-specific check descriptor. */
export interface GoldenItem {
  id: string;
  input: string;
  expect: Record<string, unknown>;
}

export interface LadderRungReport {
  rung: number;
  route: string;
  total: number;
  /** Per-item grading outcomes — empty until the rung grading engines land. */
  results: unknown[];
}

/** Golden-set path for a rung (repo-relative layout per ADR-0002). */
export function goldenSetPath(rung: number): string {
  return join(PROJECT_ROOT, 'evals', 'ladder', `rung-${rung}`, 'golden.json');
}

/**
 * Load + strictly validate a rung's golden set. Throws on a missing file or
 * any malformed item — an admission gate must never grade against a silently
 * half-loaded set.
 */
export function loadGoldenSet(rung: number): GoldenItem[] {
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
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`ladder: golden set ${path} must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const it = item as Partial<GoldenItem> | null;
    if (it === null || typeof it !== 'object') throw new Error(`ladder: ${path}[${i}] is not an object`);
    if (typeof it.id !== 'string' || it.id === '') throw new Error(`ladder: ${path}[${i}].id must be a non-empty string`);
    if (seen.has(it.id)) throw new Error(`ladder: ${path} has duplicate id '${it.id}'`);
    seen.add(it.id);
    if (typeof it.input !== 'string' || it.input === '') throw new Error(`ladder: ${path}[${i}].input must be a non-empty string`);
    if (it.expect === null || typeof it.expect !== 'object' || Array.isArray(it.expect) || Object.keys(it.expect).length === 0) {
      throw new Error(`ladder: ${path}[${i}].expect must be a non-empty object`);
    }
  }
  return raw as GoldenItem[];
}

/**
 * Run a ladder rung against a route.
 *
 * STUB (deliberate, planned work — NOT a model-limitation scaffold): per
 * ADR-0002 the rung grading engines (code-graded 0–3, judged 4–5 with a pinned
 * independent judge route) are the next slice; this Phase 4 deliverable is the
 * golden-set format + loader + layout. The stub loads and validates the rung's
 * golden set so callers already fail loudly on a broken set, and returns an
 * empty results vector.
 */
export async function runLadderRung(rung: number, route: string): Promise<LadderRungReport> {
  const items = loadGoldenSet(rung);
  return { rung, route, total: items.length, results: [] };
}
