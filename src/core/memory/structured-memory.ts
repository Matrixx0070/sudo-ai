/**
 * structured-memory.ts
 *
 * File-backed structured memory system inspired by Claude Code's MEMORY.md pattern.
 * Stores four memory types (user, feedback, project, reference) as individual JSON
 * files in data/structured-memory/.
 *
 * Each file is named  <type>_<id>.json  and contains a StructuredMemory object.
 * Search is keyword-based (no embeddings) — instant and zero-cost.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import { legacyTypeToTaxonomy } from './memory-taxonomy.js';
import { guardMemoryWrite } from './injection-scanner.js';

const log = createLogger('memory:structured');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The six memory categories — v4 four-type taxonomy extended with v5 types.
 * 'episodic' and 'semantic' are the two new additions for SUDO-AI v5.
 * Legacy v4 strings ('user', 'project', 'reference') are still valid but
 * callers should prefer the v5 types; use legacyTypeToTaxonomy() to migrate.
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'episodic' | 'semantic';

/** A single structured memory record. */
export interface StructuredMemory {
  /** UUID-style unique identifier. */
  id: string;
  /** Category of this memory entry. */
  type: MemoryType;
  /** Short display name, e.g. "user_frank" or "project_ollama". */
  name: string;
  /** One-line description of what this memory contains. */
  description: string;
  /** Full content text — markdown supported. */
  content: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /**
   * Set when this record was superseded by a newer fact about the same subject
   * (same type+name). Holds the id of the superseding record. Absent = active.
   * Superseded records are excluded from listing/search but kept for audit.
   */
  supersededBy?: string;
  /** ISO-8601 timestamp when this record was superseded. */
  supersededAt?: string;
}

