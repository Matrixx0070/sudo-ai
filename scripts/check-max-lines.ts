/**
 * GW-12: per-file max-lines RATCHET. A committed baseline records the current
 * line count of every tracked source file; a file that GROWS past
 * baseline * (1 + TOLERANCE) fails CI. A file that SHRINKS auto-tightens its
 * baseline (the script rewrites the baseline, committed with the PR), so debt
 * only ratchets down. New files above the tracking threshold seed at their
 * current size. Seeded at current values → day one is green.
 *
 *   npx tsx scripts/check-max-lines.ts            # check (exit 1 on violation)
 *   npx tsx scripts/check-max-lines.ts --write    # rewrite the baseline
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const BASELINE = path.join(ROOT, 'scripts', 'max-lines-baseline.json');
/** Only track files at/above this many lines (keeps the baseline meaningful). */
export const TRACK_THRESHOLD = 400;
/** A file may grow up to this fraction over its baseline before failing. */
export const TOLERANCE = 0.1;

export interface Violation {
  file: string;
  lines: number;
  baseline: number;
  limit: number;
}

/**
 * Pure ratchet core. Given current line counts and a baseline, return the
 * violations (files grown past baseline*(1+tol)) and the NEXT baseline
 * (shrinks tightened, new large files seeded).
 */
export function ratchet(
  counts: Record<string, number>,
  baseline: Record<string, number>,
  threshold = TRACK_THRESHOLD,
  tol = TOLERANCE,
): { violations: Violation[]; nextBaseline: Record<string, number> } {
  const violations: Violation[] = [];
  const nextBaseline: Record<string, number> = {};
  for (const [file, lines] of Object.entries(counts)) {
    const base = baseline[file];
    if (base === undefined) {
      // New file: seed if large enough to track.
      if (lines >= threshold) nextBaseline[file] = lines;
      continue;
    }
    const limit = Math.floor(base * (1 + tol));
    if (lines > limit) {
      violations.push({ file, lines, baseline: base, limit });
      nextBaseline[file] = base; // keep the old baseline until the violation is fixed
    } else {
      // Shrink auto-tightens; growth within tolerance keeps the old baseline.
      nextBaseline[file] = Math.min(base, lines);
    }
  }
  return { violations, nextBaseline };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry)) {
      yield full;
    }
  }
}

function currentCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines >= TRACK_THRESHOLD) out[rel] = lines;
  }
  return out;
}

function main(): void {
  const write = process.argv.includes('--write');
  const counts = currentCounts();
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
  } catch {
    /* first run → empty baseline seeds everything */
  }
  const { violations, nextBaseline } = ratchet(counts, baseline);

  if (write) {
    const sorted = Object.fromEntries(Object.entries(nextBaseline).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
    console.log(`Wrote ${path.relative(ROOT, BASELINE)} (${Object.keys(sorted).length} tracked files)`);
    return;
  }

  if (violations.length > 0) {
    console.error(`max-lines ratchet: ${violations.length} file(s) grew past baseline+${TOLERANCE * 100}%:`);
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.lines} lines (baseline ${v.baseline}, limit ${v.limit})`);
    }
    console.error('Split the file, or if the growth is justified run: npx tsx scripts/check-max-lines.ts --write');
    process.exit(1);
  }
  // Auto-tighten baseline when files shrank (keeps the ratchet moving down).
  const tightened = JSON.stringify(
    Object.fromEntries(Object.entries(nextBaseline).sort(([a], [b]) => a.localeCompare(b))),
    null,
    2,
  ) + '\n';
  let prev = '';
  try {
    prev = readFileSync(BASELINE, 'utf8');
  } catch {
    /* none */
  }
  if (tightened !== prev) {
    writeFileSync(BASELINE, tightened);
    console.log('max-lines ratchet: baseline auto-tightened (files shrank) — commit the updated baseline');
  } else {
    console.log(`max-lines ratchet: OK (${Object.keys(counts).length} tracked files)`);
  }
}

// Only run the CLI when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) main();
