/**
 * @file loop-pattern-extras.ts
 * @description Doom-loop detection extras (gap #23) — two new pattern
 * classes that complement the existing `LoopGuard` (identical tool+args
 * repeats) and `DoomLoopDetector` (cross-turn repeats).
 *
 * Both classes are PURE (no I/O) and EVENTING-FREE so they can be unit
 * tested without spinning up a HookManager or AgentLoop. Each exposes
 * the same shape as the existing detectors:
 *
 *   recordCall(toolName, args) → { action: 'allow' | 'warn' | 'abort', reason? }
 *   onNewTurn()                — reset per-turn dedup state (warned keys)
 *
 * The two classes:
 *
 * 1. `WriteCycleDetector` — Grok playbook "model writes + rewrites the
 *    same file in a loop". Tracks writes by file path; counts when the
 *    same path is written multiple times. Idempotent re-writes
 *    (identical content) are NOT counted — only true cycles where the
 *    content keeps changing trigger a warn/abort.
 *
 * 2. `PollingStagnationDetector` — Grok playbook "polling the same
 *    file/URL until it changes; nothing else happens between checks".
 *    Tracks consecutive reads of the same path with no intervening
 *    write tool call between them. Breaks the count when ANY write
 *    tool fires (the model made progress).
 *
 * Thresholds default to safe values and are env-overridable. Both
 * detectors share the warn-then-abort pattern: a warn at the first
 * threshold (advisory; injected into the loop's context as a system
 * message), an abort at the second threshold (terminal).
 *
 * Opt-in via the SUDO_DOOM_LOOP_EXTRAS=1 process env var (read in
 * AgentLoop's class field initialisers, so set it BEFORE launching).
 * AgentLoop instantiates the detectors lazily and the hot-path skips
 * them entirely when the flag is off.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:doom-loop-extras');

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface PatternDetectorResult {
  action: 'allow' | 'warn' | 'abort';
  reason?: string;
}

/**
 * Tool name patterns we treat as "write-class". Strict literal matches
 * to keep the false-positive rate low — a wildcard catch-all would
 * blow up the write-cycle detector on read-class tools whose name
 * accidentally contains "write".
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'coder.write-file',
  'coder.apply-patch',
  'coder.edit-file',
  'fs.write',
  'fs.write-file',
  'files.write',
  'memory.save',
  'memory.write',
]);

/**
 * Tool name patterns we treat as "read-class" for polling stagnation
 * detection. Reading the same path with no intervening write IS the
 * stagnation signal.
 */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'coder.read-file',
  'coder.list-directory',
  'coder.list-files',
  'fs.read',
  'fs.read-file',
  'fs.stat',
  'fs.list',
  'files.read',
  'web.fetch',
  'memory.search',
  'memory.query',
]);

/**
 * Argument keys we treat as the "target identity" of a tool call —
 * checked in order; first match wins. Most file tools use `path`;
 * some use `file`, `target`, or `url` (for web.fetch).
 */
const TARGET_KEYS: ReadonlyArray<string> = ['path', 'file', 'filepath', 'filePath', 'url', 'target'];

