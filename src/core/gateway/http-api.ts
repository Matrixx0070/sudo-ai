/**
 * gateway/http-api.ts — OpenAI-compatible HTTP API routes.
 *
 * Endpoints:
 *   GET  /health                — unauthenticated liveness check
 *   GET  /v1/models             — list available models
 *   POST /v1/chat/completions   — chat completions (stream + non-stream)
 *
 * Auth: if GATEWAY_TOKEN env var is set, all /v1/* routes require
 *       Authorization: Bearer <token> (timing-safe comparison).
 * Body: capped at 256 KB; oversized requests get HTTP 400.
 * Errors: never leak internal details to the caller.
 */

import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { serveStaticFile } from './static-middleware.js';
import { getCacheKey, cacheGet, cacheSet } from './cache.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerAdminSleepRoutes } from './admin-sleep-routes.js';
import { registerAdminClaudeOAuthRoutes } from './admin-claude-oauth-routes.js';
import { registerFederationRoutes } from './federation-routes.js';
import type { FederationRoutesDeps } from './federation-routes.js';
import { registerFederationErrorRoutes } from './federation-error-routes.js';
import type { FederationErrorRoutesDeps } from './federation-error-types.js';
import { registerBenchRoutes } from './bench-routes.js';
import type { BenchRoutesDeps } from './bench-routes.js';
import { registerLearningRoutes } from './learning-routes.js';
import type { LearningRoutesDeps } from './learning-routes.js';
import { registerSavingsRoutes } from './savings-routes.js';
import type { CostTrackerLike } from './savings-routes.js';
import { registerCompareRoutes } from './compare-routes.js';
import type { BrainLike as CompareBrainLike, ComplexityScorerLike } from './compare-routes.js';
import { registerSynthProbeRoutes } from './synth-probe-routes.js';
import type { SkillOptimizationProposal, SkillOptimizationStatus } from '../shared/wave10-types.js';
import type { ChainVerifyResult } from '../security/audit-trail.js';
import type { QueryFilter, InspectionQueueEntry, InspectionStatus } from '../security/inspection-queue.js';
import type { VetoOverride } from '../agent/veto-override-store.js';
import type { AggregatorResult, AlignmentSignals } from '../agent/alignment-aggregator.js';
import type { EpistemicLogRow, EpistemicTag } from '../cognition/epistemic-gate.js';
import type { CommitmentRow } from '../cognition/commitment-auditor.js';

const log = createLogger('http-api');

const MODEL_ID      = 'sudo-ai-v5';
const MODEL_CREATED = 1_700_000_000; // stable epoch for model list
const MAX_BODY      = 256 * 1024;    // 256 KB body cap

// ---------------------------------------------------------------------------
// Duck-typed dependency interfaces
// ---------------------------------------------------------------------------

interface AgentLoopLike {
  run(sessionId: string, message: string): Promise<{ text: string; attachments: unknown[] }>;
}

interface SessionManagerLike {
  getOrCreate(channel: string, peerId: string): Promise<{ id: string }>;
}

/** Alignment report shape passed through from AlignmentAggregator.getLastReport(). */
type AlignmentReport = AggregatorResult & {
  evaluatedAt: string;
  signals: AlignmentSignals;
  contributingSignals: string[];
};

export interface HttpApiDeps {
  sessionManager: SessionManagerLike;
  agentLoop: AgentLoopLike;
  auditTrail?: {
    verifyChain(): ChainVerifyResult;
    recordTriple?(entry: { mistake: string; learned: string; commitment: string; ttl_days: number }): void;
  };
  inspectionQueue?: {
    query(filter?: QueryFilter): InspectionQueueEntry[];
    updateStatus(id: string, status: InspectionStatus, reviewedBy?: string): void;
  };
  sleepCycle?: {
    clearDegraded(): void;
    isDegraded(): boolean;
  };
  vetoOverrideStore?: {
    recordOverride(o: Omit<VetoOverride, 'id' | 'createdAt'> & { contentHash?: string | null }): VetoOverride;
    listOverrides(limit?: number): VetoOverride[];
  };
  alignmentAggregator?: {
    getLastReport(): AlignmentReport | null;
  };
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
  commitmentAuditor?: {
    getExpiringCommitments(windowDays: number): CommitmentRow[];
    getExpiredCommitments(): CommitmentRow[];
  };
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
    /** Optional — forwarded to AdminRoutesDeps for GET /v1/admin/digest. */
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
  /** Optional — if absent, GET /v1/admin/reanchor/stats and /recent return 503. */
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
  /** Optional — federation. If absent, /v1/federation/* routes are not registered. */
  federation?: FederationRoutesDeps;
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
  /** Optional — bench routes. If absent, /v1/admin/bench/* routes are not registered. */
  bench?: BenchRoutesDeps;
  /** Optional — learning routes. If absent, /v1/admin/learning/* routes are not registered. */
  learning?: LearningRoutesDeps;
  /** Optional — savings routes. If absent, /v1/savings is not registered. */
  savings?: { costTracker: CostTrackerLike };
  /** Optional — compare routes. If absent, /v1/admin/compare is not registered. */
  compare?: { brain: CompareBrainLike; complexityScorer: ComplexityScorerLike };
  /** Optional — Federation Error Protocol. If absent, /v1/federation/error-* routes are not registered. */
  errorIngestor?: FederationErrorRoutesDeps['errorIngestor'];
  tokenPool?: FederationErrorRoutesDeps['tokenPool'];
  fedAuth?: FederationErrorRoutesDeps['fedAuth'];
}

