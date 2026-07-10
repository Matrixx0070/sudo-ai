/**
 * @file crash-safe.ts
 * @description Crash-safe session-persistence invariants (gap #17).
 *
 * Two guarantees this module owns:
 *
 *   1. **SQLite never leads JSONL.** Today DualSessionManager.save() writes
 *      the SQLite primary first and the JSONL secondary second. If the
 *      process dies between the two, SQLite has data the journal doesn't —
 *      which means we cannot reconstruct what actually happened from the
 *      authoritative log. The crash-safe path inverts the order (journal
 *      first, with fsync, then SQLite) so a partial write always leaves the
 *      journal as the more-complete store.
 *
 *   2. **Interrupted-turn detection at boot.** When the loop sends a
 *      message-write through DualSessionManager.save() and the process dies
 *      AFTER the journal append but BEFORE the SQLite mirror, on next boot
 *      the journal has more messages than SQLite. `scanInterruptedSessions`
 *      finds these and lets the operator either replay or accept the
 *      divergence — Codex study point #9 "SQLite never leads JSONL".
 *
 * Both guarantees are default ON via SUDO_CRASH_SAFE in cli.ts; set
 * SUDO_CRASH_SAFE=0 to restore the pre-gap-#17 SQLite-first ordering
 * (byte-identical to the legacy path).
 */

