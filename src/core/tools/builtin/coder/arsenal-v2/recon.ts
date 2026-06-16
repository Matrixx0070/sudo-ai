/**
 * @file recon.ts
 * @description File discovery and relevance ranking for arsenal-v2.
 *
 * arsenal-v2 is patch-driven so the LLM doesn't need to see every byte of
 * every file — just enough to find the right anchor strings. Recon collects
 * a ranked, capped slice of the project that fits in a sensible context
 * window without blowing past the 22-second undici headersTimeout that
 * caused arsenal-v1 to hang.
 *
 * Ranking (in priority order):
 *   1. Files the task names explicitly (regex over the prompt for `*.ts`,
 *      `*.tsx`, `*.js`, `*.jsx`). Always included unconditionally.
 *   2. Files matched by ripgrep against task keywords, ranked by hit count.
 *   3. Fallback to a depth-bounded walk if both above yield nothing.
 *
 * Caps (every cap is enforced independently; the smallest hit wins):
 *   - 30 files max
 *   - 50 KB max per file
 *   - 300 KB total payload
 *
 * The output shape matches arsenal-v1's `### relpath\n\`\`\`\n...\n\`\`\`\n\n`
 * fenced-block format so existing prompt templates work unchanged.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

export interface ReconOptions {
  /** Project root — recon stays inside this tree. */
  projectRoot: string;
  /** Base directory for the walk-fallback (typically same as projectRoot). */
  searchRoot: string;
  /** Hard cap on file count. */
  maxFiles?: number;
  /** Per-file byte cap (files larger than this are skipped). */
  maxFileBytes?: number;
  /** Total payload byte cap across all selected files. */
  maxTotalBytes?: number;
}

const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_FILE_BYTES = 50_000;
const DEFAULT_MAX_TOTAL_BYTES = 300_000;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
  'how', 'its', 'may', 'now', 'old', 'see', 'two', 'who', 'did', 'fix',
  'add', 'use', 'via', 'per', 'set', 'get', 'run', 'new', 'one', 'out',
  'this', 'that', 'with', 'from', 'into', 'over', 'when', 'what', 'have',
  'will', 'they', 'them', 'were', 'been', 'than', 'them', 'some', 'just',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', 'out',
]);

export interface ReconResult {
  /** Files chosen, in priority order. Relative to projectRoot. */
  files: string[];
  /** Concatenated fenced-block payload ready for the LLM prompt. */
  payload: string;
  /** Total bytes in the payload (approximate — string length). */
  totalBytes: number;
  /** Diagnostic: why each cap fired (file count / per-file / total). */
  truncationReason?: 'max_files' | 'max_total_bytes' | 'none';
}

/**
 * Top-level entry: given a task description, return a ranked + capped slice
 * of the project as fenced markdown blocks. Pure-ish (filesystem only — no
 * network, no LLM calls).
 */
export async function recon(task: string, opts: ReconOptions): Promise<ReconResult> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const explicit = extractExplicitFiles(task, opts.projectRoot);
  const keywords = extractKeywords(task);

  // Tier 1: explicit refs go in unconditionally (caller asked for them).
  const ranked: string[] = [...explicit];
  // Tier 2: ripgrep hits, deduped against tier 1, ranked by hit count.
  if (keywords.length > 0) {
    const rgHits = rgRank(keywords, opts.searchRoot);
    for (const abs of rgHits) if (!ranked.includes(abs)) ranked.push(abs);
  }
  // Tier 3: fallback walk if nothing matched.
  if (ranked.length === 0) {
    const fromWalk = await walk(opts.searchRoot, opts.searchRoot, 0);
    for (const abs of fromWalk) ranked.push(abs);
  }

  return collect(ranked, opts.projectRoot, maxFiles, maxFileBytes, maxTotalBytes);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function extractExplicitFiles(task: string, projectRoot: string): string[] {
  const refs: string[] = [];
  const re = /[\w/\-.]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(task)) !== null) {
    const abs = path.isAbsolute(m[0]) ? path.resolve(m[0]) : path.resolve(projectRoot, m[0]);
    if (existsSync(abs) && !refs.includes(abs)) refs.push(abs);
  }
  return refs;
}

export function extractKeywords(task: string): string[] {
  // Exported for unit tests. Strategy: split on non-word; keep tokens of
  // length >= 4 that aren't stopwords; lowercase and dedupe; cap at 10.
  // Length floor of 4 avoids "x", "fn", "ts" etc. that would match every file.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of task.split(/\W+/)) {
    const w = raw.toLowerCase();
    if (w.length < 4) continue;
    if (STOP_WORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 10) break;
  }
  return out;
}

function rgRank(keywords: string[], searchRoot: string): string[] {
  // Score each file by how many keywords match in it (rg -l per keyword,
  // count unique-file membership across results). Files that match more
  // keywords rank higher.
  const fileScores = new Map<string, number>();
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '');
    let out = '';
    try {
      out = execSync(
        `rg -l --max-count=1 -g "*.ts" -g "*.tsx" -g "*.js" -g "*.jsx" -g "*.json" -g "*.md" "${escaped}" "${searchRoot}"`,
        { encoding: 'utf-8', timeout: 8_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      continue; // no match for this keyword (rg returns nonzero) — skip
    }
    for (const f of out.trim().split('\n')) {
      if (!f) continue;
      if (isSkippedPath(f)) continue;
      fileScores.set(f, (fileScores.get(f) ?? 0) + 1);
    }
  }
  return [...fileScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);
}

async function walk(dir: string, searchRoot: string, depth: number): Promise<string[]> {
  if (depth > 4) return []; // bound walk depth — searchRoot/a/b/c/d is plenty
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (isSkippedPath(full)) continue;
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) {
      const inner = await walk(full, searchRoot, depth + 1);
      for (const f of inner) out.push(f);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
    out.push(full);
  }
  return out;
}

function isSkippedPath(abs: string): boolean {
  for (const seg of abs.split(path.sep)) {
    if (SKIP_DIRS.has(seg)) return true;
  }
  return false;
}

function collect(
  ranked: string[],
  projectRoot: string,
  maxFiles: number,
  maxFileBytes: number,
  maxTotalBytes: number,
): ReconResult {
  const chosen: string[] = [];
  const parts: string[] = [];
  let totalBytes = 0;
  let truncationReason: ReconResult['truncationReason'] = 'none';

  for (const abs of ranked) {
    if (chosen.length >= maxFiles) { truncationReason = 'max_files'; break; }
    let s;
    try { s = statSync(abs); } catch { continue; }
    if (!s.isFile()) continue;
    if (s.size > maxFileBytes) continue; // skip huge individual files
    let content: string;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const rel = path.relative(projectRoot, abs);
    const chunk = `### ${rel}\n\`\`\`\n${content}\n\`\`\`\n\n`;
    if (totalBytes + chunk.length > maxTotalBytes) { truncationReason = 'max_total_bytes'; break; }
    parts.push(chunk);
    chosen.push(rel);
    totalBytes += chunk.length;
  }

  return { files: chosen, payload: parts.join(''), totalBytes, truncationReason };
}
