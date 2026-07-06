/**
 * @file auto-dream.ts
 * @description AutoDream — 4-phase LLM-driven memory consolidation for SUDO-AI v5.
 *
 * Phase 1 COLLECT  : Read last N session messages from mind.db (last 24 h / 1000 msgs).
 * Phase 2 SYNTHESIZE: Extract key facts, decisions, patterns → store as 'declarative' chunks.
 * Phase 3 PRUNE    : Soft-delete duplicate/low-relevance chunks older than 30 days.
 * Phase 4 LINK     : Create knowledge-graph edges between new chunks and related nodes.
 *
 * Safety: PID-based lock file at /tmp/sudo-ai-dream.lock prevents concurrent runs.
 */

import Database from 'better-sqlite3';
import { existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { PATHS } from '../shared/constants.js';

const log = createLogger('memory:auto-dream');

const LOCK_FILE = '/tmp/sudo-ai-dream.lock';
const COLLECT_HOURS = 24;
const COLLECT_LIMIT = 1000;
const PRUNE_DAYS = 30;
const MAX_FACT_LENGTH = 500;
const MAX_MEMORY_FILE_BYTES = 50 * 1024; // 50 KB

/**
 * Headroom margin for the pre-append trim check. Trimming only at >= cap left
 * a deadband [cap - lineSize, cap): the file was under the cap (never
 * trimmed) yet every append would exceed it (append loop breaks) — promotion
 * silently stuck at 0 once the file drifted into that band. Trimming whenever
 * the file is within one append-batch of the cap removes the deadband.
 */
const APPEND_HEADROOM_BYTES = 4096;

/** True when MEMORY.md must be trimmed BEFORE appending. Exported for tests. */
export function needsPreAppendTrim(existingBytes: number, cap: number = MAX_MEMORY_FILE_BYTES): boolean {
  return existingBytes + APPEND_HEADROOM_BYTES >= cap;
}

/**
 * Trim a MEMORY.md body to fit under `targetBytes` by dropping the OLDEST dated
 * entries (lines starting with "- ["), keeping the header and the newest entries.
 * Append-only growth means the oldest entries are at the top, so this is a rolling
 * buffer: memory promotion never stalls at the cap. Returns the rebuilt body plus
 * the trimmed lines (for archiving). At least one entry is always kept.
 */
export function trimMemoryToFit(content: string, targetBytes: number): { kept: string; trimmed: string[] } {
  const lines = content.split('\n');
  const firstEntryIdx = lines.findIndex((l) => l.startsWith('- ['));
  if (firstEntryIdx < 0) return { kept: content, trimmed: [] };

  const header = lines.slice(0, firstEntryIdx);
  const kept = lines.slice(firstEntryIdx).filter((l) => l.startsWith('- ['));
  const trimmed: string[] = [];
  const rebuild = (): string => [...header, ...kept].join('\n').replace(/\n*$/, '\n');

  while (kept.length > 1 && Buffer.byteLength(rebuild(), 'utf-8') > targetBytes) {
    const dropped = kept.shift();
    if (dropped) trimmed.push(dropped);
  }
  return { kept: rebuild(), trimmed };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamReport {
  phase: 'complete' | 'skipped' | 'error';
  chunksCollected: number;
  factsSynthesized: number;
  chunksPruned: number;
  linksCreated: number;
  durationMs: number;
  error?: string;
}

interface HookManager {
  emit: (event: string, payload?: unknown) => void;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at?: string;
}

interface ChunkRow {
  id: number;
  text: string;
  hash: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function acquireLock(): boolean {
  const tryCreate = (): boolean => {
    try {
      // Exclusive create: fails atomically with EEXIST if a lock already exists,
      // so two concurrent runs can never both claim the lock.
      writeFileSync(LOCK_FILE, String(process.pid), { encoding: 'utf-8', flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  // Fast path: no lock present — atomically create it.
  if (tryCreate()) return true;

  // A lock file exists. Decide whether it is stale (dead/own PID) and stealable.
  let stale = true;
  try {
    const raw = readFileSync(LOCK_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && pid !== process.pid) {
      // Check if the PID is still alive
      try {
        process.kill(pid, 0);
        log.warn({ pid }, 'Dream lock held by another process — skipping');
        stale = false;
      } catch {
        // PID is dead — stale lock, proceed to steal it
        log.info({ pid }, 'Removing stale dream lock');
      }
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Could not read lock file — treating as stale');
  }

  if (!stale) return false;

  // Steal the stale lock, then re-acquire atomically. If another process
  // recreated the lock in the meantime, the exclusive create fails and we back
  // off rather than clobbering an active lock.
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Another process may have already removed/replaced it — fall through.
  }
  return tryCreate();
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to release dream lock');
  }
}

// ---------------------------------------------------------------------------
// AutoDream
// ---------------------------------------------------------------------------

export class AutoDream {
  private readonly brainCall: (prompt: string) => Promise<string>;
  private readonly db: Database.Database;
  private readonly hookManager?: HookManager;
  /**
   * Optional post-write hook fired once per newly-stored synthesized fact (by
   * chunk id). Wired in cli.ts to semantic contradiction resolution so a dreamed
   * fact that contradicts an earlier one supersedes it. Fail-open — a throw here
   * never blocks the dream. See chunk-contradiction.ts.
   */
  private readonly onFactStored?: (chunkId: number) => Promise<void>;

  constructor(
    brainCall: (prompt: string) => Promise<string>,
    db: Database.Database,
    hookManager?: HookManager,
    onFactStored?: (chunkId: number) => Promise<void>,
  ) {
    if (typeof brainCall !== 'function') throw new TypeError('brainCall must be a function');
    this.brainCall = brainCall;
    this.db = db;
    this.hookManager = hookManager;
    this.onFactStored = onFactStored;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async runDream(): Promise<DreamReport> {
    const start = Date.now();

    if (!acquireLock()) {
      return {
        phase: 'skipped',
        chunksCollected: 0,
        factsSynthesized: 0,
        chunksPruned: 0,
        linksCreated: 0,
        durationMs: Date.now() - start,
      };
    }

    this._emit('dream:start', { startedAt: new Date().toISOString() });
    log.info('AutoDream started');

    let chunksCollected = 0;
    let factsSynthesized = 0;
    let chunksPruned = 0;
    let linksCreated = 0;

    try {
      // Phase 1 — COLLECT
      const messages = this._collectMessages();
      chunksCollected = messages.length;
      log.info({ count: chunksCollected }, 'Phase 1: messages collected');

      // Phase 2 — SYNTHESIZE
      if (chunksCollected > 0) {
        factsSynthesized = await this._synthesize(messages);
        log.info({ factsSynthesized }, 'Phase 2: facts synthesized');
      }

      // Phase 3 — PRUNE
      chunksPruned = this._prune();
      log.info({ chunksPruned }, 'Phase 3: chunks pruned');

      // Phase 4 — LINK
      linksCreated = await this._link();
      log.info({ linksCreated }, 'Phase 4: links created');

      const report: DreamReport = {
        phase: 'complete',
        chunksCollected,
        factsSynthesized,
        chunksPruned,
        linksCreated,
        durationMs: Date.now() - start,
      };

      this._emit('dream:end', report);
      log.info(report, 'AutoDream complete');
      return report;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ err: error }, 'AutoDream failed');
      const report: DreamReport = {
        phase: 'error',
        chunksCollected,
        factsSynthesized,
        chunksPruned,
        linksCreated,
        durationMs: Date.now() - start,
        error,
      };
      this._emit('dream:end', report);
      return report;
    } finally {
      releaseLock();
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: Collect
  // -------------------------------------------------------------------------

  private _collectMessages(): MessageRow[] {
    const cutoff = new Date(Date.now() - COLLECT_HOURS * 60 * 60 * 1000).toISOString();

    try {
      // Check if messages table has a created_at column; fall back to id ordering
      const tableInfo = this.db
        .prepare("PRAGMA table_info(messages)")
        .all() as Array<{ name: string }>;

      const hasCreatedAt = tableInfo.some(col => col.name === 'created_at');

      if (hasCreatedAt) {
        return this.db
          .prepare<{ cutoff: string; limit: number }>(
            `SELECT id, session_id, role, content, created_at
             FROM messages
             WHERE created_at >= :cutoff
             ORDER BY id DESC
             LIMIT :limit`,
          )
          .all({ cutoff, limit: COLLECT_LIMIT }) as MessageRow[];
      } else {
        return this.db
          .prepare<{ limit: number }>(
            `SELECT id, session_id, role, content
             FROM messages
             ORDER BY id DESC
             LIMIT :limit`,
          )
          .all({ limit: COLLECT_LIMIT }) as MessageRow[];
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Phase 1: messages query failed, returning empty');
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Synthesize
  // -------------------------------------------------------------------------

  private async _synthesize(messages: MessageRow[]): Promise<number> {
    const transcript = messages
      .slice(0, 200)
      .map(m => `[${m.role}]: ${m.content.slice(0, 500)}`)
      .join('\n');

    const prompt = `You are a memory consolidation engine. Analyze the following conversation transcript and extract 3-10 key facts, decisions, or patterns worth remembering long-term. Each fact should be self-contained and specific.

Transcript:
${transcript}

Output a JSON array of strings — one string per fact. Example:
["User prefers concise responses", "Project uses ESM modules", "Error on tool X is often due to missing config"]

Output ONLY the JSON array, nothing else.`;

    let facts: string[] = [];
    try {
      const response = await this.brainCall(prompt);
      const trimmed = response.trim();
      const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          facts = parsed
            .filter(f => typeof f === 'string' && f.trim().length > 0)
            .map(f => (f as string).trim().slice(0, MAX_FACT_LENGTH));
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Phase 2: brain call failed or returned invalid JSON');
      return 0;
    }

    let stored = 0;
    for (const fact of facts) {
      const factTrimmed = fact.trim();
      if (!factTrimmed) continue;

      const hash = sha256(factTrimmed);
      try {
        // Check for existing chunk with same hash
        const existing = this.db
          .prepare<{ hash: string }>('SELECT id FROM chunks WHERE hash = :hash')
          .get({ hash });

        if (existing) continue;

        const info = this.db.prepare(`
          INSERT INTO chunks (text, path, source, hash, is_evergreen)
          VALUES (:text, :path, :source, :hash, :is_evergreen)
        `).run({
          text: factTrimmed,
          path: 'memory/auto-dream',
          source: 'learning',
          hash,
          is_evergreen: 0,
        });
        stored++;

        // Post-write: resolve semantic contradictions against earlier facts
        // (opt-in, fail-open — never blocks the dream).
        if (this.onFactStored) {
          try {
            await this.onFactStored(info.lastInsertRowid as number);
          } catch (err) {
            log.warn({ err: String(err), hash }, 'Phase 2: onFactStored hook failed (non-fatal)');
          }
        }
      } catch (err) {
        log.warn({ err: String(err), hash }, 'Phase 2: failed to store fact chunk');
      }
    }

    // Phase 5 — Promote new facts to workspace/MEMORY.md
    if (facts.length > 0) {
      try {
        const promoted = await this._promoteToMemoryMd(facts);
        log.info({ promoted }, 'Phase 2.5: facts promoted to MEMORY.md');
      } catch (err) {
        log.warn({ err: String(err) }, 'Phase 2.5: _promoteToMemoryMd failed (non-fatal)');
      }
    }

    return stored;
  }

  // -------------------------------------------------------------------------
  // Phase 2.5: Promote to MEMORY.md
  // -------------------------------------------------------------------------

  /**
   * Append newly synthesized facts to workspace/MEMORY.md for long-term
   * human-readable reference.
   *
   * Algorithm:
   *   1. Read (or create) workspace/MEMORY.md.
   *   2. For each fact, skip if the exact text already appears in the file.
   *   3. Write new facts as `- [YYYY-MM-DD] {fact}` lines.
   *   4. Atomically replace the file (write to .tmp then rename).
   *
   * @param facts - Array of fact strings extracted by the LLM.
   * @returns Number of facts actually appended.
   */
  private async _promoteToMemoryMd(facts: string[]): Promise<number> {
    if (!facts.length) return 0;

    const workspaceDir = path.resolve(PATHS.WORKSPACE);
    const memoryPath = path.join(workspaceDir, 'MEMORY.md');
    const tmpPath = memoryPath + '.tmp';

    // Ensure workspace directory exists
    try {
      mkdirSync(workspaceDir, { recursive: true });
    } catch (err) {
      log.warn({ workspaceDir, err: String(err) }, '_promoteToMemoryMd: cannot create workspace dir');
    }

    // Read existing content (create with header if absent)
    let existing = '';
    if (existsSync(memoryPath)) {
      try {
        existing = readFileSync(memoryPath, 'utf-8');
      } catch (err) {
        log.warn({ memoryPath, err: String(err) }, '_promoteToMemoryMd: cannot read MEMORY.md');
      }
    } else {
      existing = '# Long-Term Memory\n\n';
    }

    // Near/at cap: self-heal instead of silently dropping new learnings. Trim
    // the oldest dated entries down to 80% of the cap (rolling buffer),
    // archiving the trimmed lines so nothing is permanently lost, then continue
    // appending. The trigger includes a headroom margin: trimming only at
    // >= cap left a deadband [cap - lineSize, cap) where the file was under the
    // cap (never trimmed) but every append would exceed it (loop break below) —
    // promotion sat at 0 indefinitely once the file drifted into that band.
    if (needsPreAppendTrim(Buffer.byteLength(existing, 'utf-8'))) {
      const { kept, trimmed } = trimMemoryToFit(existing, Math.floor(MAX_MEMORY_FILE_BYTES * 0.8));
      if (trimmed.length > 0) {
        this._archiveTrimmedMemory(workspaceDir, trimmed);
        existing = kept;
        log.info(
          { memoryPath, trimmedCount: trimmed.length, newSize: Buffer.byteLength(existing, 'utf-8') },
          '_promoteToMemoryMd: MEMORY.md was at cap — trimmed oldest entries to make room',
        );
      } else {
        log.warn({ memoryPath, size: existing.length }, '_promoteToMemoryMd: MEMORY.md at max size and not trimmable — skipping append');
        return 0;
      }
    }

    // Build today's date prefix
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    let appended = 0;
    let content = existing;

    for (const fact of facts) {
      // Facts are already capped to MAX_FACT_LENGTH by _synthesize; trim for safety
      const factTrimmed = fact.trim().slice(0, MAX_FACT_LENGTH);
      if (!factTrimmed) continue;

      // Skip if the exact fact text is already anywhere in the file
      if (content.includes(factTrimmed)) continue;

      // Stop growing if we would exceed the size cap
      const lineToAdd = `- [${today}] ${factTrimmed}\n`;
      if (Buffer.byteLength(content + lineToAdd, 'utf-8') > MAX_MEMORY_FILE_BYTES) break;

      content += lineToAdd;
      appended++;
    }

    if (appended === 0) return 0;

    // Atomic write: write to .tmp then rename
    try {
      writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'w' });
      renameSync(tmpPath, memoryPath);
      log.debug({ memoryPath, appended }, '_promoteToMemoryMd: wrote MEMORY.md');
    } catch (err) {
      // Cleanup orphaned .tmp file if rename failed
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }

    return appended;
  }

  /**
   * Append trimmed (oldest) memory lines to MEMORY.archive.md so the rolling
   * buffer never permanently loses a learning. The archive is NOT loaded into the
   * system prompt. Best-effort; never throws.
   */
  private _archiveTrimmedMemory(workspaceDir: string, trimmedLines: string[]): void {
    try {
      const archivePath = path.join(workspaceDir, 'MEMORY.archive.md');
      const header = existsSync(archivePath) ? '' : '# Long-Term Memory — Archive (trimmed from MEMORY.md)\n\n';
      appendFileSync(archivePath, header + trimmedLines.join('\n') + '\n', 'utf-8');
    } catch (err) {
      log.warn({ err: String(err) }, '_promoteToMemoryMd: failed to archive trimmed memory (non-fatal)');
    }
  }

  /**
   * Trim MEMORY.md back under the cap if it's currently over — independent of
   * the dream cycle and of whether there are new facts. Call once on boot so an
   * over-cap file is healed promptly (within a restart) instead of waiting up to
   * a full dream interval. Reuses the same rolling-buffer trim + archive as the
   * promote path. Best-effort; never throws. Returns the entries trimmed.
   */
  healMemoryFileIfOverCap(workspaceDir: string = path.resolve(PATHS.WORKSPACE)): number {
    const memoryPath = path.join(workspaceDir, 'MEMORY.md');
    if (!existsSync(memoryPath)) return 0;

    let existing: string;
    try {
      existing = readFileSync(memoryPath, 'utf-8');
    } catch (err) {
      log.warn({ memoryPath, err: String(err) }, 'healMemoryFileIfOverCap: cannot read MEMORY.md');
      return 0;
    }
    if (Buffer.byteLength(existing, 'utf-8') < MAX_MEMORY_FILE_BYTES) return 0;

    const { kept, trimmed } = trimMemoryToFit(existing, Math.floor(MAX_MEMORY_FILE_BYTES * 0.8));
    if (trimmed.length === 0) return 0;

    this._archiveTrimmedMemory(workspaceDir, trimmed);
    const tmpPath = memoryPath + '.tmp';
    try {
      writeFileSync(tmpPath, kept, { encoding: 'utf-8', flag: 'w' });
      renameSync(tmpPath, memoryPath);
      log.info(
        { memoryPath, trimmedCount: trimmed.length, newSize: Buffer.byteLength(kept, 'utf-8') },
        'healMemoryFileIfOverCap: MEMORY.md was over cap — trimmed oldest entries under cap',
      );
    } catch (err) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort */ }
      log.warn({ memoryPath, err: String(err) }, 'healMemoryFileIfOverCap: write failed (non-fatal)');
      return 0;
    }
    return trimmed.length;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Prune
  // -------------------------------------------------------------------------

  /**
   * Sentinel for `superseded_by` on age-pruned chunks: no successor chunk
   * exists, but the row must be retired from recall. 0 never collides with a
   * real chunk id (AUTOINCREMENT starts at 1), and every reader already
   * filters on `superseded_by IS NULL`, so pruned rows drop out of
   * hybrid-search and contradiction candidates exactly like superseded ones.
   * Rows are kept for audit, matching the contradiction-resolution convention.
   */
  static readonly PRUNED_BY_AGE_SENTINEL = 0;

  private _prune(): number {
    const cutoff = new Date(Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    try {
      // Retire old non-evergreen learning chunks via the live soft-delete
      // convention (superseded_by/superseded_at). The previous implementation
      // targeted an `is_active` column that exists in no deployed schema and,
      // even if added, no reader consults — it skipped on every run.
      const result = this.db.prepare(`
        UPDATE chunks
        SET superseded_by = :sentinel,
            superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE is_evergreen = 0
          AND source = 'learning'
          AND created_at < :cutoff
          AND superseded_by IS NULL
      `).run({ cutoff, sentinel: AutoDream.PRUNED_BY_AGE_SENTINEL });

      return result.changes;
    } catch (err) {
      log.warn({ err: String(err) }, 'Phase 3: prune query failed');
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4: Link
  // -------------------------------------------------------------------------

  private async _link(): Promise<number> {
    // Retrieve recently created dream chunks to link
    let recentChunks: ChunkRow[] = [];
    try {
      recentChunks = this.db
        .prepare<{ limit: number }>(
          `SELECT id, text, hash, created_at
           FROM chunks
           WHERE source = 'learning'
           ORDER BY id DESC
           LIMIT 20`,
        )
        .all({ limit: 20 }) as ChunkRow[];
    } catch (err) {
      log.warn({ err: String(err) }, 'Phase 4: could not fetch recent chunks');
      return 0;
    }

    if (recentChunks.length < 2) return 0;

    // Check if knowledge_graph edges table exists
    try {
      this.db.prepare("SELECT 1 FROM knowledge_graph_edges LIMIT 1").get();
    } catch {
      log.info('Phase 4: knowledge_graph_edges table not found — skipping link phase');
      return 0;
    }

    let linksCreated = 0;

    for (let i = 0; i < recentChunks.length - 1; i++) {
      const src = recentChunks[i];
      const dst = recentChunks[i + 1];
      if (!src || !dst) continue;

      try {
        const edgeHash = sha256(`dream-link:${src.id}:${dst.id}`);
        const existing = this.db
          .prepare<{ hash: string }>('SELECT id FROM knowledge_graph_edges WHERE hash = :hash LIMIT 1')
          .get({ hash: edgeHash });

        if (existing) continue;

        this.db.prepare(`
          INSERT INTO knowledge_graph_edges (from_id, to_id, relation, weight, hash)
          VALUES (:from_id, :to_id, :relation, :weight, :hash)
        `).run({
          from_id: src.id,
          to_id: dst.id,
          relation: 'dream-associated',
          weight: 0.5,
          hash: edgeHash,
        });
        linksCreated++;
      } catch (err) {
        log.warn({ err: String(err), srcId: src.id, dstId: dst.id }, 'Phase 4: failed to create edge');
      }
    }

    return linksCreated;
  }

  // -------------------------------------------------------------------------
  // Hook emission
  // -------------------------------------------------------------------------

  private _emit(event: string, payload?: unknown): void {
    if (!this.hookManager) return;
    try {
      this.hookManager.emit(event, payload);
    } catch (err) {
      log.warn({ event, err: String(err) }, 'Hook emission failed');
    }
  }
}