import { closeSync, fsyncSync, openSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sessions:crash-safe');

// ---------------------------------------------------------------------------
// fsync helper — durable file flush
// ---------------------------------------------------------------------------

/**
 * Best-effort fsync of a file path. Returns true when the fsync succeeded,
 * false on any failure (file missing, fsync not supported on the volume,
 * race with file rotation). Errors are intentionally swallowed because the
 * caller's higher-level write has already succeeded and the fsync is a
 * durability guarantee, not a correctness one.
 */
export function fsyncFile(filePath: string): boolean {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r+');
    fsyncSync(fd);
    return true;
  } catch (err) {
    log.debug({ filePath, err: String(err) }, 'fsyncFile: best-effort fsync failed');
    return false;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Ephemeral-peer exclusion (B5.1 — reconcile scope fix)
// ---------------------------------------------------------------------------

/**
 * Peer-id patterns for sessions that are machine-generated one-shots, NOT real
 * conversations: cron-isolated runs, swarm sub-agents, autonomy goal smoke-
 * tests, loopback health probes, and the web e2e/drill/probe namespaces. These
 * have no durable canonical mirror and must never be treated as drift (and must
 * never be resurrected by an APPLY backfill — e.g. the purged `verify458`).
 *
 * Matched against the journal index `peerId`. The set is intentionally narrow:
 * it only excludes structurally machine-namespaced peers + the explicit probe
 * names. Any peer NOT matched here still gets canonical-resolution counting
 * (see `resolveCanonicalCount`), so a genuine human peer is never silently
 * dropped from the drift report.
 */
export const EPHEMERAL_PEER_PATTERNS: readonly RegExp[] = [
  /^cron:/,                          // cron:isolated:* scheduled-run sessions
  /^subagent:/,                      // swarm sub-agent ephemeral sessions
  /^goal:/,                          // autonomy goal smoke-tests
  /^127\.0\.0\./,                    // loopback HTTP health probes
  /^web-probe$/,                     // web warmup/health probe
  /^web-e2e/,                        // web end-to-end test peers
  /^web-merge/,                      // web merge-flow test peers
  /^web-listprs$/,                   // web PR-list smoke peer
  /^web-guardb/,                     // web guardrail-branch test peers
  /^web-drill/,                      // web drill test peers
  /^drill-/,                         // drill test peers
  /^reverify-/,                      // re-verification probe peers
  /^verify/,                         // verify* probe peers (incl. the purged verify458)
  /^stt-/,                           // speech-to-text probe peers
  /^claude-nudge/,                   // autonomy nudge probe peers
  /^web-[0-9a-f]{8}-[0-9a-f]{4}-/,   // web-<uuid> one-shot web sessions
  /^web-\d{10,}-/,                   // web-<epoch-ms>-<rand> timestamped web sessions
];

/**
 * True when a (channel, peerId) is an ephemeral machine-generated one-shot that
 * the reconcile/scan should exclude from candidate selection. Default-ON;
 * callers gate it off via `SUDO_RECONCILE_NO_FILTER=1` (passed as
 * `filterEphemeral: false`).
 */
export function isEphemeralPeer(_channel: string, peerId: string): boolean {
  return EPHEMERAL_PEER_PATTERNS.some((re) => re.test(peerId));
}

// ---------------------------------------------------------------------------
// Interrupted-session detection
// ---------------------------------------------------------------------------

export interface InterruptedSession {
  sessionId: string;
  /** Channel from the journal index (telegram, discord, …). */
  channel: string;
  /** Peer id from the journal index. */
  peerId: string;
  /** How many `type: 'message'` events are in the journal file. */
  journalMessageCount: number;
  /** How many messages the SQLite mirror has. */
  primaryMessageCount: number;
  /** Always > 0 when this session is listed; the lag-by-N count. */
  lagBy: number;
}

/**
 * Duck-typed view of `JournalSessionStore` so the scanner can be unit-
 * tested without instantiating the real store. Mirrors the bits used.
 */
export interface CrashSafeJournal {
  listSessions(agentId?: string): Promise<Array<{
    id: string;
    channel: string;
    peerId: string;
    file: string;
  }>>;
}

/**
 * Duck-typed view of `SessionManager` so the scanner can be unit-tested
 * without a real SQLite handle.
 */
export interface CrashSafePrimary {
  get(sessionId: string): Promise<{ messages: unknown[] } | undefined>;
}

/**
 * Count `type: 'message'` events inside a JSONL file. Malformed lines
 * are skipped, missing files yield 0 — both are recoverable conditions
 * that should not turn the boot-time scan into a fatal.
 */
export function countJournalMessages(journalDir: string, relFile: string): number {
  const absFile = path.resolve(journalDir, relFile);
  if (!absFile.startsWith(path.resolve(journalDir) + path.sep)) {
    log.warn({ relFile }, 'countJournalMessages: file escapes journalDir — skipping');
    return 0;
  }
  if (!existsSync(absFile)) return 0;
  let raw: string;
  try {
    raw = readFileSync(absFile, 'utf8');
  } catch (err) {
    log.warn({ absFile, err: String(err) }, 'countJournalMessages: read failed');
    return 0;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { type?: string };
      if (obj.type === 'message') count++;
    } catch { /* skip malformed line */ }
  }
  return count;
}

export interface ScanOptions {
  /** Absolute path to the journal baseDir, used to resolve session files. */
  journalDir: string;
  /**
   * Exclude ephemeral machine-generated peers (see `isEphemeralPeer`) from the
   * candidate set. Default true; set false to scan everything
   * (`SUDO_RECONCILE_NO_FILTER=1`).
   */
  filterEphemeral?: boolean;
  /**
   * Resolve the CANONICAL persisted message count for a (channel, peerId) — the
   * total across every SQLite session row titled `<channel>:<peerId>`. LEGACY
   * journal sessions used non-canonical forked ids (new sessions adopt the
   * primary id at creation since the adoption fix), so the per-id mirror often reads 0
   * even though the messages live under the canonical title (id-namespace
   * mismatch, not loss). When this returns a count ≥ the journal's, the session
   * is NOT drift. Returns null when there is no canonical row.
   */
  resolveCanonicalCount?: (channel: string, peerId: string) => number | null;
}

/**
 * Scan every indexed journal session and report those whose JSONL has more
 * message events than the SQLite mirror. The returned list captures the
 * crash window — events that were appended to the durable log but lost
 * before the queryable mirror saw them.
 *
 * Side-effect-free: returns the list, never replays or mutates either
 * store. Replay is a follow-up slice (the right action depends on the
 * caller — auto-replay vs. operator-prompted vs. quarantine).
 */
export async function scanInterruptedSessions(
  journal: CrashSafeJournal,
  primary: CrashSafePrimary,
  opts: ScanOptions,
): Promise<InterruptedSession[]> {
  const result: InterruptedSession[] = [];
  const filterEphemeral = opts.filterEphemeral !== false;
  const entries = await journal.listSessions();
  for (const entry of entries) {
    if (filterEphemeral && isEphemeralPeer(entry.channel, entry.peerId)) continue;
    const journalMessageCount = countJournalMessages(opts.journalDir, entry.file);
    let primaryMessageCount = 0;
    try {
      const session = await primary.get(entry.id);
      primaryMessageCount = session?.messages.length ?? 0;
    } catch (err) {
      log.warn({ sessionId: entry.id, err: String(err) }, 'scan: primary.get failed — treating as zero');
    }
    // Canonical resolution: the journal id is often a non-canonical fork whose
    // messages already live under the `<channel>:<peerId>` title. Count against
    // the larger of the per-id mirror and the canonical total so the namespace
    // mismatch is not reported as a lost-message interruption.
    const canonical = opts.resolveCanonicalCount?.(entry.channel, entry.peerId);
    const effectiveCount =
      typeof canonical === 'number' ? Math.max(primaryMessageCount, canonical) : primaryMessageCount;
    if (journalMessageCount > effectiveCount) {
      result.push({
        sessionId: entry.id,
        channel: entry.channel,
        peerId: entry.peerId,
        journalMessageCount,
        primaryMessageCount: effectiveCount,
        lagBy: journalMessageCount - effectiveCount,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Crash-safe reconcile — replay JSONL message tail into SQLite (additive-only)
// ---------------------------------------------------------------------------

/**
 * One ordered `type: 'message'` event read back from a journal file. Only the
 * fields the reconcile compares/replays are surfaced.
 */
export interface JournalMessageRecord {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** ISO timestamp from the journal — informational only (not a match key). */
  ts: string;
}

/**
 * Read the ordered `type: 'message'` events from a JSONL journal file.
 * Mirrors `countJournalMessages` but returns the records instead of a count,
 * applying the same path-escape guard, missing-file = empty, and skip-malformed
 * semantics. Non-message events (session/model_change/toolResult) are excluded
 * so the result lines up 1:1 with the SQLite `messages` rows the reconcile
 * compares against.
 */
export function readJournalMessages(journalDir: string, relFile: string): JournalMessageRecord[] {
  const absFile = path.resolve(journalDir, relFile);
  if (!absFile.startsWith(path.resolve(journalDir) + path.sep)) {
    log.warn({ relFile }, 'readJournalMessages: file escapes journalDir — skipping');
    return [];
  }
  if (!existsSync(absFile)) return [];
  let raw: string;
  try {
    raw = readFileSync(absFile, 'utf8');
  } catch (err) {
    log.warn({ absFile, err: String(err) }, 'readJournalMessages: read failed');
    return [];
  }
  const out: JournalMessageRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { type?: string; role?: string; content?: string; ts?: string };
      if (
        obj.type === 'message' &&
        (obj.role === 'user' || obj.role === 'assistant' || obj.role === 'system' || obj.role === 'tool') &&
        typeof obj.content === 'string'
      ) {
        out.push({ role: obj.role, content: obj.content, ts: typeof obj.ts === 'string' ? obj.ts : '' });
      }
    } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Duck-typed view of the SQLite message store (MindDB) the reconcile needs.
 * Mirrors the three MindDB methods used, so the reconcile is unit-testable
 * against a temp DB and never reaches past these primitives.
 */
export interface ReconcilePrimary {
  /** Authoritative persisted message count (NOT the hydrated working-set size). */
  countMessages(sessionId: string): number;
  /** Persisted messages in chronological order, up to `limit`. */
  getSessionMessages(sessionId: string, limit: number): Array<{ role: string; content: string }>;
  /** Append ONE message; returns the new row id. Used only in apply mode. */
  storeMessage(sessionId: string, role: JournalMessageRecord['role'], content: string): number;
}

export interface ReconcileOptions {
  /** Absolute path to the journal baseDir, used to resolve session files. */
  journalDir: string;
  /**
   * When true, INSERT the missing tail into SQLite (after capturing a backup).
   * Default false = DRY-RUN: detect + report only, write NOTHING.
   */
  apply?: boolean;
  /**
   * Directory for per-session pre-apply backups (apply mode only).
   * Defaults to `<journalDir>/.reconcile-backups`.
   */
  backupDir?: string;
  /**
   * Exclude ephemeral machine-generated peers (see `isEphemeralPeer`) from the
   * candidate set. Default true; set false to consider everything
   * (`SUDO_RECONCILE_NO_FILTER=1`).
   */
  filterEphemeral?: boolean;
  /**
   * Resolve the CANONICAL persisted message count for a (channel, peerId) — the
   * total across every SQLite session row titled `<channel>:<peerId>`. LEGACY
   * journal sessions used non-canonical forked ids (new sessions adopt the
   * primary id at creation since the adoption fix), so the per-id mirror often reads 0
   * even though the messages live under the canonical title (id-namespace
   * mismatch, not loss). When the canonical count ≥ the journal's, the session
   * is NOT drift. When it leads but the canonical still trails, the residual is
   * reported but NEVER auto-applied (target session is ambiguous across the
   * namespace). Returns null when there is no canonical row.
   */
  resolveCanonicalCount?: (channel: string, peerId: string) => number | null;
}

export interface ReconcileResult {
  sessionId: string;
  channel: string;
  peerId: string;
  journalMessageCount: number;
  primaryMessageCount: number;
  /** Journal events past the SQLite tail — the additive backfill candidate. */
  missingCount: number;
  /** True when SQLite is a clean (role+content) prefix of the journal. */
  cleanPrefix: boolean;
  /** True only when apply mode ran AND the rows were inserted. */
  applied: boolean;
  /** How many rows were actually inserted (0 in dry-run or when skipped). */
  insertedCount: number;
  /** Set when the session was detected but not reconciled, with the reason. */
  skippedReason?: 'no_lag' | 'divergent_prefix' | 'dry_run' | 'backup_failed' | 'canonical_ambiguous';
}

/**
 * Reconcile sessions whose JSONL journal leads the SQLite mirror by replaying
 * ONLY the missing message tail into SQLite.
 *
 * STRICT SAFETY CONTRACT:
 *  - **Additive-only.** Existing SQLite rows are never updated, deleted, or
 *    reordered — the reconcile only INSERTs the trailing journal events SQLite
 *    is missing. A session is reconciled only when SQLite is a verified clean
 *    prefix (role+content) of the journal; any divergence → skipped (reported,
 *    never mutated) for manual review.
 *  - **Idempotent.** Once the tail is inserted, the next run sees equal counts
 *    (no lag) and no-ops. Re-running is always safe.
 *  - **DRY-RUN by default.** `opts.apply !== true` reports exactly what WOULD
 *    be inserted and writes nothing. Real writes require `apply: true` AND a
 *    successful per-session backup of the existing rows first.
 */
export async function reconcileInterruptedSessions(
  journal: CrashSafeJournal,
  primary: ReconcilePrimary,
  opts: ReconcileOptions,
): Promise<ReconcileResult[]> {
  const apply = opts.apply === true;
  const filterEphemeral = opts.filterEphemeral !== false;
  const backupDir = opts.backupDir ?? path.join(opts.journalDir, '.reconcile-backups');
  const results: ReconcileResult[] = [];
  const entries = await journal.listSessions();

  for (const entry of entries) {
    // Scope fix (B5.1): never reconcile ephemeral machine-generated one-shots —
    // they have no durable canonical mirror and an APPLY would resurrect purged
    // probes (e.g. verify458). Default-ON; SUDO_RECONCILE_NO_FILTER=1 disables.
    if (filterEphemeral && isEphemeralPeer(entry.channel, entry.peerId)) continue;

    const journalMsgs = readJournalMessages(opts.journalDir, entry.file);
    const jCount = journalMsgs.length;

    let sCount: number;
    let sqliteMsgs: Array<{ role: string; content: string }>;
    try {
      sCount = primary.countMessages(entry.id);
      // Pull at least as many rows as the journal has so the prefix overlap is
      // fully comparable even when sCount exceeds the default page size.
      sqliteMsgs = primary.getSessionMessages(entry.id, Math.max(jCount, sCount, 1));
    } catch (err) {
      log.warn({ sessionId: entry.id, err: String(err) }, 'reconcile: primary read failed — skipping session');
      continue;
    }

    // Canonical resolution (B5.1): journal sessions use non-canonical forked
    // ids whose per-id mirror reads 0, but their messages already live under the
    // `<channel>:<peerId>` titled session(s). When the canonical total already
    // holds ≥ the journal's messages there is NO loss — skip silently (the
    // telegram:8087386717 case: 689 canonical ≥ any 64-msg journal fork).
    const canonicalCount = opts.resolveCanonicalCount?.(entry.channel, entry.peerId) ?? null;
    if (canonicalCount !== null && canonicalCount > sCount) {
      if (jCount <= canonicalCount) continue; // already persisted under the canonical title
      // Residual: the journal leads even the canonical total. Report the true
      // missing count but NEVER auto-apply — the target session is ambiguous
      // across the namespace (messages are split over multiple canonical rows),
      // so a safe backfill needs operator routing, not an INSERT into the fork id.
      log.warn(
        { sessionId: entry.id, channel: entry.channel, peerId: entry.peerId, journalMessageCount: jCount, canonicalCount },
        'reconcile: journal leads the canonical mirror — reporting residual drift, NOT applying (ambiguous target)',
      );
      results.push({
        sessionId: entry.id,
        channel: entry.channel,
        peerId: entry.peerId,
        journalMessageCount: jCount,
        primaryMessageCount: canonicalCount,
        missingCount: jCount - canonicalCount,
        cleanPrefix: true,
        applied: false,
        insertedCount: 0,
        skippedReason: 'canonical_ambiguous',
      });
      continue;
    }

    // Additive-only guard: only a journal that LEADS SQLite is a backfill
    // candidate. Equal/behind (e.g. SQLite holds tool rows the journal logs as
    // separate toolResult events) is never over-written.
    if (jCount <= sCount) continue;

    const base = {
      sessionId: entry.id,
      channel: entry.channel,
      peerId: entry.peerId,
      journalMessageCount: jCount,
      primaryMessageCount: sCount,
    };

    // Verify SQLite is a clean prefix of the journal over the overlap.
    let cleanPrefix = true;
    const overlap = Math.min(sCount, sqliteMsgs.length);
    for (let i = 0; i < overlap; i++) {
      const j = journalMsgs[i]!;
      const s = sqliteMsgs[i]!;
      if (j.role !== s.role || j.content !== s.content) {
        cleanPrefix = false;
        break;
      }
    }

    const tail = journalMsgs.slice(sCount);
    const missingCount = tail.length;

    if (!cleanPrefix) {
      log.warn(
        { ...base, missingCount },
        'reconcile: SQLite is NOT a clean prefix of the journal — divergent, skipping (manual review)',
      );
      results.push({ ...base, missingCount, cleanPrefix: false, applied: false, insertedCount: 0, skippedReason: 'divergent_prefix' });
      continue;
    }

    if (!apply) {
      log.info(
        { ...base, wouldInsert: missingCount },
        'reconcile DRY-RUN: would backfill missing journal messages (no write)',
      );
      results.push({ ...base, missingCount, cleanPrefix: true, applied: false, insertedCount: 0, skippedReason: 'dry_run' });
      continue;
    }

    // APPLY mode: capture a backup of the existing rows BEFORE inserting.
    try {
      mkdirSync(backupDir, { recursive: true });
      // Expire backup files older than 7 days to prevent unbounded accumulation.
      const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      for (const f of readdirSync(backupDir)) {
        const fp = path.join(backupDir, f);
        try { if (Date.now() - statSync(fp).mtimeMs > ONE_WEEK_MS) unlinkSync(fp); } catch { /* non-fatal */ }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(backupDir, `${entry.id}.${stamp}.json`);
      writeFileSync(
        backupFile,
        JSON.stringify({ sessionId: entry.id, capturedAt: new Date().toISOString(), existingCount: sCount, existing: sqliteMsgs.slice(0, sCount) }, null, 2),
        { encoding: 'utf8', mode: 0o600 }, // owner-only: session content is PII
      );
    } catch (err) {
      log.warn({ ...base, err: String(err) }, 'reconcile: backup capture failed — NOT applying (safety)');
      results.push({ ...base, missingCount, cleanPrefix: true, applied: false, insertedCount: 0, skippedReason: 'backup_failed' });
      continue;
    }

    let inserted = 0;
    for (const m of tail) {
      primary.storeMessage(entry.id, m.role, m.content);
      inserted++;
    }
    log.info({ ...base, inserted }, 'reconcile APPLY: backfilled missing journal messages into SQLite');
    results.push({ ...base, missingCount, cleanPrefix: true, applied: true, insertedCount: inserted });
  }

  return results;
}
