/**
 * F103 loop-helpers decomposition — parallel-safety classification, batch
 * partitioning, and the tool concurrency cap.
 *
 * Moved verbatim from the former monolithic src/core/agent/loop-helpers.ts.
 * See ../loop-helpers.ts (barrel) for the full submodule map.
 */

import type { ToolRegistryLike } from './types.js';

// ---------------------------------------------------------------------------
// Parallel tool-call execution helpers (Upgrade 5)
// ---------------------------------------------------------------------------

/**
 * Tool name prefixes that mutate shared state and must always run sequentially.
 * Namespace prefixes (trailing dot) block every tool in that namespace:
 * `system.` and `code.` execute arbitrary commands, and `browser.`/`sandbox.`
 * tools share one stateful session, so even nominally read-only members are
 * order-dependent. Generic names (file./shell./db.) are kept for synthesized
 * and MCP tools that follow those conventions.
 */
const SEQUENTIAL_TOOL_PREFIXES: readonly string[] = [
  'system.', 'code.', 'browser.', 'sandbox.',
  'coder.write-file', 'coder.edit-file', 'coder.multi-edit', 'coder.smart-edit',
  'coder.apply-patch', 'coder.notebook-edit', 'coder.scaffold', 'coder.git',
  'coder.npm', 'coder.test',
  'file.write', 'file.delete', 'file.move', 'file.rename',
  'shell.', 'db.write', 'db.insert', 'db.update', 'db.delete',
  'memory.save', 'memory.delete',
];

/**
 * Return true when a tool call can run concurrently with others.
 * Sequential when it has a mutating prefix, declares `safety: 'destructive'`
 * or `requiresConfirmation` in the registry, or shares a `path` arg with
 * another call in the same batch.
 *
 * Exported with underscore prefix to signal "internal, test-only".
 */
export function _isParallelSafe(
  tc: { name: string; arguments: Record<string, unknown> },
  allCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>,
  registry?: Pick<ToolRegistryLike, 'get'>,
): boolean {
  const nameL = tc.name.toLowerCase();
  for (const prefix of SEQUENTIAL_TOOL_PREFIXES) {
    if (nameL.startsWith(prefix)) return false;
  }
  const def = registry?.get?.(tc.name);
  if (def && (def.safety === 'destructive' || def.requiresConfirmation === true)) return false;
  const myPath = tc.arguments['path'] as string | undefined;
  if (myPath) {
    const conflicts = allCalls.filter(
      other => other !== tc && (other.arguments['path'] as string | undefined) === myPath,
    );
    if (conflicts.length > 0) return false;
  }
  return true;
}

/** Partition calls: leading sequential → one parallel batch → trailing sequential. */
interface PartitionResult {
  leadingSequential: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  parallel: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  trailingSequential: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

/** Exported with underscore prefix to signal "internal, test-only". */
export function _partitionToolCalls(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  registry?: Pick<ToolRegistryLike, 'get'>,
): PartitionResult {
  if (calls.length <= 1 || process.env['SUDO_PARALLEL_TOOLS_DISABLE'] === '1') {
    return { leadingSequential: calls, parallel: [], trailingSequential: [] };
  }
  const safeFlags = calls.map(tc => _isParallelSafe(tc, calls, registry));
  const firstSafe = safeFlags.indexOf(true);
  if (firstSafe === -1) {
    return { leadingSequential: calls, parallel: [], trailingSequential: [] };
  }
  let lastSafe = firstSafe;
  while (lastSafe + 1 < calls.length && safeFlags[lastSafe + 1]) lastSafe++;
  return {
    leadingSequential: calls.slice(0, firstSafe),
    parallel: calls.slice(firstSafe, lastSafe + 1),
    trailingSequential: calls.slice(lastSafe + 1),
  };
}

const DEFAULT_TOOL_CONCURRENCY = 10;

/** Parallel-batch concurrency cap from SUDO_TOOL_CONCURRENCY (default 10, min 1). */
function getToolConcurrency(): number {
  const raw = Number(process.env['SUDO_TOOL_CONCURRENCY']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_TOOL_CONCURRENCY;
}

// F103: shared with sibling loop-helpers/ modules — internal, do not import
// from outside the loop-helpers/ directory.
export { getToolConcurrency as _getToolConcurrency };
