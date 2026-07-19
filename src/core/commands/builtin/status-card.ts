/**
 * @file builtin/status-card.ts
 * @description BO7 / scorecard-S6 — the ONE shared /status card builder.
 *
 * OpenClaw ships an emoji-labeled /status card on every surface; this module is
 * our single source of truth so Telegram (`/status`), the web SPA/chat (same
 * command via the cross-channel directive path) and the admin dashboard (the
 * `/v1/admin/system/status` endpoint + inline card) all render from ONE place.
 *
 * Layering:
 *   - {@link assembleStatusCard} is PURE — it takes already-fetched primitives
 *     and returns fully-formatted display fields. Trivially unit-testable, never
 *     throws, tolerates zero/missing data.
 *   - {@link renderStatusCardText} is PURE — emoji lines for Telegram + SPA text.
 *   - {@link collectStatusCard} is the impure glue: it reads runtime state
 *     (per-field try/catch, never throws) and calls the pure assembler.
 *   - {@link setStatusSources}/{@link getStatusSources} let the admin handler
 *     (which has no CommandContext) read the same runtime handles the command
 *     path uses. Wired once at startup in `src/cli.ts`.
 *
 * "No raw SQL" (S6): the cache %, cost and cached/new token split come from the
 * S1 ledger helper {@link computeCacheShare} (see `src/llm/cache-share.ts`).
 * The only ledger read here is one fixed, non-interpolated SELECT (mirrors
 * `readLedgerRows`, adding `tokens_out`) — the /status command handler itself
 * hand-writes no SQL; it calls this telemetry layer.
 */

import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../shared/index.js';
import { computeCacheShare, type LedgerRow } from '../../../llm/cache-share.js';

const log = createLogger('commands:status-card');

// ---------------------------------------------------------------------------
// Structured card — the single source of truth every surface renders from.
// All fields are already formatted for display; numeric companions are kept so
// the admin HTML can lay them out differently from the plain-text lines.
// ---------------------------------------------------------------------------

export interface StatusCardData {
  /** e.g. "SUDO-AI 4.1.7 (46ae1cf)". */
  headline: string;
  version: string;
  commit: string;
  /** e.g. "Sunday, July 19th, 2026 - 5:07 PM (UTC)". */
  currentTime: string;
  /** e.g. "2026-07-19 17:07 UTC". */
  referenceUtc: string;
  /** e.g. "gateway 1m 26s · system 42d 22h". */
  uptime: string;
  gatewayUptime: string;
  systemUptime: string;
  /** e.g. "xai/grok-4.5". */
  model: string;
  /** e.g. "api-key (xai:default)". */
  auth: string;
  /** e.g. "169 in / 549 out". */
  tokens: string;
  tokensIn: number;
  tokensOut: number;
  /** e.g. "$0.0057". */
  cost: string;
  /** e.g. "99% hit · 21k cached, 0 new". */
  cache: string;
  cacheSharePct: number;
  /** e.g. "21k/1.0m (2%)". */
  context: string;
  contextUsed: number;
  contextWindow: number;
  contextPct: number;
  compactions: number;
  /** e.g. "web:abc · duration 6m 26s". */
  session: string;
  sessionKey: string;
  sessionDuration: string;
  /** e.g. "direct". */
  execution: string;
  think: string;
  fast: string;
  /** e.g. "followup (depth 0)". */
  queue: string;
  queueMode: string;
  queueDepth: number;
}

/** Primitive inputs the pure {@link assembleStatusCard} formats. */
export interface RawStatusInputs {
  version: string | null;
  commit: string | null;
  nowMs: number;
  gatewayUptimeS: number;
  systemUptimeS: number;
  model: string | null;
  authKind: string;
  authProfile: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cacheSharePct: number;
  cacheReadTokens: number;
  freshTokens: number;
  contextUsed: number;
  contextWindow: number;
  compactions: number;
  sessionKey: string | null;
  sessionCreatedMs: number | null;
  execMode: string;
  think: string;
  fast: string;
  queueMode: string;
  queueDepth: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure)
