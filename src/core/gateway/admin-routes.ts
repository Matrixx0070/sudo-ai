/**
 * gateway/admin-routes.ts — Admin REST route handlers.
 *
 * Routes:
 *   GET  /v1/admin/audit/verify               — verify audit chain integrity
 *   GET  /v1/admin/inspection                  — query inspection queue
 *   POST /v1/admin/inspection/:id/status       — update inspection entry status
 *
 * Auth: timing-safe Bearer token check, same logic as http-api.ts.
 * Errors: never leak internal details; return generic 500 message.
 */

import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { artifactSigner } from '../security/signer.js';
import type { ChainVerifyResult } from '../security/audit-trail.js';
import type { QueryFilter, InspectionQueueEntry, InspectionStatus } from '../security/inspection-queue.js';
import type { VetoOverride } from '../agent/veto-override-store.js';
import type { AggregatorResult, AlignmentSignals } from '../agent/alignment-aggregator.js';
import type { EpistemicLogRow, EpistemicTag } from '../cognition/epistemic-gate.js';
import type { CommitmentRow } from '../cognition/commitment-auditor.js';
import { BASE_VETO_THRESHOLD } from '../agent/veto-gate.js';
import {
  type DigestSnapshot,
  digestToPrometheusText,
  toOTLPMetrics,
} from '../telemetry/otel-exporter.js';
import { renderDashboardHtml } from './dashboard-html.js';
import type { SkillOptimizationProposal, SkillOptimizationStatus } from '../shared/wave10-types.js';

const log = createLogger('gateway:admin-routes');

const MAX_BODY = 256 * 1024; // 256 KB body cap
const VALID_STATUSES: InspectionStatus[] = ['pending', 'reviewed', 'cleared', 'blocked'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Alignment report shape returned from getLastReport(). */
type AlignmentReport = AggregatorResult & {
  evaluatedAt: string;
  signals: AlignmentSignals;
  contributingSignals: string[];
};

export interface AdminRoutesDeps {
  auditTrail: {
    verifyChain(): ChainVerifyResult;
    recordTriple?(entry: { mistake: string; learned: string; commitment: string; ttl_days: number }): void;
  };
  inspectionQueue: {
    query(filter?: QueryFilter): InspectionQueueEntry[];
    updateStatus(id: string, status: InspectionStatus, reviewedBy?: string): void;
  };
  vetoOverrideStore?: {
    recordOverride(o: Omit<VetoOverride, 'id' | 'createdAt'> & { contentHash?: string | null }): VetoOverride;
    listOverrides(limit?: number): VetoOverride[];
  };
  /** Optional — if absent, GET /v1/admin/alignment returns {ok:true, data:null}. */
  alignmentAggregator?: {
    getLastReport(): AlignmentReport | null;
  };
  /** Optional — if absent, GET /v1/admin/epistemic/log returns 503. */
  epistemicGate?: {
    listDecisions(opts: { limit: number; tag?: EpistemicTag }): EpistemicLogRow[];
    getStats?(opts: { sinceMs?: number }): {
      total: number;
      byTag: Record<EpistemicTag, number>;
      byDecision: Record<'PASS' | 'BLOCK' | 'UNCERTAIN', number>;
      blockRate: number;
      window: { sinceMs: number; untilMs: number };
    };
  };
  /** Optional — if absent, GET /v1/admin/commitments/expiring returns 503. */
  commitmentAuditor?: {
    getExpiringCommitments(windowDays: number): CommitmentRow[];
    getExpiredCommitments(): CommitmentRow[];
  };
  /** Optional — if absent, GET /v1/admin/trust returns 503. */
  trustTierTracker?: {
    getAuditSnapshot(): {
      tier: string;
      score: number;
      windowSizeDays: number;
      lastAdjustedAt: string;
    };
    recordOutcome?(outcome: { timestamp: number; kind: string; weight?: number }): void;
    getOutcomeBreakdown?(opts?: { windowDays?: number }): { kind: string; count: number; score: number }[];
  };
  /** Optional — if absent, POST /v1/admin/commitments/resolve returns 503. */
  commitmentResolutionTracker?: {
    resolve(
      commitmentRef: string,
      resolution: 'honored' | 'abandoned' | 'expired-acknowledged',
      notes?: string,
    ): { id: string; commitmentRef: string; resolution: string; ts: number; notes?: string } | null;
    isResolved(commitmentRef: string): boolean;
    /** Optional — exposed for GET /v1/admin/digest. */
    getStats?(opts?: { windowDays?: number }): {
      total: number;
      honored: number;
      abandoned: number;
      expiredAcknowledged: number;
      honorRate: number;
      windowDays: number;
      computedAt: string;
    };
  };
  /** Optional — if absent, GET /v1/admin/patterns returns 503. */
  mistakePatternRecognizer?: {
    analyze(opts?: { windowDays?: number; minOccurrences?: number }): {
      totalMistakes: number;
      uniquePatterns: number;
      recurringPatterns: Array<{
        signatureHash: string;
        signature: string;
        occurrences: number;
        firstSeenAt: string;
        lastSeenAt: string;
        tags: string[];
      }>;
      windowDays: number;
      analyzedAt: string;
    };
  };
  /** Optional — if absent, GET /v1/admin/calibration returns 503. */
  confidenceCalibrationTracker?: {
    getReport(opts?: { windowDays?: number; tag?: string }): {
      totalSamples: number;
      brierScore: number;
      overallAvgPredicted: number;
      overallSuccessRate: number;
      buckets: Array<{
        bucket: string;
        rangeLow: number;
        rangeHigh: number;
        count: number;
        avgPredicted: number;
        actualSuccessRate: number;
        calibrationError: number;
      }>;
      windowDays: number;
      computedAt: string;
    };
  };
  /** Optional — if absent, GET /v1/admin/diagnostics returns 503. */
  crossSignalDiagnostics?: {
    analyze(opts?: {
      windowDays?: number;
      spikeBucketMinutes?: number;
      correlationWindowMinutes?: number;
    }): {
      windowDays: number;
      trustSpikes: Array<{ source: string; kind: string; ts: number; count: number }>;
      epistemicBlockSpikes: Array<{ source: string; kind: string; ts: number; count: number }>;
      vetoSpikes: Array<{ source: string; kind: string; ts: number; count: number }>;
      commitmentExpirySpikes: Array<{ source: string; kind: string; ts: number; count: number }>;
      correlations: Array<{
        leadingSpike: { source: string; kind: string; ts: number; count: number };
        trailingSpike: { source: string; kind: string; ts: number; count: number };
        deltaMs: number;
        confidence: number;
      }>;
      analyzedAt: string;
      totalEventsScanned: number;
    };
  };
  /** Optional — if absent, GET /v1/admin/reanchor/stats and /reanchor/recent return 503. */
  reanchorMonitor?: {
    getStats(opts?: { windowDays?: number }): {
      total: number;
      byTrigger: Record<string, number>;
      windowDays: number;
      computedAt: string;
      lastReAnchorAt?: number;
    };
    getRecent(opts?: { windowDays?: number; limit?: number }): Array<{
      id: string;
      ts: number;
      trigger: string;
      snippet: string;
    }>;
  };
  /** Optional — if absent, GET /v1/admin/veto/threshold returns 503. */
  autoThresholdTuner?: {
    computeVetoThreshold(baseThreshold: number): number;
    getLastComputation(): {
      baseThreshold: number;
      effectiveThreshold: number;
      brierScore: number;
      totalSamples: number;
      adjustment: number;
      computedAt: string;
    } | null;
  };
  /** Optional — if absent, GET /v1/admin/remediation/stats returns 503. */
  alignmentAutoRemediator?: {
    getStats(): {
      observationCount: number;
      remediationsTriggered: number;
      lastRemediationAt?: number;
      lastStatus: string;
      inCooldown: boolean;
    };
  };
  /** Optional — if absent, skill optimization endpoints return 503. */
  skillOptimizationStore?: {
    list(filter: {
      status?: SkillOptimizationStatus;
      limit: number;
      offset: number;
    }): { data: SkillOptimizationProposal[]; total: number };
    approve(id: string): SkillOptimizationProposal;
    reject(id: string, reason?: string): SkillOptimizationProposal;
    getById(id: string): SkillOptimizationProposal | null;
  };
}

// ---------------------------------------------------------------------------
// Internal auth helper (timing-safe, mirrors http-api.ts logic)
// ---------------------------------------------------------------------------

function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

function isAuthorised(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (tokenBuf === null) return true;
  const candidate = Buffer.from(extractBearer(req), 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleAuditVerify(res: ServerResponse, deps: AdminRoutesDeps): void {
  try {
    const result = deps.auditTrail.verifyChain();
    const validCount = result.breakAt != null ? 0 : result.rowsChecked;
    const invalidCount = result.breakAt != null ? result.rowsChecked : 0;
    sendJson(res, 200, { ok: true, data: { ...result, validCount, invalidCount } });
    log.info({ ok: result.ok, validCount, invalidCount }, 'Admin: audit chain verified');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: verifyChain failed');
    sendError(res, 500, 'Internal server error');
  }
}

function handleInspectionQuery(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const statusParam = urlObj.searchParams.get('status');
    const limitParam = urlObj.searchParams.get('limit');

    const filter: QueryFilter = {};

    if (statusParam && (VALID_STATUSES as string[]).includes(statusParam)) {
      filter.status = statusParam as InspectionStatus;
    }

    const parsedLimit = parseInt(limitParam ?? '', 10);
    filter.limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(1, parsedLimit), MAX_LIMIT) : DEFAULT_LIMIT;

    const entries = deps.inspectionQueue.query(filter);
    sendJson(res, 200, { ok: true, data: { entries, count: entries.length } });
    log.info({ count: entries.length, filter }, 'Admin: inspection queue queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: inspection query failed');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleInspectionStatusUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRoutesDeps,
  id: string,
): Promise<void> {
  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Admin: failed to read POST body');
    sendError(res, 400, 'Invalid request body');
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Invalid request body');
    return;
  }

  const { status, reviewedBy } = parsed;

  if (typeof status !== 'string' || !(VALID_STATUSES as string[]).includes(status)) {
    sendError(res, 400, `status must be one of: ${VALID_STATUSES.join(', ')}`);
    return;
  }

  const reviewedByStr = typeof reviewedBy === 'string' ? reviewedBy : undefined;

  try {
    deps.inspectionQueue.updateStatus(id, status as InspectionStatus, reviewedByStr);
    sendJson(res, 200, { ok: true, data: { id, status } });
    log.info({ id, status }, 'Admin: inspection status updated');
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err), id }, 'Admin: updateStatus failed');
    sendError(res, 404, 'Entry not found or update failed');
  }
}

