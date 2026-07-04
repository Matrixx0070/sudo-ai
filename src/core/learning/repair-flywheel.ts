/**
 * @file learning/repair-flywheel.ts
 * @description Phase-A prototype of the verified continual-learning flywheel,
 * scoped to `repair` lessons mined from the trace store's failure signatures.
 *
 * THE LOOP (this module implements the offline half):
 *   MINE failure clusters (by tool + normalized error signature)
 *   → DISTILL a repair lesson per recurring cluster (a guidance rule + optional
 *     deterministic input transform)
 *   → MEASURE the canary: (a) addressable-failure COVERAGE over real history,
 *     (b) repair CORRECTNESS via a deterministic transform + the real guard.
 *
 * This does NOT yet apply lessons to the live loop — it proves the mine→distill
 * →measure half is real and produces a concrete number, so we know whether the
 * flywheel is worth wiring in before we wire it in.
 *
 * HONEST LIMITATION surfaced by building this: the trace store persists the
 * error MESSAGE but not the tool INPUT (`args_raw` is empty for tool failures),
 * so an input-level counterfactual on *historical* rows isn't possible yet —
 * richer trajectory capture is a prerequisite for the full flywheel.
 */

/** A single failed tool call as recorded by the trace store. */
export interface FailureRow {
  tool_name: string;
  error_message: string;
}

/** A recurring failure cluster: a tool + a normalized error signature. */
export interface FailureCluster {
  tool: string;
  signature: string;
  count: number;
  sample: string;
}

/**
 * A distilled repair lesson. `matches` recognizes the failure; `guidance` is the
 * pre-emptive instruction that would be injected so the agent avoids the wasted
 * attempt; `learnable` is false for clusters that are actually a system bug or a
 * correctly-working guard (NOT something the agent should be taught to bypass).
 */
export interface RepairLesson {
  id: string;
  tool: string;
  matches: (errorMessage: string) => boolean;
  guidance: string;
  learnable: boolean;
}

/** Normalize an error message to a stable signature (strip volatile specifics). */
export function errorSignature(msg: string): string {
  return (msg || '')
    .replace(/['"`][^'"`]*['"`]/g, '…')            // quoted specifics (paths, cmds)
    .replace(/\/[^\s:]+/g, '/…')                    // absolute paths
    .replace(/\b\d+\b/g, 'N')                        // numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Cluster failures by (tool, signature), most frequent first. */
export function mineFailureClusters(rows: FailureRow[], minCount = 3): FailureCluster[] {
  const map = new Map<string, FailureCluster>();
  for (const r of rows) {
    const sig = errorSignature(r.error_message);
    const key = `${r.tool_name}::${sig}`;
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else map.set(key, { tool: r.tool_name, signature: sig, count: 1, sample: r.error_message });
  }
  return [...map.values()].filter((c) => c.count >= minCount).sort((a, b) => b.count - a.count);
}

/**
 * The distilled repair lessons for the top clusters found in real traces. In the
 * full flywheel an LLM proposes these from the clusters; for the prototype the
 * dominant clusters are known, so they're hand-distilled here to prove the loop.
 * Each is teaching the agent to WORK WITHIN a guard, never to bypass it.
 */
export const REPAIR_LESSONS: RepairLesson[] = [
  {
    id: 'exec-repo-readonly-metachars',
    tool: 'system.exec',
    matches: (m) =>
      /shell metacharacters are not allowed in repo-exec/i.test(m) ||
      /shell operators .* are not allowed in rep/i.test(m) ||
      /is not a repo-allowlisted command/i.test(m) ||
      /argument escapes the repo/i.test(m),
    guidance:
      'When the exec target is the read-only "repo", use a single allowlisted read/verify ' +
      'command with NO pipes, redirects, chaining, globs, or metacharacters — or use a ' +
      'dedicated coder.* tool (read-file/glob) instead of shelling out.',
    learnable: true,
  },
  {
    id: 'readfile-relative-path',
    tool: 'coder.read-file',
    matches: (m) => /Path traversal blocked/i.test(m) && /resolves outside project root/i.test(m),
    guidance:
      'When reading a project file, pass a path RELATIVE to the project root ' +
      '(e.g. "src/core/x.ts"), not an absolute path — absolute paths outside the ' +
      'project root are blocked by the path guard.',
    learnable: true,
  },
  {
    id: 'readfile-dirname-undefined',
    tool: 'coder.read-file',
    matches: (m) => /__dirname is not defined/i.test(m),
    guidance: '',
    // NOT a learnable agent mistake — this is the ESM/tsx __dirname landmine in
    // the read-file guard itself. The flywheel flags it as a SYSTEM BUG to fix,
    // not something to teach the agent around.
    learnable: false,
  },
];

/** Match a failure message to a distilled lesson, if any. */
export function matchLesson(errorMessage: string): RepairLesson | undefined {
  return REPAIR_LESSONS.find((l) => l.matches(errorMessage));
}

/**
 * CANARY (a): addressable-failure coverage. What fraction of real failures fall
 * into a learnable, distilled cluster a repair lesson would pre-empt?
 */
export function measureCoverage(rows: FailureRow[]): {
  total: number;
  addressed: number;
  learnableAddressed: number;
  coveragePct: number;
  byLesson: Record<string, number>;
  systemBugs: number;
} {
  const byLesson: Record<string, number> = {};
  let addressed = 0;
  let learnableAddressed = 0;
  let systemBugs = 0;
  for (const r of rows) {
    const l = matchLesson(r.error_message);
    if (!l) continue;
    addressed += 1;
    byLesson[l.id] = (byLesson[l.id] ?? 0) + 1;
    if (l.learnable) learnableAddressed += 1;
    else systemBugs += 1;
  }
  const total = rows.length;
  return {
    total,
    addressed,
    learnableAddressed,
    coveragePct: total > 0 ? Math.round((1000 * learnableAddressed) / total) / 10 : 0,
    byLesson,
    systemBugs,
  };
}

/**
 * The distilled repair transform for the read-file path case: map a project-
 * anchored absolute path to a project-relative one.
 *
 * FINDING (surfaced by running canary (b) against reality): a naive model of the
 * guard predicate (`resolved.startsWith('/root/sudo-ai-v4')`) says an in-repo
 * absolute path like "/root/sudo-ai-v4/package.json" should PASS — yet the real
 * guard BLOCKED exactly that path in production. So the guard's real projectRoot
 * is narrower/mis-resolved (consistent with the `__dirname`-in-ESM landmine at
 * read-file.ts:88). The relative-path repair is still correct guidance, but part
 * of this cluster is a real GUARD BUG, not agent error. `pathPassesGuard` is left
 * out deliberately — modelling the (buggy) guard would encode the bug.
 */
export function repairReadFilePath(rawPath: string, projectRoot: string): string {
  if (rawPath.startsWith(projectRoot + '/')) return rawPath.slice(projectRoot.length + 1);
  return rawPath; // outside the project — genuinely unreadable, not repairable
}
