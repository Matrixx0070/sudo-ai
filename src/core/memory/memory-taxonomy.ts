/**
 * @file memory/memory-taxonomy.ts
 * @description v5 six-type memory taxonomy with backwards-compat migration map.
 *
 * v4 used a 4-type taxonomy ('user' | 'feedback' | 'project' | 'reference').
 * v5 expands to 6 types. `legacyTypeToTaxonomy` maps persisted v4 strings to
 * their v5 equivalents so existing rows are never silently dropped or corrupted.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('memory-taxonomy');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The six memory types recognised by SUDO-AI v5. */
export type MemoryType6 =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'working'
  | 'feedback'
  | 'declarative';

/** Immutable ordered list used for runtime validation. */
export const VALID_MEMORY_TYPES: readonly MemoryType6[] = [
  'episodic',
  'semantic',
  'procedural',
  'working',
  'feedback',
  'declarative',
] as const;

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Maps v4 four-type taxonomy strings to the nearest v5 equivalent.
 * Unknown strings fall back to 'declarative' — the safest general-purpose type.
 */
const LEGACY_MAP: Record<string, MemoryType6> = {
  user: 'episodic',
  feedback: 'feedback',
  project: 'declarative',
  reference: 'semantic',
};

/**
 * Convert a persisted v4 memory type string to a valid v5 `MemoryType6`.
 *
 * @param old - Raw string stored in v4 (e.g. `'user'`, `'project'`).
 * @returns The corresponding v5 type, defaulting to `'declarative'` for unknowns.
 *
 * @example
 * legacyTypeToTaxonomy('user')      // → 'episodic'
 * legacyTypeToTaxonomy('reference') // → 'semantic'
 * legacyTypeToTaxonomy('unknown')   // → 'declarative'
 */
export function legacyTypeToTaxonomy(old: string): MemoryType6 {
  if (!old || typeof old !== 'string') {
    log.warn({ old }, 'legacyTypeToTaxonomy: received non-string input, defaulting to declarative');
    return 'declarative';
  }

  const mapped = LEGACY_MAP[old];
  if (mapped === undefined) {
    log.warn({ old }, 'legacyTypeToTaxonomy: unrecognised legacy type, defaulting to declarative');
  }
  return mapped ?? 'declarative';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows an arbitrary string to `MemoryType6`.
 *
 * @param type - Value to test.
 * @returns `true` when `type` is one of the six valid v5 memory types.
 */
export function isValidMemoryType(type: string): type is MemoryType6 {
  return VALID_MEMORY_TYPES.includes(type as MemoryType6);
}

// ---------------------------------------------------------------------------
// MemoryEntry
// ---------------------------------------------------------------------------

/**
 * A single memory record as stored and retrieved by the v5 memory subsystem.
 *
 * `confidence` must be in [0, 1].
 * `createdAt` / `updatedAt` / `expiresAt` are ISO-8601 strings.
 */
export interface MemoryEntry {
  /** Unique identifier (nanoid / UUID). */
  id: string;
  /** Six-type taxonomy classification. */
  type: MemoryType6;
  /** The actual memory content. */
  content: string;
  /** Where this memory originated (e.g. `'user'`, `'tool'`, `'dream'`). */
  source: string;
  /** Model confidence in this memory, range [0, 1]. */
  confidence: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
  /** Optional ISO-8601 expiry; undefined means the entry never expires. */
  expiresAt?: string;
  /** Arbitrary extra data attached by the emitting subsystem. */
  metadata?: Record<string, unknown>;
}
