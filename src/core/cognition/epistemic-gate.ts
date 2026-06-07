/**
 * EpistemicGate — Primitive D (Wave 6F Builder C)
 *
 * Classifies the epistemic confidence of an LLM rationale and gates
 * tool dispatch based on (tag × impact) matrix. Pure functions +
 * optional class wrapper with SQLite log.
 *
 * File boundary: this file + tests/cognition/epistemic-gate.test.ts only.
 * DO NOT import classifyRisk from veto-gate.ts — separate concern.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

const log = createLogger('cognition:epistemic-gate');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpistemicTag = 'CERTAIN' | 'PROBABLE' | 'CONJECTURE' | 'UNKNOWN';

export type ImpactLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type GateDecision = 'PROCEED' | 'REPLAN' | 'UNCERTAIN_RESPONSE';

export interface GateInput {
  tag:    EpistemicTag;
  impact: ImpactLevel;
}

export interface GateResult {
  decision: GateDecision;
  reason:   string;
}

export interface ConjectureCommitError {
  type:       'ConjectureCommitError';
  tag:        EpistemicTag;
  impact:     ImpactLevel;
  rationale:  string; // first 200 chars of the offending rationale text
  sessionId?: string;
}

export interface UncertaintyResponse {
  type:    'UncertaintyResponse';
  tag:     EpistemicTag;
  message: string; // structured message for injection into session messages
}

// ---------------------------------------------------------------------------
// Regex patterns — first match wins in order: UNKNOWN → CONJECTURE → PROBABLE → CERTAIN
// ---------------------------------------------------------------------------

const UNKNOWN_RE    = /\b(i don't know|i do not know|no information|cannot determine|i have no)\b/i;
const CONJECTURE_RE = /\b(i think|i believe|probably|likely|perhaps|maybe|might|could be|i guess|i assume|i suspect)\b/i;
const PROBABLE_RE   = /\b(it appears|it seems|evidence suggests|based on|typically|usually|generally)\b/i;

// ---------------------------------------------------------------------------
// Impact derivation patterns
// ---------------------------------------------------------------------------

// Keyword lists are matched against tokenized tool-name segments rather than
// raw substrings. Tool names are split on non-alphanumeric separators (_, -, .)
// AND camelCase humps, so e.g. `deleteFile` → [delete, file], `rm_files` →
// [rm, files]. A token matches a keyword when it *starts with* that keyword
// (preserves suffix forms like writer/emails). This prevents short tokens from
// matching interior substrings of unrelated names — e.g. `rm` no longer matches
// transform/perform/confirm, and `put` no longer matches compute/output/reputation.
const CRITICAL_TOOL_KEYWORDS = ['delete', 'drop', 'rm', 'wipe', 'format', 'shutdown', 'exec', 'eval', 'shell'];
const HIGH_TOOL_KEYWORDS     = ['write', 'create', 'update', 'insert', 'post', 'put', 'patch'];
const MEDIUM_TOOL_KEYWORDS   = ['send', 'email', 'message', 'notify', 'alert', 'read', 'fetch', 'query'];

/** Split a tool name into lowercase segments on separators and camelCase humps. */
function tokenizeToolName(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase humps
    .split(/[^a-zA-Z0-9]+/)                  // split on separators
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.toLowerCase());
}

