/**
 * @file gdrive/self-diff.ts
 * @description F13 — weekly self-diff. A scheduled report of how the brain
 * changed over the last 7 days: memory churn (add/update/deprecate from the
 * F31 chronicle), belief health (state counts + re-derivation queue from F22),
 * and a knowledge-topology slot (F53 fills the map link + the "did the
 * silhouette change?" prompt). Published as a comment-able Doc in ops/reports/
 * and watched for F6 corrections.
 *
 * This was scoped in the Drive roadmap but never built; the NotebookLM annex
 * (F42 architecture explainer, F53 topology maps) needs it, so it is repaired
 * Drive-side here rather than reimplemented in annex code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { ChronicleOp } from './chronicle.js';

const log = createLogger('gdrive:self-diff');

export interface SelfDiffBeliefLike {
  state: string; // ValidationState
  rederiveQueued?: boolean;
  trustTier: string;
}

export interface SelfDiffInputs {
  fromDay: string; // YYYY-MM-DD (inclusive)
  toDay: string;
  chronicleOps: ChronicleOp[];
  beliefs: SelfDiffBeliefLike[];
  /** F53 topology map link + whether the silhouette changed (absent until F53). */
  topology?: { mapLink?: string; note?: string };
}

/** memoryId "chunks/topics/infra.md" -> domain "chunks/topics". */
function domainOf(memoryId: string): string {
  const seg = memoryId.split('/').filter(Boolean);
  return seg.length > 1 ? seg.slice(0, 2).join('/') : (seg[0] ?? 'misc');
}

/** Pure renderer. */
export function buildSelfDiff(inputs: SelfDiffInputs): string {
  const counts = { add: 0, update: 0, deprecate: 0 };
  const byDomain = new Map<string, { add: number; update: number; deprecate: number }>();
  for (const op of inputs.chronicleOps) {
    counts[op.op]++;
    const d = domainOf(op.memoryId);
    const c = byDomain.get(d) ?? { add: 0, update: 0, deprecate: 0 };
    c[op.op]++;
    byDomain.set(d, c);
  }
  const topMovers = [...byDomain.entries()]
    .map(([d, c]) => ({ d, total: c.add + c.update + c.deprecate, c }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const beliefStates = new Map<string, number>();
  let queued = 0;
  for (const b of inputs.beliefs) {
    beliefStates.set(b.state, (beliefStates.get(b.state) ?? 0) + 1);
    if (b.rederiveQueued) queued++;
  }

  const lines: string[] = [
    `# Weekly Self-Diff — ${inputs.fromDay} → ${inputs.toDay}`,
    '',
    '## Memory churn',
    `- **${counts.add}** added · **${counts.update}** updated · **${counts.deprecate}** deprecated (${inputs.chronicleOps.length} total ops)`,
    '',
    '### Top movers (by domain)',
    ...(topMovers.length
      ? topMovers.map((m) => `- ${m.d}: +${m.c.add} ~${m.c.update} -${m.c.deprecate}`)
      : ['- (no memory changes this week)']),
    '',
    '## Belief health',
    ...(beliefStates.size
      ? [...beliefStates.entries()].sort().map(([s, n]) => `- ${s}: ${n}`)
      : ['- (no beliefs registered)']),
    `- re-derivation queued: ${queued}`,
    '',
    '## Knowledge topology (F53)',
    inputs.topology?.mapLink ? `- Latest mind map: ${inputs.topology.mapLink}` : '- (no topology map linked this month)',
    `- **Did the silhouette change?** ${inputs.topology?.note ?? '_(answer after viewing the map)_'}`,
    '',
    '*Comment on any line — corrections are read within one poll cycle (F6).*',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// F53 topology-map link hook (F53 writes this; self-diff reads it)
// ---------------------------------------------------------------------------

export function topologyLinkPath(): string {
  return dataPath('gdrive', 'topology-map-link.json');
}

export function readTopologyLink(): { mapLink?: string; note?: string } | undefined {
  try {
    if (!existsSync(topologyLinkPath())) return undefined;
    return JSON.parse(readFileSync(topologyLinkPath(), 'utf-8')) as { mapLink?: string; note?: string };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface SelfDiffResult {
  fileId: string;
  name: string;
}

/** Render + publish the weekly self-diff Doc (update-in-place per week). */
export async function publishSelfDiff(
  client: DriveClient,
  folders: FolderIdMap,
  inputs: SelfDiffInputs,
): Promise<SelfDiffResult> {
  const reportsFolder = folders['ops/reports'];
  if (!reportsFolder) throw new Error('self-diff: ops/reports folder id missing');
  const body = buildSelfDiff(inputs);
  const name = `self-diff-${inputs.toDay}`;
  const existing = (await client.listChildren(reportsFolder)).find((f) => f.name === name);
  if (existing) {
    await client.filesUpdateGoogleDoc(existing.id, body);
    return { fileId: existing.id, name };
  }
  const created = await client.filesCreateAsGoogleDoc(name, reportsFolder, body);
  log.info({ name, fileId: created.id }, 'weekly self-diff published');
  return { fileId: created.id, name };
}