// ---------------------------------------------------------------------------

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(num(totalSeconds)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** 169 → "169", 21_000 → "21k", 1_000_000 → "1.0m". */
export function shortTokens(v: number): string {
  const n = Math.max(0, Math.round(num(v)));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const ORDINAL = (d: number): string => {
  const j = d % 10;
  const k = d % 100;
  if (j === 1 && k !== 11) return `${d}st`;
  if (j === 2 && k !== 12) return `${d}nd`;
  if (j === 3 && k !== 13) return `${d}rd`;
  return `${d}th`;
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "Sunday, July 19th, 2026 - 5:07 PM (UTC)" — all UTC, no locale dependence. */
export function formatCurrentTime(nowMs: number): string {
  const d = new Date(num(nowMs));
  const weekday = WEEKDAYS[d.getUTCDay()] ?? '';
  const month = MONTHS[d.getUTCMonth()] ?? '';
  const day = ORDINAL(d.getUTCDate());
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${weekday}, ${month} ${day}, ${d.getUTCFullYear()} - ${h}:${min} ${ampm} (UTC)`;
}

/** "2026-07-19 17:07 UTC". */
export function formatReferenceUtc(nowMs: number): string {
  const iso = new Date(num(nowMs)).toISOString(); // 2026-07-19T17:07:12.345Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// ---------------------------------------------------------------------------
// Pure assembler
// ---------------------------------------------------------------------------

/**
 * Format every field into the structured {@link StatusCardData}. PURE, total:
 * given any inputs (including all-zero / all-null) it returns a complete card
 * and never throws. This is the function the unit tests hammer.
 */
export function assembleStatusCard(raw: RawStatusInputs): StatusCardData {
  const version = raw.version && raw.version.trim() ? raw.version.trim() : 'dev';
  const commit = raw.commit && raw.commit.trim() ? raw.commit.trim().slice(0, 7) : 'unknown';
  const model = raw.model && raw.model.trim() ? raw.model.trim() : 'unknown';

  const provider = raw.authProfile && raw.authProfile.trim()
    ? raw.authProfile.trim()
    : (model.includes('/') ? `${model.split('/')[0]}:default` : 'default');
  const authKind = raw.authKind && raw.authKind.trim() ? raw.authKind.trim() : 'api-key';

  const tokensIn = Math.round(num(raw.tokensIn));
  const tokensOut = Math.round(num(raw.tokensOut));
  const costUsd = num(raw.costUsd);
  const cacheShare = Math.max(0, Math.min(100, num(raw.cacheSharePct)));
  const cacheRead = Math.round(num(raw.cacheReadTokens));
  const fresh = Math.round(num(raw.freshTokens));

  const contextUsed = Math.round(num(raw.contextUsed));
  const contextWindow = Math.max(0, Math.round(num(raw.contextWindow)));
  const contextPct = contextWindow > 0 ? Math.round((contextUsed / contextWindow) * 100) : 0;

  const gatewayUptime = formatUptime(raw.gatewayUptimeS);
  const systemUptime = formatUptime(raw.systemUptimeS);

  const sessionKey = raw.sessionKey && raw.sessionKey.trim() ? raw.sessionKey.trim() : 'none';
  const sessionDuration = raw.sessionCreatedMs != null && Number.isFinite(raw.sessionCreatedMs)
    ? formatUptime(Math.max(0, (num(raw.nowMs) - raw.sessionCreatedMs) / 1000))
    : 'n/a';

  const execMode = raw.execMode && raw.execMode.trim() ? raw.execMode.trim() : 'direct';
  const think = raw.think && raw.think.trim() ? raw.think.trim() : 'default';
  const fast = raw.fast && raw.fast.trim() ? raw.fast.trim() : 'off';
  const queueMode = raw.queueMode && raw.queueMode.trim() ? raw.queueMode.trim() : 'followup';
  const queueDepth = Math.max(0, Math.round(num(raw.queueDepth)));

  return {
    headline: `SUDO-AI ${version} (${commit})`,
    version,
    commit,
    currentTime: formatCurrentTime(raw.nowMs),
    referenceUtc: formatReferenceUtc(raw.nowMs),
    uptime: `gateway ${gatewayUptime} · system ${systemUptime}`,
    gatewayUptime,
    systemUptime,
    model,
    auth: `${authKind} (${provider})`,
    tokens: `${tokensIn} in / ${tokensOut} out`,
    tokensIn,
    tokensOut,
    cost: `$${costUsd.toFixed(4)}`,
    cache: `${cacheShare}% hit · ${shortTokens(cacheRead)} cached, ${shortTokens(fresh)} new`,
    cacheSharePct: cacheShare,
    context: `${shortTokens(contextUsed)}/${shortTokens(contextWindow)} (${contextPct}%)`,
    contextUsed,
    contextWindow,
    contextPct,
    compactions: Math.max(0, Math.round(num(raw.compactions))),
    session: `${sessionKey} · duration ${sessionDuration}`,
    sessionKey,
    sessionDuration,
    execution: execMode,
    think,
    fast,
    queue: `${queueMode} (depth ${queueDepth})`,
    queueMode,
    queueDepth,
  };
}

// ---------------------------------------------------------------------------
// Text renderer (Telegram + web SPA chat) — emoji-labeled like OpenClaw's card
// ---------------------------------------------------------------------------

/** Render the card as an emoji-labeled plain-text block. PURE, never throws. */
export function renderStatusCardText(c: StatusCardData): string {
  return [
    `🎯 ${c.headline}`,
    `Current time: ${c.currentTime}`,
    `Reference UTC: ${c.referenceUtc}`,
    `⏱️ Uptime: ${c.uptime}`,
    `🍪 Model: ${c.model} · 🔑 ${c.auth}`,
    `📊 Tokens: ${c.tokens} · Cost: ${c.cost}`,
    `🗄️ Cache: ${c.cache}`,
    `🧊 Context: ${c.context} · 🧭 Compactions: ${c.compactions}`,
    `🧵 Session: ${c.session}`,
    `⚙️ Execution: ${c.execution} · Think: ${c.think} · Fast: ${c.fast}`,
    `🎚️ Queue: ${c.queue}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Runtime sources — the handles collectStatusCard reads from.
// ---------------------------------------------------------------------------

export interface StatusSources {
  /** AgentLoop instance (duck-typed for brain + sessionManager). */
  agentLoop?: unknown;
  /** SudoConfig (duck-typed for models/auth). */
  config?: unknown;
  /** MindDB handle (`.db` → better-sqlite3) — holds the `sessions` table. */
  mindDb?: unknown;
  /** KeyedAsyncQueue for depth/busy inspection. */
  peerQueue?: unknown;
  /** Absolute path to the gateway ledger db; default `DATA_DIR/gateway.db`. */
  ledgerDbPath?: string;
  /** Active session id (command path); admin may omit. */
  sessionId?: string;
  /** Channel + peer for queue-busy detection (command path). */
  channel?: string;
  peerId?: string;
}

let registeredSources: StatusSources | null = null;

/** Register the runtime handles once at startup (see `src/cli.ts`). */
export function setStatusSources(sources: StatusSources): void {
  registeredSources = sources;
}

/** Read the registered handles (admin handler path). Null until wired. */
export function getStatusSources(): StatusSources | null {
  return registeredSources;
}

// ---------------------------------------------------------------------------
// Impure collection — reads runtime state, never throws.
// ---------------------------------------------------------------------------

interface LedgerAgg {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cacheSharePct: number;
  cacheReadTokens: number;
  freshTokens: number;
}

/**
 * Read the last {@link limit} ledger rows and derive token/cost/cache metrics.
 * One fixed, parameter-only SELECT (no interpolation) + the S1 helper
 * {@link computeCacheShare}. Fail-open: any error → all-zero.
 */
async function readLedgerAgg(dbPath: string, limit = 50): Promise<LedgerAgg> {
  const zero: LedgerAgg = {
    tokensIn: 0, tokensOut: 0, costUsd: 0, cacheSharePct: 0, cacheReadTokens: 0, freshTokens: 0,
  };
  interface RoStatement { all(p: unknown): unknown[]; }
  interface RoDatabase { close(): void; prepare(sql: string): RoStatement; }
  let handle: RoDatabase | null = null;
  try {
    // Dynamic import (ESM-safe; keeps better-sqlite3 off the import-time path).
    const mod = await import('better-sqlite3');
    const Database = (mod.default ?? mod) as unknown as new (p: string, o?: object) => RoDatabase;
    handle = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = handle
      .prepare(
        `SELECT tokens_in, tokens_out, tokens_cached, latency_ms, cost_usd
           FROM llm_calls
          ORDER BY ts DESC
          LIMIT :limit`,
      )
      .all({ limit: Math.max(1, Math.floor(limit)) }) as Array<{
      tokens_in: number | null;
      tokens_out: number | null;
      tokens_cached: number | null;
      latency_ms: number | null;
      cost_usd: number | null;
    }>;
    const ledgerRows: LedgerRow[] = rows.map((r) => ({
      tokensIn: r.tokens_in,
      tokensCached: r.tokens_cached,
      latencyMs: r.latency_ms,
      costUsd: r.cost_usd,
    }));
    const share = computeCacheShare(ledgerRows);
    const tokensOut = rows.reduce((s, r) => s + num(r.tokens_out), 0);
    return {
      tokensIn: share.cacheReadTokens + share.freshInputTokens,
      tokensOut,
      costUsd: share.costUsd,
      cacheSharePct: share.cacheReadSharePct,
      cacheReadTokens: share.cacheReadTokens,
      freshTokens: share.freshInputTokens,
    };
  } catch (err) {
    log.debug({ err: String(err) }, 'ledger read failed — reporting zero token/cost metrics');
    return zero;
  } finally {
    try { handle?.close(); } catch { /* ignore */ }
  }
}

/** Count the compaction chain length by walking `parent_session_id` (capped). */
function countCompactions(mindDb: unknown, sessionId: string | undefined): number {
  if (!sessionId) return 0;
  const raw = (mindDb as { db?: { prepare(sql: string): { get(p: unknown): unknown } } } | null)?.db;
  if (!raw) return 0;
  try {
    const stmt = raw.prepare('SELECT parent_session_id AS p FROM sessions WHERE session_id = :id');
    let id: string | null = sessionId;
    let count = 0;
    for (let i = 0; i < 100 && id; i++) {
      const row = stmt.get({ id }) as { p: string | null } | undefined;
      const parent = row?.p ?? null;
      if (!parent) break;
      count++;
      id = parent;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Gather runtime state and build the card. Never throws — every read is
 * defensive so a partially-initialised runtime still yields a complete card.
 */
export async function collectStatusCard(sources: StatusSources = {}): Promise<StatusCardData> {
  const nowMs = Date.now();

  // Version + commit (async, disk + git; each fails to null independently).
  let version: string | null = null;
  let commit: string | null = null;
  try {
    const helpers = await import('../../health/error-reporter-helpers.js');
    version = await helpers.getVersion();
    commit = await helpers.getCommitSha();
  } catch { /* keep nulls */ }

  // Model + auth.
  const brain = (sources.agentLoop as { brain?: { getModel?: () => string; currentModel?: string; getStrategy?: () => string } } | null)?.brain;
  let model: string | null = null;
  try { model = brain?.getModel?.() ?? brain?.currentModel ?? null; } catch { model = null; }
  const provider = model && model.includes('/') ? model.split('/')[0]! : (model ?? '');
  const authKind = provider.endsWith('-oauth') ? 'oauth' : 'api-key';
  const authProfile = provider ? `${provider.replace(/-oauth$/, '')}:default` : null;

  // Ledger: tokens / cost / cache.
  let ledgerPath = sources.ledgerDbPath;
  if (!ledgerPath) {
    try {
      const { DATA_DIR } = await import('../../shared/paths.js');
      ledgerPath = path.join(DATA_DIR, 'gateway.db');
    } catch { ledgerPath = undefined; }
  }
  const ledger = ledgerPath ? await readLedgerAgg(ledgerPath) : {
    tokensIn: 0, tokensOut: 0, costUsd: 0, cacheSharePct: 0, cacheReadTokens: 0, freshTokens: 0,
  };

  // Context fill + session timing (from the in-memory session).
  let contextUsed = 0;
  let contextWindow = 0;
  let sessionCreatedMs: number | null = null;
  const sessionKey = sources.sessionId ?? null;
  try {
    const mgr = (sources.agentLoop as { sessionManager?: { get?: (id: string) => Promise<unknown> } } | null)?.sessionManager;
    if (mgr?.get && sources.sessionId) {
      const session = await mgr.get(sources.sessionId) as {
        messages?: Array<{ content?: unknown }>;
        createdAt?: Date | string | number;
      } | null;
      if (session) {
        if (Array.isArray(session.messages)) {
          const { estimateContextSize } = await import('../../agent/context.js');
          contextUsed = estimateContextSize(session.messages as Array<{ content: string }>);
        }
        if (session.createdAt != null) {
          const t = new Date(session.createdAt as string | number | Date).getTime();
          if (Number.isFinite(t)) sessionCreatedMs = t;
        }
      }
    }
  } catch { /* keep defaults */ }
  try {
    if (model) {
      const { getAliasLimits } = await import('../../../llm/limits.js');
      contextWindow = getAliasLimits(model).context_window;
    }
  } catch { contextWindow = 0; }

  // Compactions.
  const compactions = countCompactions(sources.mindDb, sources.sessionId);

  // Execution mode / think / fast.
  let execMode = 'direct';
  try {
    const strat = brain?.getStrategy?.();
    if (strat && strat !== 'single') execMode = strat;
  } catch { /* direct */ }
  const think = (process.env['SUDO_REASONING_DEFAULT'] ?? '').trim() || 'default';
  const fast = 'off';

  // Queue mode + depth.
  let queueMode = 'followup';
  try {
    const { globalDefaultMode } = await import('../../channels/queue-modes.js');
    queueMode = globalDefaultMode();
  } catch { /* followup */ }
  let queueDepth = 0;
  try {
    const q = sources.peerQueue as { pendingKeys?: string[]; size?: number } | null;
    if (q && Array.isArray(q.pendingKeys)) {
      if (sources.peerId) {
        const busy = q.pendingKeys.includes(sources.peerId) ||
          q.pendingKeys.includes(`${sources.channel}:${sources.peerId}`);
        queueDepth = busy ? 1 : 0;
      } else {
        queueDepth = num(q.size);
      }
    }
  } catch { queueDepth = 0; }

  return assembleStatusCard({
    version,
    commit,
    nowMs,
    gatewayUptimeS: safeUptime(() => process.uptime()),
    systemUptimeS: safeUptime(() => os.uptime()),
    model,
    authKind,
    authProfile,
    tokensIn: ledger.tokensIn,
    tokensOut: ledger.tokensOut,
    costUsd: ledger.costUsd,
    cacheSharePct: ledger.cacheSharePct,
    cacheReadTokens: ledger.cacheReadTokens,
    freshTokens: ledger.freshTokens,
    contextUsed,
    contextWindow,
    compactions,
    sessionKey,
    sessionCreatedMs,
    execMode,
    think,
    fast,
    queueMode,
    queueDepth,
  });
}

function safeUptime(fn: () => number): number {
  try { return num(fn()); } catch { return 0; }
}