// ---------------------------------------------------------------------------
// Veto override route handlers (Primitive B)
// ---------------------------------------------------------------------------

/** Strip ASCII control characters, role-marker prefixes, and prompt-injection patterns from reason strings.
 *  Truncates to 1000 chars with a warn log rather than rejecting overlong input.
 */
function sanitizeReason(raw: string): string {
  // Truncate before sanitising so injection patterns near the boundary cannot escape
  let s = raw.length > 1000 ? (log.warn({ originalLength: raw.length }, 'sanitizeReason: reason truncated to 1000 chars'), raw.slice(0, 1000)) : raw;

  // Strip control characters (0x00-0x1F, 0x7F)
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');

  // Strip role-marker prefixes (e.g. "SYSTEM:", "ASSISTANT:", "USER:") — leading only
  s = s.replace(/^(system|assistant|user)\s*:/gi, '');

  // Strip prompt-injection token patterns (case-insensitive, global)
  s = s.replace(/\[SYSTEM\]/gi, '');
  s = s.replace(/<\/s>/gi, '');
  s = s.replace(/<s>/gi, '');
  s = s.replace(/<\|im_start\|>/gi, '');
  s = s.replace(/<\|im_end\|>/gi, '');
  s = s.replace(/\[INST\]/gi, '');
  s = s.replace(/\[\/INST\]/gi, '');
  // Strip XML-ish tags (tag name 1-40 chars, with optional attributes / slash)
  s = s.replace(/<[^>]{1,40}>/g, '');

  return s.trim();
}

/** Validate decisionId — no path traversal, non-empty, max 128 chars. */
function validateDecisionId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: 'decisionId is required' };
  }
  const id = raw.trim();
  if (id.length > 128) {
    return { ok: false, error: 'decisionId must be ≤128 characters' };
  }
  if (id.includes('/') || id.includes('..')) {
    return { ok: false, error: 'decisionId contains disallowed characters (path traversal detected)' };
  }
  return { ok: true, value: id };
}

/** Validate contentHash — must be exactly 32 lowercase hex characters. */
function validateContentHash(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'contentHash must be a string' };
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-f]{32}$/i.test(trimmed)) {
    return { ok: false, error: 'contentHash must be exactly 32 hexadecimal characters' };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}