// ---------------------------------------------------------------------------
// Request type (OpenAI schema — all fields optional for safe parsing)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getTokenBuf(): Buffer | null {
  const t = process.env['GATEWAY_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}

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
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: 'error', code: status } });
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
// Validation helpers
// ---------------------------------------------------------------------------

function parseMessages(raw: ChatRequest): ChatMessage[] | null {
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return null;
  for (const m of raw.messages) {
    const entry = m as Record<string, unknown>;
    if (typeof entry['role'] !== 'string' || typeof entry['content'] !== 'string') return null;
  }
  return raw.messages as ChatMessage[];
}

function lastUserMessage(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!.content;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function buildCompletion(id: string, content: string): unknown {
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sseChunk(id: string, content: string, finishReason: string | null): string {
  const delta = finishReason !== null ? {} : { role: 'assistant', content };
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleModels(res: ServerResponse): void {
  sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: MODEL_CREATED, owned_by: 'sudo-ai' }] });
}

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, deps: HttpApiDeps): Promise<void> {
  // Parse + validate body
  let raw: ChatRequest;
  let bodyStr = '';
  try {
    bodyStr = await readBody(req);
    raw = JSON.parse(bodyStr) as ChatRequest;
  } catch {
    sendError(res, 400, 'Invalid or oversized request body'); return;
  }

  const messages = parseMessages(raw);
  if (!messages) { sendError(res, 400, 'messages must be a non-empty array of {role, content} objects'); return; }

  const wantStream = raw.stream === true;

  const userMsg = lastUserMessage(messages);
  if (!userMsg) { sendError(res, 400, 'messages must contain at least one user message'); return; }
  if (userMsg.length > 32_768) { sendError(res, 400, 'User message too long (max 32768 characters)'); return; }

  // Resolve session (keyed by client IP — one persistent context per connecting client)
  const peerId = req.socket.remoteAddress ?? 'http-client';
  let sessionId: string;
  try {
    sessionId = (await deps.sessionManager.getOrCreate('http', peerId)).id;
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'sessionManager.getOrCreate failed');
    sendError(res, 500, 'Internal server error'); return;
  }

  // Response cache (orphan wiring): a repeated identical request — same session +
  // model + last user message — within the 60s TTL returns the prior completion and
  // skips a full agent run. Per-session keying prevents cross-client collisions;
  // streaming responses are never cached. Opt-in SUDO_RESPONSE_CACHE=1 (default OFF →
  // byte-identical behavior). Fail-open: any cache error falls through to a live run.
  const cacheOn = process.env['SUDO_RESPONSE_CACHE'] === '1' && !wantStream;
  const cacheKey = cacheOn ? `${sessionId}::${getCacheKey(bodyStr)}` : '';
  if (cacheOn) {
    try {
      const cached = cacheGet(cacheKey);
      if (cached) {
        sendJson(res, 200, JSON.parse(cached));
        log.info({ sessionId, cache: 'hit' }, 'chat.completions cache hit');
        return;
      }
    } catch (cErr) { log.warn({ err: cErr instanceof Error ? cErr.message : String(cErr) }, 'response cache read failed — continuing'); }
  }

  // Run agent
  let agentText: string;
  try {
    agentText = (await deps.agentLoop.run(sessionId, userMsg)).text;
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), sessionId }, 'agentLoop.run failed');
    sendError(res, 500, 'Internal server error'); return;
  }

  const completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;

  // Score prompt complexity and attach to response.
  let complexityResult: unknown;
  try {
    const { scoreComplexity } = await import('../agent/complexity-scorer.js');
    const modelName = typeof raw.model === 'string' ? raw.model : '';
    complexityResult = scoreComplexity({ prompt: userMsg, modelName });
  } catch (cErr) {
    log.warn({ err: cErr instanceof Error ? cErr.message : String(cErr) }, 'complexity scorer failed — omitting from response');
  }

  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(sseChunk(completionId, agentText, null));
    // Final chunk with complexity field on the stop chunk
    const stopChunk = { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(complexityResult ? { complexity: complexityResult } : {}) };
    res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    const completion = Object.assign({}, buildCompletion(completionId, agentText) as Record<string, unknown>, complexityResult ? { complexity: complexityResult } : {});
    if (cacheOn) { try { cacheSet(cacheKey, JSON.stringify(completion)); } catch (cErr) { log.warn({ err: cErr instanceof Error ? cErr.message : String(cErr) }, 'response cache write failed — continuing'); } }
    sendJson(res, 200, completion);
  }

  log.info({ sessionId, completionId, stream: wantStream, textLen: agentText.length }, 'chat.completions handled');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Attach OpenAI-compatible HTTP routes to the provided http.Server.
 * Routes that do not match /health or /v1/* fall through to other listeners.
 *
 * @param server - Existing http.Server (shared with the WebSocket gateway).
 * @param deps   - Session manager and agent loop.
 */
