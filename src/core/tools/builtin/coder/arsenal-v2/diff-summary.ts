/**
 * @file arsenal-v2/diff-summary.ts
 * @description Build a bounded, LLM-readable summary of what the applier
 * actually changed, fed to the critic in slice 4.
 *
 * The summary is intentionally NOT a unified git diff: we want the critic
 * to see exactly what the patcher emitted (old → new for str_replace,
 * anchor + injected content for insert_*, raw content for create_file),
 * because the file's current state is the union of multiple ops and a
 * one-shot diff can be hard to map back to the LLM's intent.
 *
 * Bounds:
 *   - Per-snippet cap: 2048 chars (each `old`/`new`/`content`/`anchor`).
 *   - Total cap: 32_768 chars across all ops. Subsequent ops are listed
 *     by op-name + file only once the budget is exhausted.
 */

import type { PatchOpResult } from './patch-types.js';

const SNIPPET_CAP = 2048;
const TOTAL_CAP = 32_768;

/**
 * Walk the applier results in declaration order and emit a single string
 * suitable for embedding in an LLM prompt. Only applied ops contribute
 * snippet bodies; skipped/failed ops are listed as one-liners so the critic
 * can see what was rejected and reason about why.
 */
export function buildDiffSummary(results: PatchOpResult[]): string {
  if (results.length === 0) return '(no patch ops)';

  const parts: string[] = [];
  let used = 0;
  let overflow = 0;

  for (const r of results) {
    const block = renderOne(r);
    if (used + block.length > TOTAL_CAP) {
      overflow += 1;
      continue;
    }
    parts.push(block);
    used += block.length;
  }

  if (overflow > 0) {
    parts.push(`\n[... ${overflow} more op(s) omitted — diff summary capped at ${TOTAL_CAP} chars ...]`);
  }

  return parts.join('\n\n');
}

function renderOne(r: PatchOpResult): string {
  const { op } = r;
  const head =
    r.status === 'applied'
      ? `[✓ applied] ${op.op} → ${op.file}`
      : r.status === 'skipped'
        ? `[↷ skipped${r.reason ? `: ${r.reason}` : ''}] ${op.op} → ${op.file}`
        : `[✗ failed${r.reason ? `: ${r.reason}` : ''}] ${op.op} → ${op.file}`;

  // Non-applied ops contribute the header line only — the critic can see
  // them in context but doesn't get speculative snippets that never landed.
  if (r.status !== 'applied') {
    return r.detail ? `${head}\n  detail: ${truncate(r.detail, 240)}` : head;
  }

  if (op.op === 'str_replace') {
    return [head, '--- old ---', truncate(op.old, SNIPPET_CAP), '--- new ---', truncate(op.new, SNIPPET_CAP)].join('\n');
  }
  if (op.op === 'insert_after' || op.op === 'insert_before') {
    return [head, '--- anchor ---', truncate(op.anchor, SNIPPET_CAP), '--- inserted ---', truncate(op.content, SNIPPET_CAP)].join('\n');
  }
  if (op.op === 'create_file') {
    return [head, '--- content ---', truncate(op.content, SNIPPET_CAP)].join('\n');
  }
  // delete_file has no payload to show.
  return head;
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n[... truncated ${s.length - cap} chars ...]`;
}