async function handleVetoOverridePost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRoutesDeps,
): Promise<void> {
  if (!deps.vetoOverrideStore) {
    sendError(res, 503, 'Override store not configured');
    return;
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Admin veto: failed to read POST body');
    sendError(res, 400, 'Invalid request body');
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const hasDecisionId = parsed['decisionId'] !== undefined;
  const hasContentHash = parsed['contentHash'] !== undefined;

  // At least one of decisionId or contentHash is required (v2 body contract).
  if (!hasDecisionId && !hasContentHash) {
    sendError(res, 400, 'decisionId or contentHash required');
    return;
  }

  // Validate decisionId when provided.
  let decisionId: string;
  if (hasDecisionId) {
    const decisionIdResult = validateDecisionId(parsed['decisionId']);
    if (!decisionIdResult.ok) {
      if (typeof parsed['decisionId'] === 'string' &&
          (parsed['decisionId'].includes('/') || parsed['decisionId'].includes('..'))) {
        log.warn({ decisionId: String(parsed['decisionId']) }, 'Admin veto: path traversal attempt detected');
      }
      sendError(res, 400, decisionIdResult.error);
      return;
    }
    decisionId = decisionIdResult.value;
  } else {
    // contentHash-only: generate a stable UUID as decisionId to satisfy UNIQUE constraint.
    decisionId = randomUUID();
  }

  // Validate contentHash when provided.
  let contentHash: string | null = null;
  if (hasContentHash) {
    const contentHashResult = validateContentHash(parsed['contentHash']);
    if (!contentHashResult.ok) {
      sendError(res, 400, contentHashResult.error);
      return;
    }
    contentHash = contentHashResult.value;
  }

  // Validate action
  const action = parsed['action'];
  if (action !== 'allow' && action !== 'deny') {
    sendError(res, 400, "action must be 'allow' or 'deny'");
    return;
  }

  // Validate reason
  const rawReason = parsed['reason'];
  if (typeof rawReason !== 'string' || rawReason.trim().length === 0) {
    sendError(res, 400, 'reason is required');
    return;
  }
  const reason = sanitizeReason(rawReason);
  if (action === 'deny' && reason.length < 20) {
    if (rawReason.length >= 20 && reason.length < rawReason.length) {
      sendError(res, 400, 'reason must be >=20 characters after sanitization (control chars, role markers, and tag-like sequences are stripped)');
      return;
    }
    sendError(res, 400, "reason must be >=20 characters when action is 'deny'");
    return;
  }

  // Record the override (v2: includes contentHash field).
  let override: VetoOverride;
  try {
    override = deps.vetoOverrideStore.recordOverride({
      decisionId,
      contentHash,
      action,
      reason,
      createdBy: 'admin',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('constraint')) {
      sendError(res, 409, 'Override already exists for this decisionId');
      return;
    }
    log.error({ err: msg, decisionId }, 'Admin veto: recordOverride failed');
    sendError(res, 500, 'Internal server error');
    return;
  }

  // Audit trail — non-fatal
  try {
    deps.auditTrail.recordTriple?.({
      mistake: 'veto manual override',
      learned: reason,
      commitment: 'override logged',
      ttl_days: 7,
    });
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Admin veto: auditTrail.recordTriple failed (non-fatal)');
  }

  log.info({ decisionId, contentHash: contentHash ? '[set]' : null, action }, 'Admin: veto override recorded');
  sendJson(res, 201, { ok: true, data: override });
}

function handleVetoOverrideList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRoutesDeps,
): void {
  if (!deps.vetoOverrideStore) {
    sendError(res, 503, 'Override store not configured');
    return;
  }

  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const limitParam = urlObj.searchParams.get('limit');
    const parsedLimit = parseInt(limitParam ?? '', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(1, parsedLimit), 500) : 100;

    const overrides = deps.vetoOverrideStore.listOverrides(limit);
    sendJson(res, 200, { ok: true, data: { overrides, count: overrides.length } });
    log.info({ count: overrides.length, limit }, 'Admin: veto overrides listed');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: veto list failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Epistemic log route handler
// ---------------------------------------------------------------------------

const VALID_EPISTEMIC_TAGS: EpistemicTag[] = ['CERTAIN', 'PROBABLE', 'CONJECTURE', 'UNKNOWN'];

function handleEpistemicLogGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.epistemicGate) {
    sendError(res, 503, 'Epistemic gate not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const limitParam = urlObj.searchParams.get('limit');
    const tagParam   = urlObj.searchParams.get('tag');

    const parsedLimit = parseInt(limitParam ?? '', 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(1, parsedLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

    let tag: EpistemicTag | undefined;
    if (tagParam !== null) {
      if (!(VALID_EPISTEMIC_TAGS as string[]).includes(tagParam)) {
        sendError(res, 400, 'Invalid tag');
        return;
      }
      tag = tagParam as EpistemicTag;
    }

    const entries = deps.epistemicGate.listDecisions({ limit, tag });
    sendJson(res, 200, { ok: true, data: { entries, count: entries.length } });
    log.info({ count: entries.length, limit, tag }, 'Admin: epistemic log queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: epistemic log get failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Commitments expiring route handler
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 3;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const MAX_TEXT_REDACT = 200;

function redactCommitmentRow(row: CommitmentRow): CommitmentRow {
  return {
    ...row,
    commitment: row.commitment.slice(0, MAX_TEXT_REDACT),
    learned: row.learned.slice(0, MAX_TEXT_REDACT),
  };
}

function handleCommitmentsExpiringGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.commitmentAuditor) {
    sendError(res, 503, 'Commitment auditor not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const windowParam = urlObj.searchParams.get('window');

    let windowDays: number;
    if (windowParam === null || windowParam === '') {
      windowDays = DEFAULT_WINDOW_DAYS;
    } else {
      const parsed = parseInt(windowParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        windowDays = DEFAULT_WINDOW_DAYS;
      } else if (parsed < MIN_WINDOW_DAYS || parsed > MAX_WINDOW_DAYS) {
        sendError(res, 400, `window must be between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS}`);
        return;
      } else {
        windowDays = parsed;
      }
    }

    const expiring = deps.commitmentAuditor.getExpiringCommitments(windowDays).map(redactCommitmentRow);
    const expired = deps.commitmentAuditor.getExpiredCommitments().map(redactCommitmentRow);
    const checkedAt = new Date().toISOString();

    sendJson(res, 200, { ok: true, data: { expiring, expired, window: windowDays, checkedAt } });
    log.info({ expiringCount: expiring.length, expiredCount: expired.length, windowDays }, 'Admin: commitments expiring queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: commitments expiring get failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Epistemic stats route handler
// ---------------------------------------------------------------------------

function handleEpistemicStatsGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.epistemicGate || !deps.epistemicGate.getStats) {
    sendError(res, 503, 'Epistemic gate not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const sinceParam = urlObj.searchParams.get('since');

    let sinceMs: number | undefined;
    if (sinceParam !== null && sinceParam !== '') {
      const parsed = parseInt(sinceParam, 10);
      sinceMs = Number.isFinite(parsed) ? parsed : undefined;
    }

    const stats = deps.epistemicGate.getStats({ sinceMs });
    sendJson(res, 200, { ok: true, data: stats });
    log.info({ total: stats.total, blockRate: stats.blockRate }, 'Admin: epistemic stats queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: epistemic stats get failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Trust tier route handler
// ---------------------------------------------------------------------------

const TRUST_WINDOW_DAYS = 7;

function handleTrustGet(res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.trustTierTracker) {
    sendError(res, 503, 'trust tier tracker not configured');
    return;
  }
  try {
    const snapshot = deps.trustTierTracker.getAuditSnapshot();
    sendJson(res, 200, {
      ok: true,
      data: {
        tier: snapshot.tier,
        score: snapshot.score,
        windowDays: TRUST_WINDOW_DAYS,
        computedAt: new Date().toISOString(),
      },
    });
    log.info({ tier: snapshot.tier, score: snapshot.score }, 'Admin: trust tier queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: trust get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Alignment state route handler
// ---------------------------------------------------------------------------

function handleAlignmentGet(res: ServerResponse, deps: AdminRoutesDeps): void {
  try {
    const report = deps.alignmentAggregator?.getLastReport() ?? null;
    if (report === null) {
      // No evaluate() has run yet (fresh start or no active sessions).
      // Return a well-formed placeholder so callers/dashboards show a meaningful state
      // rather than rendering bare null as "--".
      sendJson(res, 200, {
        ok: true,
        data: {
          score: null,
          level: 'warming-up',
          status: 'warming-up',
          contributingSignals: [],
          evaluatedAt: null,
          failedOpen: false,
          diagnosis: 'No alignment evaluation has run yet. Score will populate after the first active session.',
        },
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      data: {
        level:              report.level,
        score:              report.score,
        contributingSignals: report.contributingSignals,
        evaluatedAt:        report.evaluatedAt,
        failedOpen:         report.failedOpen,
        diagnosis:          report.diagnosis,
      },
    });
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: alignment get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Patterns route handler
// ---------------------------------------------------------------------------

const PATTERNS_DEFAULT_WINDOW = 30;
const PATTERNS_MIN_WINDOW = 1;
const PATTERNS_MAX_WINDOW = 365;
const PATTERNS_DEFAULT_MIN_OCCURRENCES = 2;
const PATTERNS_MIN_OCCURRENCES_MIN = 1;
const PATTERNS_MIN_OCCURRENCES_MAX = 100;
const PATTERNS_DEFAULT_LIMIT = 50;
const PATTERNS_MIN_LIMIT = 1;
const PATTERNS_MAX_LIMIT = 200;
const PATTERN_SIG_MAX_LEN = 200;

function handlePatternsGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.mistakePatternRecognizer) {
    sendError(res, 503, 'mistake pattern recognizer not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');

    const windowParam = urlObj.searchParams.get('window');
    const minOccParam = urlObj.searchParams.get('minOccurrences');
    const limitParam  = urlObj.searchParams.get('limit');

    // Validate window
    let windowDays: number;
    if (windowParam === null || windowParam === '') {
      windowDays = PATTERNS_DEFAULT_WINDOW;
    } else {
      const parsed = parseInt(windowParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        windowDays = PATTERNS_DEFAULT_WINDOW;
      } else if (parsed < PATTERNS_MIN_WINDOW || parsed > PATTERNS_MAX_WINDOW) {
        sendError(res, 400, `window must be between ${PATTERNS_MIN_WINDOW} and ${PATTERNS_MAX_WINDOW}`);
        return;
      } else {
        windowDays = parsed;
      }
    }

    // Validate minOccurrences
    let minOccurrences: number;
    if (minOccParam === null || minOccParam === '') {
      minOccurrences = PATTERNS_DEFAULT_MIN_OCCURRENCES;
    } else {
      const parsed = parseInt(minOccParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        minOccurrences = PATTERNS_DEFAULT_MIN_OCCURRENCES;
      } else if (parsed < PATTERNS_MIN_OCCURRENCES_MIN || parsed > PATTERNS_MIN_OCCURRENCES_MAX) {
        sendError(res, 400, `minOccurrences must be between ${PATTERNS_MIN_OCCURRENCES_MIN} and ${PATTERNS_MIN_OCCURRENCES_MAX}`);
        return;
      } else {
        minOccurrences = parsed;
      }
    }

    // Validate limit
    let limit: number;
    if (limitParam === null || limitParam === '') {
      limit = PATTERNS_DEFAULT_LIMIT;
    } else {
      const parsed = parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        limit = PATTERNS_DEFAULT_LIMIT;
      } else if (parsed < PATTERNS_MIN_LIMIT || parsed > PATTERNS_MAX_LIMIT) {
        sendError(res, 400, `limit must be between ${PATTERNS_MIN_LIMIT} and ${PATTERNS_MAX_LIMIT}`);
        return;
      } else {
        limit = parsed;
      }
    }

    const report = deps.mistakePatternRecognizer.analyze({ windowDays, minOccurrences });

    // Truncate signatures and apply limit
    const patterns = report.recurringPatterns.slice(0, limit).map(p => ({
      ...p,
      signature: p.signature.slice(0, PATTERN_SIG_MAX_LEN),
    }));

    sendJson(res, 200, {
      ok: true,
      data: {
        patterns,
        totalMistakes: report.totalMistakes,
        uniquePatterns: report.uniquePatterns,
        window: windowDays,
        analyzedAt: report.analyzedAt,
      },
    });
    log.info(
      { patternCount: patterns.length, totalMistakes: report.totalMistakes, windowDays },
      'Admin: patterns queried',
    );
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: patterns get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Calibration route handler
// ---------------------------------------------------------------------------

const CALIBRATION_DEFAULT_WINDOW = 30;
const CALIBRATION_MIN_WINDOW = 1;
const CALIBRATION_MAX_WINDOW = 365;
const CALIBRATION_MAX_TAG_LEN = 40;

function handleCalibrationGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.confidenceCalibrationTracker) {
    sendError(res, 503, 'confidence calibration tracker not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');

    const windowParam = urlObj.searchParams.get('window');
    const tagParam    = urlObj.searchParams.get('tag');

    // Validate window
    let windowDays: number;
    if (windowParam === null || windowParam === '') {
      windowDays = CALIBRATION_DEFAULT_WINDOW;
    } else {
      const parsed = parseInt(windowParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        windowDays = CALIBRATION_DEFAULT_WINDOW;
      } else if (parsed < CALIBRATION_MIN_WINDOW || parsed > CALIBRATION_MAX_WINDOW) {
        sendError(res, 400, `window must be between ${CALIBRATION_MIN_WINDOW} and ${CALIBRATION_MAX_WINDOW}`);
        return;
      } else {
        windowDays = parsed;
      }
    }

    // Sanitize and validate tag (free-form, max 40 chars, strip control chars)
    let tag: string | undefined;
    if (tagParam !== null && tagParam !== '') {
      const sanitized = tagParam.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, CALIBRATION_MAX_TAG_LEN);
      tag = sanitized.length > 0 ? sanitized : undefined;
    }

    const report = deps.confidenceCalibrationTracker.getReport({ windowDays, tag });

    sendJson(res, 200, { ok: true, data: report });
    log.info(
      { totalSamples: report.totalSamples, brierScore: report.brierScore, windowDays },
      'Admin: calibration report queried',
    );
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: calibration get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Diagnostics route handler
// ---------------------------------------------------------------------------

const DIAG_DEFAULT_WINDOW = 7;
const DIAG_MIN_WINDOW = 1;
const DIAG_MAX_WINDOW = 90;
const DIAG_DEFAULT_BUCKET = 15;
const DIAG_MIN_BUCKET = 1;
const DIAG_MAX_BUCKET = 120;
const DIAG_DEFAULT_CORR_WINDOW = 30;
const DIAG_MIN_CORR_WINDOW = 1;
const DIAG_MAX_CORR_WINDOW = 240;

function handleDiagnosticsGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.crossSignalDiagnostics) {
    sendError(res, 503, 'cross-signal diagnostics not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');

    const windowParam    = urlObj.searchParams.get('window');
    const bucketParam    = urlObj.searchParams.get('bucket');
    const corrWinParam   = urlObj.searchParams.get('corrWindow');

    // Validate window [1,90] default 7
    let windowDays: number;
    if (windowParam === null || windowParam === '') {
      windowDays = DIAG_DEFAULT_WINDOW;
    } else {
      const parsed = parseInt(windowParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        windowDays = DIAG_DEFAULT_WINDOW;
      } else if (parsed < DIAG_MIN_WINDOW || parsed > DIAG_MAX_WINDOW) {
        sendError(res, 400, `window must be between ${DIAG_MIN_WINDOW} and ${DIAG_MAX_WINDOW}`);
        return;
      } else {
        windowDays = parsed;
      }
    }

    // Validate bucket [1,120] default 15
    let spikeBucketMinutes: number;
    if (bucketParam === null || bucketParam === '') {
      spikeBucketMinutes = DIAG_DEFAULT_BUCKET;
    } else {
      const parsed = parseInt(bucketParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        spikeBucketMinutes = DIAG_DEFAULT_BUCKET;
      } else if (parsed < DIAG_MIN_BUCKET || parsed > DIAG_MAX_BUCKET) {
        sendError(res, 400, `bucket must be between ${DIAG_MIN_BUCKET} and ${DIAG_MAX_BUCKET}`);
        return;
      } else {
        spikeBucketMinutes = parsed;
      }
    }

    // Validate corrWindow [1,240] default 30
    let correlationWindowMinutes: number;
    if (corrWinParam === null || corrWinParam === '') {
      correlationWindowMinutes = DIAG_DEFAULT_CORR_WINDOW;
    } else {
      const parsed = parseInt(corrWinParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        correlationWindowMinutes = DIAG_DEFAULT_CORR_WINDOW;
      } else if (parsed < DIAG_MIN_CORR_WINDOW || parsed > DIAG_MAX_CORR_WINDOW) {
        sendError(res, 400, `corrWindow must be between ${DIAG_MIN_CORR_WINDOW} and ${DIAG_MAX_CORR_WINDOW}`);
        return;
      } else {
        correlationWindowMinutes = parsed;
      }
    }

    const report = deps.crossSignalDiagnostics.analyze({ windowDays, spikeBucketMinutes, correlationWindowMinutes });

    // Return full report — top 10 correlations already capped in CrossSignalDiagnostics
    sendJson(res, 200, { ok: true, data: report });
    log.info(
      {
        windowDays,
        totalEventsScanned: report.totalEventsScanned,
        correlations: report.correlations.length,
      },
      'Admin: diagnostics queried',
    );
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: diagnostics get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Injection stats route handler
// ---------------------------------------------------------------------------

const INJECTION_DEFAULT_WINDOW = 7;
const INJECTION_MIN_WINDOW = 1;
const INJECTION_MAX_WINDOW = 90;

function handleInjectionStatsGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.trustTierTracker || !deps.trustTierTracker.getOutcomeBreakdown) {
    sendError(res, 503, 'injection stats not available (trust tier tracker not configured)');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const windowParam = urlObj.searchParams.get('window');

    let windowDays: number;
    if (windowParam === null || windowParam === '') {
      windowDays = INJECTION_DEFAULT_WINDOW;
    } else {
      const parsed = parseInt(windowParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        windowDays = INJECTION_DEFAULT_WINDOW;
      } else if (parsed < INJECTION_MIN_WINDOW || parsed > INJECTION_MAX_WINDOW) {
        sendError(res, 400, `window must be between ${INJECTION_MIN_WINDOW} and ${INJECTION_MAX_WINDOW}`);
        return;
      } else {
        windowDays = parsed;
      }
    }

    const breakdown = deps.trustTierTracker.getOutcomeBreakdown({ windowDays });
    const detectionRow = breakdown.find(r => r.kind === 'injection-detected');
    const totalCount = detectionRow?.count ?? 0;
    const totalScore = detectionRow?.score ?? 0;

    sendJson(res, 200, {
      ok: true,
      data: {
        detections: detectionRow ?? null,
        totalCount,
        totalScore,
        windowDays,
        computedAt: new Date().toISOString(),
      },
    });
    log.info({ totalCount, windowDays }, 'Admin: injection stats queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: injection stats get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Re-anchor stats + recent route handlers
// ---------------------------------------------------------------------------

const REANCHOR_DEFAULT_WINDOW = 30;
const REANCHOR_MIN_WINDOW = 1;
const REANCHOR_MAX_WINDOW = 365;
const REANCHOR_DEFAULT_LIMIT = 50;
const REANCHOR_MIN_LIMIT = 1;
const REANCHOR_MAX_LIMIT = 500;

function handleReanchorStatsGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.reanchorMonitor) {
    sendError(res, 503, 're-anchor monitor not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const windowParam = urlObj.searchParams.get('window');

    let windowDays: number;
    if (windowParam === null || windowParam === '') {
      windowDays = REANCHOR_DEFAULT_WINDOW;
    } else {
      const parsed = parseInt(windowParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        windowDays = REANCHOR_DEFAULT_WINDOW;
      } else if (parsed < REANCHOR_MIN_WINDOW || parsed > REANCHOR_MAX_WINDOW) {
        sendError(res, 400, `window must be between ${REANCHOR_MIN_WINDOW} and ${REANCHOR_MAX_WINDOW}`);
        return;
      } else {
        windowDays = parsed;
      }
    }

    const stats = deps.reanchorMonitor.getStats({ windowDays });
    sendJson(res, 200, { ok: true, data: stats });
    log.info({ total: stats.total, windowDays }, 'Admin: reanchor stats queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: reanchor stats get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

function handleReanchorRecentGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.reanchorMonitor) {
    sendError(res, 503, 're-anchor monitor not configured');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const windowParam = urlObj.searchParams.get('window');
    const limitParam  = urlObj.searchParams.get('limit');

    let windowDays: number;
    if (windowParam === null || windowParam === '') {
      windowDays = REANCHOR_DEFAULT_WINDOW;
    } else {
      const parsed = parseInt(windowParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        windowDays = REANCHOR_DEFAULT_WINDOW;
      } else if (parsed < REANCHOR_MIN_WINDOW || parsed > REANCHOR_MAX_WINDOW) {
        sendError(res, 400, `window must be between ${REANCHOR_MIN_WINDOW} and ${REANCHOR_MAX_WINDOW}`);
        return;
      } else {
        windowDays = parsed;
      }
    }

    let limit: number;
    if (limitParam === null || limitParam === '') {
      limit = REANCHOR_DEFAULT_LIMIT;
    } else {
      const parsed = parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        limit = REANCHOR_DEFAULT_LIMIT;
      } else if (parsed < REANCHOR_MIN_LIMIT || parsed > REANCHOR_MAX_LIMIT) {
        sendError(res, 400, `limit must be between ${REANCHOR_MIN_LIMIT} and ${REANCHOR_MAX_LIMIT}`);
        return;
      } else {
        limit = parsed;
      }
    }

    const events = deps.reanchorMonitor.getRecent({ windowDays, limit });
    sendJson(res, 200, {
      ok: true,
      data: {
        events,
        count: events.length,
        windowDays,
        computedAt: new Date().toISOString(),
      },
    });
    log.info({ count: events.length, windowDays, limit }, 'Admin: reanchor recent queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: reanchor recent get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Commitment resolution route handler
// ---------------------------------------------------------------------------

const VALID_COMMITMENT_RESOLUTIONS = new Set(['honored', 'abandoned', 'expired-acknowledged']);

async function handleCommitmentsResolvePost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRoutesDeps,
): Promise<void> {
  if (!deps.commitmentResolutionTracker) {
    sendError(res, 503, 'commitment resolution tracker not configured');
    return;
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Admin commitments/resolve: failed to read body');
    sendError(res, 400, 'Invalid request body');
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  // Validate commitmentRef
  const rawRef = parsed['commitmentRef'];
  if (typeof rawRef !== 'string' || rawRef.trim().length === 0) {
    sendError(res, 400, 'commitmentRef is required and must be a non-empty string');
    return;
  }
  const commitmentRef = rawRef.trim();
  if (commitmentRef.length > 200) {
    sendError(res, 400, 'commitmentRef must be ≤200 characters');
    return;
  }

  // Validate resolution enum
  const rawResolution = parsed['resolution'];
  if (typeof rawResolution !== 'string' || !VALID_COMMITMENT_RESOLUTIONS.has(rawResolution)) {
    sendError(res, 400, `resolution must be one of: ${[...VALID_COMMITMENT_RESOLUTIONS].join(', ')}`);
    return;
  }
  const resolution = rawResolution as 'honored' | 'abandoned' | 'expired-acknowledged';

  // Validate and sanitize notes (optional, ≤1000 chars, strip control chars + injection markers)
  let notes: string | undefined;
  if (parsed['notes'] !== undefined) {
    if (typeof parsed['notes'] !== 'string') {
      sendError(res, 400, 'notes must be a string when provided');
      return;
    }
    const rawNotes = parsed['notes'] as string;
    // Truncate to 1000 then sanitize (reuse sanitizeReason logic inline)
    const truncatedNotes = rawNotes.length > 1000 ? rawNotes.slice(0, 1000) : rawNotes;
    notes = sanitizeReason(truncatedNotes);
  }

  // 409 guard — check before calling resolve()
  let alreadyResolved: boolean;
  try {
    alreadyResolved = deps.commitmentResolutionTracker.isResolved(commitmentRef);
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), commitmentRef }, 'Admin commitments/resolve: isResolved check failed');
    sendError(res, 500, 'Internal server error');
    return;
  }
  if (alreadyResolved) {
    sendError(res, 409, 'commitment already resolved');
    return;
  }

  // Call resolve()
  let entry: ReturnType<NonNullable<AdminRoutesDeps['commitmentResolutionTracker']>['resolve']>;
  try {
    entry = deps.commitmentResolutionTracker.resolve(commitmentRef, resolution, notes);
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), commitmentRef }, 'Admin commitments/resolve: resolve() threw');
    sendError(res, 500, 'Internal server error');
    return;
  }
  if (entry === null) {
    log.error({ commitmentRef, resolution }, 'Admin commitments/resolve: resolve() returned null');
    sendError(res, 500, 'Internal server error');
    return;
  }

  // On honored resolution, record outcome in TrustTierTracker (fail-open)
  if (resolution === 'honored' && deps.trustTierTracker?.recordOutcome) {
    try {
      deps.trustTierTracker.recordOutcome({ timestamp: Date.now(), kind: 'commitment-honored' });
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), commitmentRef },
        'Admin commitments/resolve: trustTierTracker.recordOutcome failed (non-fatal)',
      );
    }
  }

  log.info({ commitmentRef, resolution, id: entry.id }, 'Admin: commitment resolution recorded');
  sendJson(res, 200, { ok: true, data: entry });
}

// ---------------------------------------------------------------------------
// Digest snapshot collector — shared by digest, metrics, and OTLP endpoints
// ---------------------------------------------------------------------------

const DIGEST_DEFAULT_WINDOW = 7;
const DIGEST_MIN_WINDOW = 1;
const DIGEST_MAX_WINDOW = 90;

/**
 * Collect a typed snapshot from all 11 telemetry subsystems.
 * Each slice is null when the subsystem dep is absent or throws.
 * This is the single source of truth used by /digest, /metrics, and /metrics/otlp.
 */
function collectDigestSnapshot(deps: AdminRoutesDeps, windowDays: number): DigestSnapshot {
  const sinceMs = Date.now() - windowDays * 86_400_000;
  const computedAt = new Date().toISOString();

  // alignment
  let alignment: DigestSnapshot['alignment'] = null;
  try {
    if (deps.alignmentAggregator) {
      const report = deps.alignmentAggregator.getLastReport() ?? null;
      if (report !== null) {
        alignment = {
          overallScore: (report as { overallScore?: number; score?: number }).overallScore ?? (report as { score?: number }).score,
          score: (report as { score?: number }).score,
          level: (report as { level?: string }).level,
          status: (report as { status?: string }).status,
        };
      } else {
        alignment = {
          overallScore: undefined,
          score: undefined,
          level: 'warming-up',
          status: 'warming-up',
        };
      }
    }
    // else: alignment stays null (aggregator not wired)
  } catch { alignment = null; }

  // trust
  let trust: DigestSnapshot['trust'] = null;
  try {
    trust = (deps.trustTierTracker?.getAuditSnapshot() ?? null) as DigestSnapshot['trust'];
  } catch { trust = null; }

  // calibration
  let calibration: DigestSnapshot['calibration'] = null;
  try {
    const calReport = deps.confidenceCalibrationTracker?.getReport({ windowDays }) ?? null;
    if (calReport !== null) {
      calibration = {
        totalSamples: calReport.totalSamples,
        brierScore: calReport.brierScore,
        overallAvgPredicted: calReport.overallAvgPredicted,
        overallSuccessRate: calReport.overallSuccessRate,
      };
    }
  } catch { calibration = null; }

  // commitments
  let commitments: DigestSnapshot['commitments'] = null;
  try {
    if (deps.commitmentAuditor) {
      commitments = {
        expiringCount: deps.commitmentAuditor.getExpiringCommitments(3)?.length ?? null,
        expiredCount: deps.commitmentAuditor.getExpiredCommitments()?.length ?? null,
      };
    }
  } catch { commitments = null; }

  // epistemic
  let epistemic: DigestSnapshot['epistemic'] = null;
  try {
    const epStats = deps.epistemicGate?.getStats?.({ sinceMs }) ?? null;
    if (epStats !== null) {
      epistemic = epStats as DigestSnapshot['epistemic'];
    }
  } catch { epistemic = null; }

  // patterns
  let patterns: DigestSnapshot['patterns'] = null;
  try {
    const patReport = deps.mistakePatternRecognizer?.analyze({ windowDays, minOccurrences: 2 }) ?? null;
    if (patReport !== null) {
      patterns = {
        totalMistakes: patReport.totalMistakes,
        uniquePatterns: patReport.uniquePatterns,
        recurringCount: patReport.recurringPatterns.length,
      };
    }
  } catch { patterns = null; }

  // diagnostics
  let diagnostics: DigestSnapshot['diagnostics'] = null;
  try {
    const diagReport = deps.crossSignalDiagnostics?.analyze({ windowDays }) ?? null;
    if (diagReport !== null) {
      diagnostics = {
        totalEventsScanned: diagReport.totalEventsScanned,
        correlationCount: diagReport.correlations.length,
        topCorrelation: diagReport.correlations[0] ?? null,
      };
    }
  } catch { diagnostics = null; }

  // injection
  let injection: DigestSnapshot['injection'] = null;
  try {
    const breakdown = deps.trustTierTracker?.getOutcomeBreakdown?.({ windowDays }) ?? null;
    if (breakdown !== null) {
      injection = (breakdown.find(r => r.kind === 'injection-detected') ?? null) as DigestSnapshot['injection'];
    }
  } catch { injection = null; }

  // reanchor
  let reanchor: DigestSnapshot['reanchor'] = null;
  try {
    reanchor = (deps.reanchorMonitor?.getStats({ windowDays }) ?? null) as DigestSnapshot['reanchor'];
  } catch { reanchor = null; }

  // resolutions
  let resolutions: DigestSnapshot['resolutions'] = null;
  try {
    resolutions = (deps.commitmentResolutionTracker?.getStats?.({ windowDays }) ?? null) as DigestSnapshot['resolutions'];
  } catch { resolutions = null; }

  return {
    windowDays,
    computedAt,
    alignment,
    trust,
    calibration,
    commitments,
    epistemic,
    patterns,
    diagnostics,
    injection,
    reanchor,
    resolutions,
  };
}

// ---------------------------------------------------------------------------
// Metrics route handlers — Prometheus text + OTLP JSON
// ---------------------------------------------------------------------------

/**
 * GET /v1/admin/metrics
 * Returns Prometheus text exposition format (text/plain; version=0.0.4).
 * Missing subsystems emit `sudo_<name>_up 0` instead of failing the scrape.
 */
function handleMetricsGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const windowParam = urlObj.searchParams.get('window');

    let windowDays = DIGEST_DEFAULT_WINDOW;
    if (windowParam !== null && windowParam !== '') {
      const parsed = parseInt(windowParam, 10);
      if (Number.isFinite(parsed) && !isNaN(parsed)) {
        windowDays = Math.min(Math.max(DIGEST_MIN_WINDOW, parsed), DIGEST_MAX_WINDOW);
      }
    }

    const snapshot = collectDigestSnapshot(deps, windowDays);
    const text = digestToPrometheusText(snapshot);
    sendText(res, 200, text, 'text/plain; version=0.0.4; charset=utf-8');
    log.info({ windowDays }, 'Admin: metrics (Prometheus) queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: metrics get failed');
    if (!res.headersSent) sendText(res, 500, '# error generating metrics\n', 'text/plain; version=0.0.4; charset=utf-8');
  }
}

/**
 * GET /v1/admin/metrics/otlp
 * Returns an OTLP/HTTP JSON metrics payload (application/json).
 * Suitable for OTEL collectors polling via HTTP.
 */
function handleMetricsOtlpGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const windowParam = urlObj.searchParams.get('window');

    let windowDays = DIGEST_DEFAULT_WINDOW;
    if (windowParam !== null && windowParam !== '') {
      const parsed = parseInt(windowParam, 10);
      if (Number.isFinite(parsed) && !isNaN(parsed)) {
        windowDays = Math.min(Math.max(DIGEST_MIN_WINDOW, parsed), DIGEST_MAX_WINDOW);
      }
    }

    const snapshot = collectDigestSnapshot(deps, windowDays);
    const payload = toOTLPMetrics(snapshot, {
      serviceName: 'sudo-ai-v5',
      instanceId: process.env['HOSTNAME'] ?? 'sudo-ai',
    });
    sendJson(res, 200, payload);
    log.info({ windowDays }, 'Admin: metrics/otlp queried');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: metrics/otlp get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Digest route handler — unified telemetry snapshot
// ---------------------------------------------------------------------------

function handleDigestGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  const rawUrl = req.url ?? '/';
  const urlObj = new URL(rawUrl, 'http://localhost');
  const windowParam = urlObj.searchParams.get('window');

  // Validate window [1,90] default 7
  let windowDays: number;
  if (windowParam === null || windowParam === '') {
    windowDays = DIGEST_DEFAULT_WINDOW;
  } else {
    const parsed = parseInt(windowParam, 10);
    if (!Number.isFinite(parsed) || isNaN(parsed)) {
      windowDays = DIGEST_DEFAULT_WINDOW;
    } else if (parsed < DIGEST_MIN_WINDOW || parsed > DIGEST_MAX_WINDOW) {
      sendError(res, 400, `window must be between ${DIGEST_MIN_WINDOW} and ${DIGEST_MAX_WINDOW}`);
      return;
    } else {
      windowDays = parsed;
    }
  }

  const snapshot = collectDigestSnapshot(deps, windowDays);

  // Preserve full alignment report for digest backward compatibility.
  // collectDigestSnapshot uses a reduced AlignmentSlice for metrics/OTLP;
  // the digest endpoint must passthrough the complete getLastReport() object
  // (including signals, diagnosis, failedOpen, evaluatedAt, contributingSignals).
  let fullAlignment: unknown = null;
  try {
    if (deps.alignmentAggregator) {
      const rawReport = deps.alignmentAggregator.getLastReport() ?? null;
      if (rawReport !== null) {
        fullAlignment = rawReport;
      } else {
        fullAlignment = { level: 'warming-up', status: 'warming-up', score: null };
      }
    }
    // else: fullAlignment stays null (aggregator not wired)
  } catch { /* fail-open — return null for alignment slice */ }

  sendJson(res, 200, {
    ok: true,
    data: {
      windowDays: snapshot.windowDays,
      computedAt: snapshot.computedAt,
      alignment: fullAlignment,
      trust: snapshot.trust,
      calibration: snapshot.calibration,
      commitments: snapshot.commitments,
      epistemic: snapshot.epistemic,
      patterns: snapshot.patterns,
      diagnostics: snapshot.diagnostics,
      injection: snapshot.injection,
      reanchor: snapshot.reanchor,
      resolutions: snapshot.resolutions,
    },
  });
  log.info({ windowDays }, 'Admin: digest queried');
}

// ---------------------------------------------------------------------------
// Veto threshold route handler
// ---------------------------------------------------------------------------

/**
 * GET /v1/admin/veto/threshold
 * Returns the current base and effective veto threshold with calibration metadata.
 * If no tuner is configured, returns 503.
 */
function handleVetoThresholdGet(res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.autoThresholdTuner) {
    sendError(res, 503, 'auto-threshold tuner not configured');
    return;
  }
  try {
    const BASE_THRESHOLD = 0.5; // matches BASE_VETO_THRESHOLD in veto-gate.ts
    // Trigger a fresh computation so the result is always up-to-date
    const effectiveThreshold = deps.autoThresholdTuner.computeVetoThreshold(BASE_THRESHOLD);
    const comp = deps.autoThresholdTuner.getLastComputation();

    sendJson(res, 200, {
      ok: true,
      data: {
        baseThreshold: BASE_THRESHOLD,
        effectiveThreshold,
        brierScore: comp?.brierScore ?? 0,
        totalSamples: comp?.totalSamples ?? 0,
        adjustment: comp?.adjustment ?? 0,
        computedAt: comp?.computedAt ?? new Date().toISOString(),
        // Reports whether adaptive tuning is live in vote comparison.
        // SUDO_VETO_AUTO_TUNE=1 enables; default=0 (static threshold).
        autoTuneEnabled: process.env['SUDO_VETO_AUTO_TUNE'] === '1',
      },
    });
    log.info(
      { baseThreshold: BASE_THRESHOLD, effectiveThreshold, adjustment: comp?.adjustment ?? 0 },
      'Admin: veto threshold queried',
    );
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: veto threshold get failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Remediation stats handler
// ---------------------------------------------------------------------------

/**
 * Handle GET /v1/admin/remediation/stats.
 * Returns the AlignmentAutoRemediator stats snapshot.
 * Returns 503 if the remediator is not configured.
 */
function handleRemediationStatsGet(res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.alignmentAutoRemediator) {
    sendError(res, 503, 'AlignmentAutoRemediator not configured');
    return;
  }
  try {
    const data = deps.alignmentAutoRemediator.getStats();
    sendJson(res, 200, { ok: true, data });
    log.info({ remediationsTriggered: data.remediationsTriggered }, 'Admin: remediation stats served');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: remediation stats failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Dashboard route handler
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = renderDashboardHtml();
const DASHBOARD_HTML_BUF = Buffer.from(DASHBOARD_HTML, 'utf8');

/**
 * Handle GET /v1/admin/dashboard.
 *
 * Auth: Bearer header OR ?token= query param (timing-safe compare).
 * On success: 200 text/html with CSP header.
 * On failure: 401 text/html (short page) — never returns JSON.
 */
function handleDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  tokenBuf: Buffer | null,
): void {
  // Parse query string for ?token=xxx
  const rawUrl = req.url ?? '/';
  const urlObj = new URL(rawUrl, 'http://localhost');
  const qToken = urlObj.searchParams.get('token') ?? '';

  let authed = false;
  if (tokenBuf === null) {
    // No token configured — open access
    authed = true;
  } else if (isAuthorised(req, tokenBuf)) {
    // Bearer header matched
    authed = true;
  } else if (qToken.length > 0) {
    // ?token= query param timing-safe compare
    const qBuf = Buffer.from(qToken, 'utf8');
    authed = qBuf.length === tokenBuf.length && timingSafeEqual(qBuf, tokenBuf);
  }

  if (!authed) {
    const body = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>401 Unauthorized</title></head><body style="font-family:monospace;background:#0d1117;color:#c9d1d9;padding:32px"><h1 style="color:#f85149">401 Unauthorized</h1><p style="margin-top:12px">Supply your admin token via:<br><code>Authorization: Bearer &lt;token&gt;</code> header<br>or append <code>?token=&lt;token&gt;</code> to the URL.</p></body></html>';
    res.writeHead(401, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': DASHBOARD_HTML_BUF.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  });
  res.end(DASHBOARD_HTML_BUF);
  log.info({ ip: req.socket?.remoteAddress }, 'Admin: dashboard served');
}

// ---------------------------------------------------------------------------
// Skill optimization route handlers
// ---------------------------------------------------------------------------

const SO_DEFAULT_LIMIT = 20;
const SO_MAX_LIMIT = 100;
const SO_VALID_STATUSES: SkillOptimizationStatus[] = ['pending', 'approved', 'rejected'];

function handleSkillOptimizationsGet(req: IncomingMessage, res: ServerResponse, deps: AdminRoutesDeps): void {
  if (!deps.skillOptimizationStore) {
    sendError(res, 503, 'SkillOptimizer not initialised');
    return;
  }
  try {
    const rawUrl = req.url ?? '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const statusParam = urlObj.searchParams.get('status');
    const limitParam = urlObj.searchParams.get('limit');
    const offsetParam = urlObj.searchParams.get('offset');

    let statusFilter: SkillOptimizationStatus | undefined;
    if (statusParam && (SO_VALID_STATUSES as string[]).includes(statusParam)) {
      statusFilter = statusParam as SkillOptimizationStatus;
    }

    const parsedLimit = parseInt(limitParam ?? '', 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(1, parsedLimit), SO_MAX_LIMIT)
      : SO_DEFAULT_LIMIT;

    const parsedOffset = parseInt(offsetParam ?? '', 10);
    const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;

    const result = deps.skillOptimizationStore.list({ status: statusFilter, limit, offset });
    sendJson(res, 200, {
      ok: true,
      data: result.data,
      total: result.total,
      limit,
      offset,
    });
    log.info({ count: result.data.length, total: result.total }, 'Admin: skill optimizations listed');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: skill optimizations list failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

async function handleSkillOptimizationApprove(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRoutesDeps,
  id: string,
): Promise<void> {
  void req; // body ignored per spec
  if (!deps.skillOptimizationStore) {
    sendError(res, 503, 'SkillOptimizer not initialised');
    return;
  }
  try {
    const existing = deps.skillOptimizationStore.getById(id);
    if (!existing) {
      sendError(res, 404, 'Proposal not found');
      return;
    }
    const updated = deps.skillOptimizationStore.approve(id);
    // Sign approved skill proposal (fail-open).
    let signedArtifact: ReturnType<typeof artifactSigner.sign> | undefined;
    if (process.env['SUDO_SIGNING_DISABLE'] !== '1') {
      try {
        signedArtifact = artifactSigner.sign(updated, 'skill');
        log.info({ id, keyId: signedArtifact.keyId }, 'Admin: skill proposal signed');
      } catch (signErr) {
        log.warn({ err: String(signErr), id }, 'Admin: signing failed — returning unsigned proposal');
      }
    }
    const skillApproveResponse = signedArtifact ? { ok: true, data: updated, signedArtifact } : { ok: true, data: updated };
    sendJson(res, 200, skillApproveResponse);
    log.info({ id }, 'Admin: skill optimization proposal approved');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), id }, 'Admin: skill optimization approve failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

async function handleSkillOptimizationReject(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRoutesDeps,
  id: string,
): Promise<void> {
  if (!deps.skillOptimizationStore) {
    sendError(res, 503, 'SkillOptimizer not initialised');
    return;
  }

  let reason: string | undefined;
  try {
    const bodyText = await readBody(req);
    if (bodyText.trim().length > 0) {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof parsed['reason'] === 'string' && parsed['reason'].length > 0) {
        reason = parsed['reason'];
      }
    }
  } catch {
    // Body is optional — proceed without reason
  }

  try {
    const existing = deps.skillOptimizationStore.getById(id);
    if (!existing) {
      sendError(res, 404, 'Proposal not found');
      return;
    }
    const updated = deps.skillOptimizationStore.reject(id, reason);
    sendJson(res, 200, { ok: true, data: updated });
    log.info({ id, hasReason: reason !== undefined }, 'Admin: skill optimization proposal rejected');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), id }, 'Admin: skill optimization reject failed');
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// GET /v1/admin/public-key
// ---------------------------------------------------------------------------

/**
 * Return public key metadata for the artifact signer.
 * Only public material is exposed — the private key is never included.
 * getPublicKey() return includes keyVersion + optional retiring; passed through verbatim.
 */
function handlePublicKeyGet(res: ServerResponse): void {
  try {
    const info = artifactSigner.getPublicKey();
    sendJson(res, 200, { ok: true, data: info });
    log.debug({ keyId: info.keyId }, 'Admin: public-key retrieved');
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: public-key retrieval failed');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /v1/admin/key/rotate — rotate the ArtifactSigner ed25519 keypair.
 *
 * Kill-switch: SUDO_KEY_ROTATION_DISABLE=1 → 503 before any signer work.
 * Idempotency: if rotate() is called within the minimum interval window it returns
 * the existing active key with idempotent:true — the endpoint still returns 200.
 * Auth: caller must already be authorised (isAuthorised guard runs in dispatcher
 * before this handler is reached — no second auth check needed here).
 * Private key material is NEVER included in the response.
 */
async function handleKeyRotate(res: ServerResponse): Promise<void> {
  // Kill-switch check MUST happen before any signer work.
  if (process.env['SUDO_KEY_ROTATION_DISABLE'] === '1') {
    sendError(res, 503, 'Key rotation is disabled (SUDO_KEY_ROTATION_DISABLE=1)');
    log.warn('Admin: key rotation attempted while SUDO_KEY_ROTATION_DISABLE=1');
    return;
  }

  try {
    const result = artifactSigner.rotate();
    const data: Record<string, unknown> = {
      keyId:             result.keyId,
      keyVersion:        result.keyVersion,
      algorithm:         result.algorithm,
      generatedAt:       result.generatedAt,
      idempotent:        (result as Record<string, unknown>)['idempotent'] ?? false,
    };
    if (result.retiredKeyId    !== undefined) data['retiredKeyId']    = result.retiredKeyId;
    if (result.retiredKeyVersion !== undefined) data['retiredKeyVersion'] = result.retiredKeyVersion;
    sendJson(res, 200, { ok: true, data });
    log.info(
      { keyId: result.keyId, keyVersion: result.keyVersion, idempotent: data['idempotent'] },
      'Admin: key rotation successful',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'Admin: key rotation failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Register admin REST route handlers on the server's 'request' event.
 * Adds a new listener on the same server, following the http-api.ts pattern.
 * Non-admin paths are ignored immediately (fall through to other listeners).
 *
 * @param server    Existing http.Server.
 * @param deps      AuditTrail and InspectionQueue duck-typed instances.
 * @param tokenBuf  Shared token buffer for timing-safe auth.
 */
export function registerAdminRoutes(
  server: HttpServer,
  deps: AdminRoutesDeps,
  tokenBuf: Buffer | null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method   = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    // Only handle /v1/admin/* — fall through for everything else
    if (!pathname.startsWith('/v1/admin/') && pathname !== '/v1/admin') {
      return;
    }

    // GET /v1/admin/dashboard — own auth (Bearer header OR ?token= query param)
    if (method === 'GET' && pathname === '/v1/admin/dashboard') {
      handleDashboard(req, res, tokenBuf);
      return;
    }

    // Auth check for all other admin routes
    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    // GET /v1/admin/audit/verify
    if (method === 'GET' && pathname === '/v1/admin/audit/verify') {
      handleAuditVerify(res, deps);
      return;
    }

    // GET /v1/admin/public-key
    if (method === 'GET' && pathname === '/v1/admin/public-key') {
      handlePublicKeyGet(res);
      return;
    }

    // POST /v1/admin/key/rotate
    if (method === 'POST' && pathname === '/v1/admin/key/rotate') {
      handleKeyRotate(res).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: unhandled error in key/rotate');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/admin/inspection
    if (method === 'GET' && pathname === '/v1/admin/inspection') {
      handleInspectionQuery(req, res, deps);
      return;
    }

    // POST /v1/admin/inspection/:id/status
    const statusUpdateMatch = /^\/v1\/admin\/inspection\/([^/]+)\/status$/.exec(pathname);
    if (method === 'POST' && statusUpdateMatch) {
      const id = statusUpdateMatch[1]!;
      handleInspectionStatusUpdate(req, res, deps, id).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: unhandled error in status update');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/admin/veto/threshold
    if (method === 'GET' && pathname === '/v1/admin/veto/threshold') {
      handleVetoThresholdGet(res, deps);
      return;
    }

    // POST /v1/admin/veto/override
    if (method === 'POST' && pathname === '/v1/admin/veto/override') {
      handleVetoOverridePost(req, res, deps).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: unhandled error in veto override post');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/admin/veto/overrides
    if (method === 'GET' && pathname === '/v1/admin/veto/overrides') {
      handleVetoOverrideList(req, res, deps);
      return;
    }

    // GET /v1/admin/alignment
    if (method === 'GET' && pathname === '/v1/admin/alignment') {
      handleAlignmentGet(res, deps);
      return;
    }

    // GET /v1/admin/epistemic/log
    if (method === 'GET' && pathname === '/v1/admin/epistemic/log') {
      handleEpistemicLogGet(req, res, deps);
      return;
    }

    // GET /v1/admin/commitments/expiring
    if (method === 'GET' && pathname === '/v1/admin/commitments/expiring') {
      handleCommitmentsExpiringGet(req, res, deps);
      return;
    }

    // GET /v1/admin/epistemic/stats
    if (method === 'GET' && pathname === '/v1/admin/epistemic/stats') {
      handleEpistemicStatsGet(req, res, deps);
      return;
    }

    // GET /v1/admin/trust
    if (method === 'GET' && pathname === '/v1/admin/trust') {
      handleTrustGet(res, deps);
      return;
    }

    // GET /v1/admin/patterns
    if (method === 'GET' && pathname === '/v1/admin/patterns') {
      handlePatternsGet(req, res, deps);
      return;
    }

    // GET /v1/admin/calibration
    if (method === 'GET' && pathname === '/v1/admin/calibration') {
      handleCalibrationGet(req, res, deps);
      return;
    }

    // GET /v1/admin/diagnostics
    if (method === 'GET' && pathname === '/v1/admin/diagnostics') {
      handleDiagnosticsGet(req, res, deps);
      return;
    }

    // GET /v1/admin/injection/stats
    if (method === 'GET' && pathname === '/v1/admin/injection/stats') {
      handleInjectionStatsGet(req, res, deps);
      return;
    }

    // POST /v1/admin/commitments/resolve
    if (method === 'POST' && pathname === '/v1/admin/commitments/resolve') {
      handleCommitmentsResolvePost(req, res, deps).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: unhandled error in commitments/resolve');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/admin/reanchor/stats
    if (method === 'GET' && pathname === '/v1/admin/reanchor/stats') {
      handleReanchorStatsGet(req, res, deps);
      return;
    }

    // GET /v1/admin/reanchor/recent
    if (method === 'GET' && pathname === '/v1/admin/reanchor/recent') {
      handleReanchorRecentGet(req, res, deps);
      return;
    }

    // GET /v1/admin/digest
    if (method === 'GET' && pathname === '/v1/admin/digest') {
      handleDigestGet(req, res, deps);
      return;
    }

    // GET /v1/admin/metrics — Prometheus text exposition format
    if (method === 'GET' && pathname === '/v1/admin/metrics') {
      handleMetricsGet(req, res, deps);
      return;
    }

    // GET /v1/admin/metrics/otlp — OTLP/HTTP JSON format
    if (method === 'GET' && pathname === '/v1/admin/metrics/otlp') {
      handleMetricsOtlpGet(req, res, deps);
      return;
    }

    // GET /v1/admin/remediation/stats
    if (method === 'GET' && pathname === '/v1/admin/remediation/stats') {
      handleRemediationStatsGet(res, deps);
      return;
    }

    // GET /v1/admin/skills/optimizations
    if (method === 'GET' && pathname === '/v1/admin/skills/optimizations') {
      handleSkillOptimizationsGet(req, res, deps);
      return;
    }

    // POST /v1/admin/skills/optimizations/:id/approve
    const soApproveMatch = /^\/v1\/admin\/skills\/optimizations\/([^/]+)\/approve$/.exec(pathname);
    if (method === 'POST' && soApproveMatch) {
      const id = soApproveMatch[1]!;
      handleSkillOptimizationApprove(req, res, deps, id).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: unhandled error in skill optimization approve');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // POST /v1/admin/skills/optimizations/:id/reject
    const soRejectMatch = /^\/v1\/admin\/skills\/optimizations\/([^/]+)\/reject$/.exec(pathname);
    if (method === 'POST' && soRejectMatch) {
      const id = soRejectMatch[1]!;
      handleSkillOptimizationReject(req, res, deps, id).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: unhandled error in skill optimization reject');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // Some route groups (bench-routes, learning-routes) register their own
    // listeners AFTER admin-routes.  Fall through so those listeners can respond.
    // synth-probe-routes also registers its own listener AFTER admin-routes.
    if (
      pathname.startsWith('/v1/admin/bench') ||
      pathname.startsWith('/v1/admin/learning') ||
      pathname.startsWith('/v1/admin/compare') ||
      pathname === '/v1/admin/synth-probe' ||
      pathname === '/v1/admin/canvas'
    ) {
      return;
    }

    // Unmatched /v1/admin/* path
    sendError(res, 404, 'Not found');
  });

  log.info('Admin routes registered (GET /v1/admin/audit/verify, GET /v1/admin/public-key, POST /v1/admin/key/rotate, GET /v1/admin/inspection, POST /v1/admin/inspection/:id/status, GET /v1/admin/veto/threshold, POST /v1/admin/veto/override, GET /v1/admin/veto/overrides, GET /v1/admin/alignment, GET /v1/admin/epistemic/log, GET /v1/admin/commitments/expiring, GET /v1/admin/epistemic/stats, GET /v1/admin/trust, GET /v1/admin/patterns, GET /v1/admin/calibration, GET /v1/admin/diagnostics, POST /v1/admin/commitments/resolve, GET /v1/admin/injection/stats, GET /v1/admin/reanchor/stats, GET /v1/admin/reanchor/recent, GET /v1/admin/digest, GET /v1/admin/metrics, GET /v1/admin/metrics/otlp, GET /v1/admin/dashboard, GET /v1/admin/remediation/stats, GET /v1/admin/skills/optimizations, POST /v1/admin/skills/optimizations/:id/approve, POST /v1/admin/skills/optimizations/:id/reject)');
}
