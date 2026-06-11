/**
 * @file tool-name-collision.ts
 * @description Surfaces duplicate tool names before Object.fromEntries
 * serialization silently keeps only the last definition per name.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:tool-collision');

export interface DuplicateToolName {
  name: string;
  count: number;
}

/** Pure detection: names appearing more than once, in first-seen order. */
export function findDuplicateToolNames(
  entries: ReadonlyArray<readonly [string, unknown]>,
): DuplicateToolName[] {
  if (entries.length < 2) return [];
  const counts = new Map<string, number>();
  for (const [name] of entries) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates: DuplicateToolName[] = [];
  for (const [name, count] of counts) {
    if (count > 1) duplicates.push({ name, count });
  }
  return duplicates;
}

// Warn once per distinct collision set per process — collisions are
// per-request, so an unbounded warn would spam the log on every call.
// Growth is bounded by the number of distinct tool configurations the
// process ever sees (typically O(1)), so no eviction is needed.
const warnedSignatures = new Set<string>();

/** Test hook: clear the once-per-signature memory. */
export function resetDuplicateToolNameWarnings(): void {
  warnedSignatures.clear();
}

/**
 * Log-only, fail-open: never throws, never alters the entries. (Fail-open
 * covers this function body; module-load failures in logger.ts are outside
 * the guard.)
 * Callers sort (when SUDO_PROMPT_CACHE=1) then serialize via
 * Object.fromEntries; the stable sort preserves relative order among
 * same-named entries, so last-definition-wins holds in both modes.
 */
export function warnOnDuplicateToolNames(
  entries: ReadonlyArray<readonly [string, unknown]>,
): void {
  try {
    const duplicates = findDuplicateToolNames(entries);
    if (duplicates.length === 0) return;
    const signature = duplicates
      .map((d) => `${d.name}:${d.count}`)
      .sort()
      .join(',');
    if (warnedSignatures.has(signature)) return;
    warnedSignatures.add(signature);
    log.warn(
      { duplicates, totalTools: entries.length },
      'Duplicate tool names in request — Object.fromEntries keeps only the LAST definition per name; earlier definitions are silently dropped',
    );
  } catch (err) {
    log.warn({ err: String(err) }, 'duplicate-tool-name check failed — continuing');
  }
}