/** True if any token in the tool name starts with one of the given keywords. */
function matchesToolKeyword(tokens: string[], keywords: string[]): boolean {
  return tokens.some((token) => keywords.some((kw) => token.startsWith(kw)));
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Classify the epistemic confidence level of a rationale text.
 * First-match wins: UNKNOWN → CONJECTURE → PROBABLE → CERTAIN.
 * Empty text → PROBABLE (model silence ≠ explicit uncertainty; see inline comment below).
 */
export function classifyRationale(text: string): EpistemicTag {
  // Empty rationale → PROBABLE (not UNKNOWN): model silence is not explicit uncertainty.
  // Returning UNKNOWN for empty text caused infinite REPLAN loops on CRITICAL-impact
  // tools (system.exec, code.*-exec) because UNKNOWN+CRITICAL → REPLAN in gate matrix.
  if (!text || text.trim() === '') return 'PROBABLE';
  if (UNKNOWN_RE.test(text))    return 'UNKNOWN';
  if (CONJECTURE_RE.test(text)) return 'CONJECTURE';
  if (PROBABLE_RE.test(text))   return 'PROBABLE';
  return 'CERTAIN';
}

/**
 * Derive the impact level from a tool name.
 * Separate heuristic from veto-gate's classifyRisk — do NOT import or reuse it.
 */
export function classifyImpact(toolName: string): ImpactLevel {
  const tokens = tokenizeToolName(toolName);
  if (matchesToolKeyword(tokens, CRITICAL_TOOL_KEYWORDS)) return 'CRITICAL';
  if (matchesToolKeyword(tokens, HIGH_TOOL_KEYWORDS))     return 'HIGH';
  if (matchesToolKeyword(tokens, MEDIUM_TOOL_KEYWORDS))   return 'MEDIUM';
  return 'MEDIUM';
}

/**
 * Gate matrix: (tag × impact) → GateDecision.
 *
 * CONJECTURE + MEDIUM|HIGH|CRITICAL → REPLAN
 * UNKNOWN    + HIGH|CRITICAL        → REPLAN
 * UNKNOWN    + LOW|MEDIUM           → UNCERTAIN_RESPONSE
 * everything else                  → PROCEED
 */
export function gateToolCall(input: GateInput): GateResult {
  const { tag, impact } = input;

  if (tag === 'CONJECTURE' && (impact === 'MEDIUM' || impact === 'HIGH' || impact === 'CRITICAL')) {
    return {
      decision: 'REPLAN',
      reason:   `Conjecture-tagged rationale with ${impact} impact — requires replanning before commit.`,
    };
  }

  if (tag === 'UNKNOWN' && (impact === 'HIGH' || impact === 'CRITICAL')) {
    return {
      decision: 'REPLAN',
      reason:   `Unknown-confidence rationale with ${impact} impact — must replan before proceeding.`,
    };
  }

  if (tag === 'UNKNOWN' && (impact === 'LOW' || impact === 'MEDIUM')) {
    return {
      decision: 'UNCERTAIN_RESPONSE',
      reason:   `Unknown-confidence rationale with ${impact} impact — injecting uncertainty signal.`,
    };
  }

  return {
    decision: 'PROCEED',
    reason:   `tag=${tag}, impact=${impact} — within acceptable confidence threshold.`,
  };
}

/**
 * Build a ConjectureCommitError value object for REPLAN decisions
 * triggered by CONJECTURE tag.
 */
export function buildConjectureCommitError(
  tag:       EpistemicTag,
  impact:    ImpactLevel,
  rationale: string,
  sessionId?: string,
): ConjectureCommitError {
  return {
    type:      'ConjectureCommitError',
    tag,
    impact,
    rationale: rationale.slice(0, 200),
    sessionId,
  };
}

/**
 * Build an UncertaintyResponse for UNCERTAIN_RESPONSE decisions.
 * Message format matches spec.
 */
export function buildUncertaintyResponse(
  tag:      EpistemicTag,
  toolName: string,
): UncertaintyResponse {
  return {
    type:    'UncertaintyResponse',
    tag,
    message: `[EpistemicGate] Low-confidence response (tag=${tag}) for tool ${toolName} — treating as uncertain. Please verify before acting.`,
  };
}

// ---------------------------------------------------------------------------
// EpistemicGate class — optional SQLite logging, never throws
// ---------------------------------------------------------------------------

export interface EpistemicLogRow {
  id:               string;
  session_id:       string | null;
  tag:              string;
  impact:           string;
  decision:         string;
  rationale_preview: string;
  ts:               string;
}

export class EpistemicGate {
  private readonly db?: Database.Database;
  private _dbReady = false;
  private _stmtInsert?: Statement;
  private _stmtList?: Statement;
  private _stmtListByTag?: Statement;
  private _stmtStats?: Statement;

  constructor(db?: Database.Database) {
    this.db = db;
    if (this.db) {
      this._initDb();
    }
  }

  /**
   * Evaluate the epistemic confidence of a rationale for a given tool.
   * Never throws — fail-open returns PROCEED on any internal error.
   */
  evaluate(
    rationale: string,
    toolName:  string,
    sessionId?: string,
  ): {
    tag:       EpistemicTag;
    impact:    ImpactLevel;
    result:    GateResult;
    error?:    ConjectureCommitError;
    response?: UncertaintyResponse;
  } {
    try {
      const tag    = classifyRationale(rationale);
      const impact = classifyImpact(toolName);
      const result = gateToolCall({ tag, impact });

      let error:    ConjectureCommitError | undefined;
      let response: UncertaintyResponse  | undefined;

      if (result.decision === 'REPLAN' && tag === 'CONJECTURE') {
        error = buildConjectureCommitError(tag, impact, rationale, sessionId);
      } else if (result.decision === 'UNCERTAIN_RESPONSE') {
        response = buildUncertaintyResponse(tag, toolName);
      }

      this._logDecision(tag, impact, result.decision, rationale, sessionId);

      return { tag, impact, result, error, response };
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'EpistemicGate.evaluate: internal error — failing open');
      return {
        tag:    'CERTAIN',
        impact: 'LOW',
        result: { decision: 'PROCEED', reason: 'fail-open' },
      };
    }
  }

  /**
   * Return recent epistemic log decisions, newest first.
   * Fail-open: returns [] if DB not ready or query throws.
   */
  listDecisions(opts: { limit: number; tag?: EpistemicTag }): EpistemicLogRow[] {
    if (!this._dbReady || !this._stmtList || !this._stmtListByTag) {
      log.warn('EpistemicGate.listDecisions: DB not ready — returning []');
      return [];
    }
    try {
      const limit = Math.max(1, Math.min(opts.limit, 500));
      if (opts.tag !== undefined) {
        return this._stmtListByTag.all(opts.tag, limit) as EpistemicLogRow[];
      }
      return this._stmtList.all(limit) as EpistemicLogRow[];
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'EpistemicGate.listDecisions: query failed — returning []');
      return [];
    }
  }

  /**
   * Return aggregate statistics for epistemic decisions since a given timestamp.
   * Fail-open: on any error, returns zeroed stats with a warn log.
   */
  getStats(opts: { sinceMs?: number }): {
    total: number;
    byTag: Record<EpistemicTag, number>;
    byDecision: Record<'PASS' | 'BLOCK' | 'UNCERTAIN', number>;
    blockRate: number;
    window: { sinceMs: number; untilMs: number };
  } {
    const defaultSince = Date.now() - 24 * 60 * 60 * 1000;
    const sinceMs = (opts.sinceMs !== undefined && Number.isFinite(opts.sinceMs)) ? opts.sinceMs : defaultSince;
    const untilMs = Date.now();

    const zeroResult = {
      total: 0,
      byTag: { CERTAIN: 0, PROBABLE: 0, CONJECTURE: 0, UNKNOWN: 0 } as Record<EpistemicTag, number>,
      byDecision: { PASS: 0, BLOCK: 0, UNCERTAIN: 0 } as Record<'PASS' | 'BLOCK' | 'UNCERTAIN', number>,
      blockRate: 0,
      window: { sinceMs, untilMs },
    };

    if (!this._dbReady || !this._stmtStats) {
      log.warn('EpistemicGate.getStats: DB not ready — returning zeros (fail-open)');
      return zeroResult;
    }

    try {
      const sinceIso = new Date(sinceMs).toISOString();
      const rows = this._stmtStats.all(sinceIso) as Array<{ tag: string; decision: string; cnt: number }>;

      const byTag: Record<EpistemicTag, number> = { CERTAIN: 0, PROBABLE: 0, CONJECTURE: 0, UNKNOWN: 0 };
      const byDecision: Record<'PASS' | 'BLOCK' | 'UNCERTAIN', number> = { PASS: 0, BLOCK: 0, UNCERTAIN: 0 };

      // Map GateDecision → display key
      const decisionMap: Record<string, 'PASS' | 'BLOCK' | 'UNCERTAIN'> = {
        PROCEED: 'PASS',
        REPLAN: 'BLOCK',
        UNCERTAIN_RESPONSE: 'UNCERTAIN',
      };

      let total = 0;
      for (const row of rows) {
        const cnt = Number(row.cnt);
        total += cnt;
        if (row.tag in byTag) {
          byTag[row.tag as EpistemicTag] += cnt;
        }
        const mappedDecision = decisionMap[row.decision];
        if (mappedDecision !== undefined) {
          byDecision[mappedDecision] += cnt;
        }
      }

      const blockRate = total > 0 ? byDecision.BLOCK / total : 0;

      return { total, byTag, byDecision, blockRate, window: { sinceMs, untilMs } };
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'EpistemicGate.getStats: query failed — returning zeros (fail-open)');
      return { ...zeroResult, window: { sinceMs, untilMs } };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _initDb(): void {
    try {
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS epistemic_log (
          id               TEXT PRIMARY KEY,
          session_id       TEXT,
          tag              TEXT NOT NULL,
          impact           TEXT NOT NULL,
          decision         TEXT NOT NULL,
          rationale_preview TEXT NOT NULL,
          ts               TEXT NOT NULL
        )
      `);
      this._stmtInsert = this.db!.prepare(
        `INSERT INTO epistemic_log (id, session_id, tag, impact, decision, rationale_preview, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      this._stmtList = this.db!.prepare(
        `SELECT * FROM epistemic_log ORDER BY ts DESC LIMIT ?`,
      );
      this._stmtListByTag = this.db!.prepare(
        `SELECT * FROM epistemic_log WHERE tag = ? ORDER BY ts DESC LIMIT ?`,
      );
      this._stmtStats = this.db!.prepare(
        `SELECT tag, decision, COUNT(*) as cnt FROM epistemic_log WHERE ts >= ? GROUP BY tag, decision`,
      );
      this._dbReady = true;
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'EpistemicGate: DB init failed — logging disabled');
    }
  }

  private _logDecision(
    tag:       EpistemicTag,
    impact:    ImpactLevel,
    decision:  GateDecision,
    rationale: string,
    sessionId?: string,
  ): void {
    if (!this._dbReady || !this.db || !this._stmtInsert) return;
    try {
      const row: EpistemicLogRow = {
        id:               randomUUID(),
        session_id:       sessionId ?? null,
        tag,
        impact,
        decision,
        rationale_preview: rationale.slice(0, 200),
        ts:               new Date().toISOString(),
      };
      this._stmtInsert.run(row.id, row.session_id, row.tag, row.impact, row.decision, row.rationale_preview, row.ts);
    } catch (err: unknown) {
      // Silent fail — epistemic log is optional, never throw
      log.warn({ err: String(err) }, 'EpistemicGate: DB log insert failed — silent skip');
    }
  }
}