function extractTarget(args: Record<string, unknown>): string | null {
  for (const key of TARGET_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function extractContent(args: Record<string, unknown>): string {
  const c = args['content'] ?? args['text'] ?? args['body'] ?? args['patch'];
  return typeof c === 'string' ? c : JSON.stringify(c ?? '');
}

/**
 * Stable short hash of a content string — fast, non-cryptographic, ok
 * for in-memory dedup. Same algorithm shape as DoomLoopDetector's
 * `_hashArgs`.
 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function readThreshold(envName: string, fallback: number): number {
  const raw = process.env[envName];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------
// WriteCycleDetector
// ---------------------------------------------------------------------------

interface WriteCycleEntry {
  count: number;
  lastContentHash: string;
}

export class WriteCycleDetector {
  /** Map of file path → write history. */
  private byPath = new Map<string, WriteCycleEntry>();
  /** Paths that already triggered a warn — avoid re-spam in the same session. */
  private warnedPaths = new Set<string>();
  private readonly warnThreshold: number;
  private readonly abortThreshold: number;

  constructor() {
    this.warnThreshold = readThreshold('SUDO_WRITE_CYCLE_WARN', 4);
    this.abortThreshold = readThreshold('SUDO_WRITE_CYCLE_ABORT', 8);
    if (this.warnThreshold >= this.abortThreshold) {
      log.warn(
        { warnThreshold: this.warnThreshold, abortThreshold: this.abortThreshold },
        'WriteCycleDetector: warn threshold >= abort threshold — warn will never fire (verifier MED #2)',
      );
    }
    log.info(
      { warnThreshold: this.warnThreshold, abortThreshold: this.abortThreshold },
      'WriteCycleDetector initialised',
    );
  }

  recordCall(toolName: string, args: Record<string, unknown>): PatternDetectorResult {
    if (!WRITE_TOOL_NAMES.has(toolName)) return { action: 'allow' };
    const path = extractTarget(args);
    if (!path) return { action: 'allow' };
    const contentHash = shortHash(extractContent(args));

    const existing = this.byPath.get(path);
    if (!existing) {
      this.byPath.set(path, { count: 1, lastContentHash: contentHash });
      return { action: 'allow' };
    }

    // Idempotent rewrite — not a cycle. Refresh the timestamp but do
    // not bump the count, because the model is not actually thrashing.
    if (existing.lastContentHash === contentHash) {
      return { action: 'allow' };
    }

    existing.count++;
    existing.lastContentHash = contentHash;

    if (existing.count >= this.abortThreshold) {
      return {
        action: 'abort',
        reason: `write-cycle: ${path} has been rewritten ${existing.count} times with different content (threshold ${this.abortThreshold}). The model appears to be thrashing.`,
      };
    }
    if (existing.count >= this.warnThreshold && !this.warnedPaths.has(path)) {
      this.warnedPaths.add(path);
      return {
        action: 'warn',
        reason: `write-cycle: ${path} has been rewritten ${existing.count} times with different content (threshold ${this.warnThreshold}). Consider pausing to plan before the next write.`,
      };
    }
    return { action: 'allow' };
  }

  onNewTurn(): void { /* counts are cross-turn; nothing to reset */ }

  /** Test-only — exposed for assertion. */
  getCount(path: string): number {
    return this.byPath.get(path)?.count ?? 0;
  }
}

// ---------------------------------------------------------------------------
// PollingStagnationDetector
// ---------------------------------------------------------------------------

interface PollingEntry {
  /** How many consecutive reads of this path have happened with no write between them. */
  consecutiveReads: number;
}

export class PollingStagnationDetector {
  /** Map of target path → consecutive-read count. */
  private byPath = new Map<string, PollingEntry>();
  /** Paths that already warned — avoid re-spam. */
  private warnedPaths = new Set<string>();
  private readonly warnThreshold: number;
  private readonly abortThreshold: number;

  constructor() {
    this.warnThreshold = readThreshold('SUDO_POLL_STAGNATION_WARN', 5);
    this.abortThreshold = readThreshold('SUDO_POLL_STAGNATION_ABORT', 10);
    if (this.warnThreshold >= this.abortThreshold) {
      log.warn(
        { warnThreshold: this.warnThreshold, abortThreshold: this.abortThreshold },
        'PollingStagnationDetector: warn threshold >= abort threshold — warn will never fire',
      );
    }
    log.info(
      { warnThreshold: this.warnThreshold, abortThreshold: this.abortThreshold },
      'PollingStagnationDetector initialised',
    );
  }

  recordCall(toolName: string, args: Record<string, unknown>): PatternDetectorResult {
    // A write tool clears the consecutive-read counter ONLY for the
    // path being written — the model made progress on that path, so
    // any prior reads of it should not count toward stagnation.
    // Reads of other paths remain tracked (verifier HIGH #1: the
    // previous global-clear on any write was trivially defeatable in
    // multi-file sessions — a write to file A would silently reset a
    // legitimate polling loop on file B).
    if (WRITE_TOOL_NAMES.has(toolName)) {
      const writePath = extractTarget(args);
      if (writePath) this.byPath.delete(writePath);
      return { action: 'allow' };
    }
    if (!READ_TOOL_NAMES.has(toolName)) return { action: 'allow' };

    const path = extractTarget(args);
    if (!path) return { action: 'allow' };

    const entry = this.byPath.get(path);
    const updated: PollingEntry = entry
      ? { consecutiveReads: entry.consecutiveReads + 1 }
      : { consecutiveReads: 1 };
    this.byPath.set(path, updated);

    if (updated.consecutiveReads >= this.abortThreshold) {
      return {
        action: 'abort',
        reason: `polling-stagnation: ${path} has been read ${updated.consecutiveReads} times consecutively with no intervening write (threshold ${this.abortThreshold}). The model appears to be polling without making progress.`,
      };
    }
    if (updated.consecutiveReads >= this.warnThreshold && !this.warnedPaths.has(path)) {
      this.warnedPaths.add(path);
      return {
        action: 'warn',
        reason: `polling-stagnation: ${path} has been read ${updated.consecutiveReads} times consecutively with no intervening write (threshold ${this.warnThreshold}). Consider a different approach.`,
      };
    }
    return { action: 'allow' };
  }

  onNewTurn(): void { /* cross-turn — nothing to reset */ }

  /** Test-only — exposed for assertion. */
  getCount(path: string): number {
    return this.byPath.get(path)?.consecutiveReads ?? 0;
  }
}