/** Options for searchMemories(). */
export interface MemorySearchOptions {
  /** Text to match against name, description, and content. */
  query: string;
  /** Filter by type (optional). */
  type?: MemoryType;
  /** Maximum results to return (default: 10). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to the structured memory store. */
const STORE_DIR = path.join(DATA_DIR, 'structured-memory');

const VALID_TYPES = new Set<MemoryType>([
  'user',
  'feedback',
  'project',
  'reference',
  'episodic',
  'semantic',
]);

// Re-export for callers that need the backwards-compat migration helper.
export { legacyTypeToTaxonomy };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive the file path for a given memory ID and type. */
function filePath(type: MemoryType, id: string): string {
  return path.join(STORE_DIR, `${type}_${id}.json`);
}

/** Generate a simple time-based ID (no external deps). */
function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Memory quality guards — based on Claude Code's memory guidelines
// ---------------------------------------------------------------------------

/**
 * Patterns describing content that is derivable from the codebase itself
 * and therefore should NOT be persisted in structured memory.
 *
 * Saving ephemeral or derivable data wastes space and produces stale entries
 * that mislead the agent when recalled later.
 */
const EXCLUDED_PATTERNS: readonly string[] = [
  'code patterns',
  'conventions',
  'architecture',     // derivable from the codebase
  'git history',      // use git log
  'recent changes',   // use git log
  'debugging solutions', // the fix is already in the code
  'ephemeral task details', // use the task system, not memory
];

/**
 * Return true when the memory content is worth persisting.
 *
 * Rejects entries whose content matches one of the EXCLUDED_PATTERNS —
 * these represent knowledge that is either derivable from the codebase or
 * too short-lived to store.
 *
 * @param content - The memory content string to evaluate.
 */
export function shouldSaveMemory(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  const excluded = EXCLUDED_PATTERNS.some((p) => lower.includes(p));
  if (excluded) {
    log.debug({ snippet: content.slice(0, 80) }, 'shouldSaveMemory: excluded pattern matched — skipping');
  }
  return !excluded;
}

/**
 * Return true when a StructuredMemory entry is older than 7 days.
 *
 * Stale memories should be verified against the current codebase before being
 * presented to the agent — they may reference code paths that no longer exist.
 *
 * @param memory - The StructuredMemory record to evaluate.
 */
export function isMemoryStale(memory: StructuredMemory): boolean {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const age = Date.now() - new Date(memory.updatedAt).getTime();
  const stale = age > SEVEN_DAYS_MS;
  if (stale) {
    log.debug({ id: memory.id, updatedAt: memory.updatedAt }, 'isMemoryStale: memory is older than 7 days');
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate that a MemoryType value is one of the four allowed types. */
function assertValidType(type: unknown): asserts type is MemoryType {
  if (!VALID_TYPES.has(type as MemoryType)) {
    throw new Error(`Invalid memory type "${String(type)}". Must be one of: ${[...VALID_TYPES].join(', ')}`);
  }
}

/** Ensure the store directory exists (idempotent). */
async function ensureStoreDir(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a structured memory to disk.
 * If `memory.id` is not provided, a new ID is generated.
 * If a memory with the same ID already exists, it is overwritten.
 *
 * @param memory - Partial memory (id, createdAt, updatedAt are auto-set).
 * @returns The saved StructuredMemory with all fields populated.
 */
export async function saveMemory(
  memory: Omit<StructuredMemory, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): Promise<StructuredMemory> {
  assertValidType(memory.type);

  if (!memory.name?.trim()) throw new Error('StructuredMemory.name must not be empty');
  if (!memory.content?.trim()) throw new Error('StructuredMemory.content must not be empty');

  await ensureStoreDir();

  const now = new Date().toISOString();
  const id = memory.id ?? generateId();

  // Security: scan content for prompt-injection before persisting.
  const safeContent = guardMemoryWrite(memory.content.trim(), 'saveMemory');

  // If updating, preserve original createdAt.
  let createdAt = now;
  try {
    const existing = await getMemory(memory.type, id);
    createdAt = existing.createdAt;
  } catch {
    // New record — use now.
  }

  const record: StructuredMemory = {
    id,
    type: memory.type,
    name: memory.name.trim(),
    description: (memory.description ?? '').trim(),
    content: safeContent,
    createdAt,
    updatedAt: now,
  };

  const fp = filePath(memory.type, id);
  await fs.writeFile(fp, JSON.stringify(record, null, 2), 'utf-8');
  log.info({ type: memory.type, id, name: record.name }, 'Structured memory saved');

  // Contradiction resolution (opt-in, SUDO_MEMORY_SUPERSEDE=1): a newer fact
  // about the same subject (same type+name) supersedes older active ones, so
  // recall returns the current value instead of letting contradictory facts
  // coexist. Superseded records are MARKED (kept for audit), not deleted.
  if (process.env['SUDO_MEMORY_SUPERSEDE'] === '1') {
    try {
      await supersedeConflicts(memory.type, record.name, id, now);
    } catch (err) {
      log.warn({ type: memory.type, name: record.name, err: String(err) }, 'memory supersede: failed (non-fatal)');
    }
  }
  return record;
}

/**
 * Mark every still-active memory of the same `(type, name)` (case-insensitive),
 * other than `keepId`, as superseded by `keepId`. Returns the count superseded.
 */
async function supersedeConflicts(
  type: MemoryType,
  name: string,
  keepId: string,
  now: string,
): Promise<number> {
  const key = name.trim().toLowerCase();
  const actives = await listMemories(type); // excludes already-superseded
  const conflicts = actives.filter((m) => m.id !== keepId && m.name.trim().toLowerCase() === key);
  for (const old of conflicts) {
    const superseded: StructuredMemory = { ...old, supersededBy: keepId, supersededAt: now };
    await fs.writeFile(filePath(type, old.id), JSON.stringify(superseded, null, 2), 'utf-8');
    log.info({ type, name, supersededId: old.id, by: keepId }, 'memory: superseded conflicting fact');
  }
  return conflicts.length;
}

/**
 * Read a single structured memory by type and ID.
 *
 * @throws Error when the record does not exist or cannot be parsed.
 */
export async function getMemory(type: MemoryType, id: string): Promise<StructuredMemory> {
  assertValidType(type);
  if (!id?.trim()) throw new Error('id must not be empty');

  const fp = filePath(type, id);
  let raw: string;
  try {
    raw = await fs.readFile(fp, 'utf-8');
  } catch {
    throw new Error(`Structured memory not found: type=${type} id=${id}`);
  }

  try {
    const parsed = JSON.parse(raw) as StructuredMemory;
    return parsed;
  } catch (err) {
    throw new Error(`Corrupted structured memory file ${fp}: ${String(err)}`);
  }
}

/**
 * List all stored memories, optionally filtered by type.
 *
 * Superseded records (a newer fact won for the same type+name) are excluded by
 * default so recall returns only current facts; pass `{ includeSuperseded: true }`
 * to see them (e.g. for an audit of what was retracted).
 *
 * @param type    - Optional type filter.
 * @param options - `includeSuperseded` (default false).
 * @returns Array of StructuredMemory objects sorted by updatedAt descending.
 */
export async function listMemories(
  type?: MemoryType,
  options?: { includeSuperseded?: boolean },
): Promise<StructuredMemory[]> {
  if (type !== undefined) assertValidType(type);
  await ensureStoreDir();

  let entries: string[];
  try {
    entries = await fs.readdir(STORE_DIR);
  } catch {
    return [];
  }

  const prefix = type ? `${type}_` : '';
  const jsonFiles = entries.filter(f => f.endsWith('.json') && (!prefix || f.startsWith(prefix)));

  const records: StructuredMemory[] = [];
  await Promise.all(
    jsonFiles.map(async (filename) => {
      const fp = path.join(STORE_DIR, filename);
      try {
        const raw = await fs.readFile(fp, 'utf-8');
        const parsed = JSON.parse(raw) as StructuredMemory;
        records.push(parsed);
      } catch (err) {
        log.warn({ file: filename, err: String(err) }, 'Skipping unreadable memory file');
      }
    }),
  );

  const visible = options?.includeSuperseded ? records : records.filter((m) => !m.supersededBy);
  visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  log.debug(
    { type: type ?? 'all', count: visible.length, includeSuperseded: options?.includeSuperseded ?? false },
    'Listed structured memories',
  );
  return visible;
}

/**
 * Delete a structured memory by type and ID.
 *
 * @returns true if deleted, false if it did not exist.
 */
export async function deleteMemory(type: MemoryType, id: string): Promise<boolean> {
  assertValidType(type);
  if (!id?.trim()) throw new Error('id must not be empty');

  const fp = filePath(type, id);
  try {
    await fs.unlink(fp);
    log.info({ type, id }, 'Structured memory deleted');
    return true;
  } catch {
    return false;
  }
}

/**
 * Search memories by keyword across name, description, and content fields.
 * Scoring: name match = 3pts, description match = 2pts, content match = 1pt.
 *
 * @param options - Query, optional type filter, optional limit.
 * @returns Matching memories sorted by relevance score descending.
 */
export async function searchMemories(
  options: MemorySearchOptions,
): Promise<Array<StructuredMemory & { score: number }>> {
  if (!options.query?.trim()) {
    return [];
  }

  const all = await listMemories(options.type);
  const terms = options.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const limit = options.limit ?? 10;

  const scored = all.map(mem => {
    const nameLower = mem.name.toLowerCase();
    const descLower = mem.description.toLowerCase();
    const contentLower = mem.content.toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (nameLower.includes(term)) score += 3;
      if (descLower.includes(term)) score += 2;
      if (contentLower.includes(term)) score += 1;
    }

    return { ...mem, score };
  });

  const results = scored
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  log.debug(
    { query: options.query, type: options.type ?? 'all', hits: results.length },
    'Structured memory search complete',
  );
  return results;
}