export function attachHttpApi(server: HttpServer, deps: HttpApiDeps): void {
  const tokenBuf = getTokenBuf();
  if (deps.auditTrail && deps.inspectionQueue) {
    registerAdminRoutes(server, {
      auditTrail: deps.auditTrail,
      inspectionQueue: deps.inspectionQueue,
      vetoOverrideStore: deps.vetoOverrideStore,
      alignmentAggregator: deps.alignmentAggregator,
      epistemicGate: deps.epistemicGate,
      commitmentAuditor: deps.commitmentAuditor,
      trustTierTracker: deps.trustTierTracker,
      mistakePatternRecognizer: deps.mistakePatternRecognizer,
      confidenceCalibrationTracker: deps.confidenceCalibrationTracker,
      crossSignalDiagnostics: deps.crossSignalDiagnostics,
      commitmentResolutionTracker: deps.commitmentResolutionTracker,
      reanchorMonitor: deps.reanchorMonitor,
      autoThresholdTuner: deps.autoThresholdTuner,
      alignmentAutoRemediator: deps.alignmentAutoRemediator,
      skillOptimizationStore: deps.skillOptimizationStore,
    }, tokenBuf);
  }
  if (deps.sleepCycle && deps.auditTrail?.recordTriple) {
    const auditTrailWithRecordTriple = deps.auditTrail as {
      verifyChain(): ChainVerifyResult;
      recordTriple(entry: { mistake: string; learned: string; commitment: string; ttl_days: number }): void;
    };
    registerAdminSleepRoutes(server, { sleepCycle: deps.sleepCycle, auditTrail: auditTrailWithRecordTriple }, tokenBuf);
  }
  // Claude OAuth (PKCE) admin routes — login/status/refresh/disconnect.
  // No deps: the manager is a process-wide singleton (claude-oauth-manager.ts).
  registerAdminClaudeOAuthRoutes(server, tokenBuf);
  if (deps.federation) {
    registerFederationRoutes(server, deps.federation, tokenBuf);
  }
  // Federation Error Protocol
  if (deps.errorIngestor && deps.tokenPool) {
    registerFederationErrorRoutes(server, { errorIngestor: deps.errorIngestor, tokenPool: deps.tokenPool, fedAuth: deps.fedAuth ?? (() => false) }, tokenBuf);
  }
  // Bench + learning routes
  if (deps.bench) {
    registerBenchRoutes(server, deps.bench, tokenBuf);
  }
  if (deps.learning) {
    registerLearningRoutes(server, deps.learning, tokenBuf);
  }
  // Savings + compare routes
  if (deps.savings) {
    registerSavingsRoutes(server, deps.savings);
  }
  if (deps.compare) {
    registerCompareRoutes(server, deps.compare);
  }
  // Synth-probe: always registered (kill-switch checked per-request)
  registerSynthProbeRoutes(server, tokenBuf);
  log[tokenBuf ? 'info' : 'warn'](
    tokenBuf ? 'HTTP API auth enabled (GATEWAY_TOKEN is set)' : 'HTTP API auth DISABLED — set GATEWAY_TOKEN',
  );

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method   = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    // Serve React SPA static files (before route matching)
    if (serveStaticFile(req, res, pathname)) return;

    if (pathname.startsWith('/v1/')) {
      // Admin, session, agent, file, skill, vault routes are handled by their own
      // server.on('request') listeners (registered before this listener). Fall through
      // to those listeners without sending a response — do NOT send 404.
      if (
        pathname.startsWith('/v1/admin') ||
        pathname.startsWith('/v1/sessions') ||
        pathname.startsWith('/v1/agents') ||
        pathname.startsWith('/v1/files') ||
        pathname.startsWith('/v1/registry') ||
        pathname.startsWith('/v1/skills') ||
        pathname.startsWith('/v1/vaults') ||
        pathname.startsWith('/v1/federation') ||
        pathname.startsWith('/v1/savings')
      ) {
        return;
      }

      if (!isAuthorised(req, tokenBuf)) { sendError(res, 401, 'Unauthorized: invalid or missing bearer token'); return; }

      if (method === 'GET' && pathname === '/v1/models') { handleModels(res); return; }

      if (method === 'POST' && pathname === '/v1/chat/completions') {
        handleChatCompletions(req, res, deps).catch((err: unknown) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled error in handleChatCompletions');
          if (!res.headersSent) sendError(res, 500, 'Internal server error');
        });
        return;
      }

      sendError(res, 404, 'Not found');
    }

    // /.well-known routes are handled by registerWellKnownRoutes listener.
    // This standalone guard MUST be outside the /v1/ block so it fires for non-/v1/ paths.
    if (pathname.startsWith('/.well-known')) { return; }

    // Non-matching routes fall through to other server listeners
  });

  log.info('HTTP API attached (GET /health, GET /v1/models, POST /v1/chat/completions)');
}
