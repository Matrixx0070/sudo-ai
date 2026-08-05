/**
 * @file xai-billing.ts
 * @description xAI Management API billing reader + spend guard.
 *
 * Closes the long-standing "money guard" gap for the xAI lane: the standing rule
 * has been *"never put xai-oauth on the brain chain without checking console.x.ai
 * first"*, after cli-chat-proxy once billed ~$80/day. That check has been a human
 * eyeballing a web console. This makes it programmatic.
 *
 * It also complements roadmap B6: `cost-tracker.checkBudget()` computes a budget
 * verdict that **nothing calls**, and it only knows about spend this process
 * recorded. This module reads the *authoritative* number from the vendor, which
 * includes spend from every other client on the same team.
 *
 * ## Why the REST Management API and not the console's gRPC
 *
 * console.x.ai's billing RPCs (`prod_mc_billing.UISvc/*`) are `grpc-web+proto`,
 * cookie-authenticated and undocumented — replaying them would be brittle and
 * would break the moment the console ships a new build. xAI documents a REST
 * Management API that exposes the same data. Endpoint paths below are **verified
 * live** (they return 401 with a management key requirement, not 404).
 *
 * ## UNVERIFIED — response field names
 *
 * This project holds no management key, so the *shapes* of the JSON responses
 * could not be exercised. Field extraction is therefore deliberately defensive:
 * several plausible names are tried, and anything unparseable is treated as a
 * failure to verify rather than as zero spend. A money guard that reads an
 * unknown response as "$0 spent" is worse than no guard.
 *
 * Environment:
 *   XAI_MANAGEMENT_KEY  — management key (xAI Console → Settings → Management Keys).
 *                         NOT the same as XAI_API_KEY. Absent ⇒ guard inactive.
 *   XAI_TEAM_ID         — team uuid the key belongs to.
 *   SUDO_XAI_SPEND_CAP_USD — optional operator cap for the current billing period.
 */

// Host services come through the extraction seam, never `../core/**` directly —
// these modules are destined for a standalone package (grok-extraction-boundary).
import { createLogger } from './grok-runtime.js';

const log = createLogger('xai-billing');

const DEFAULT_BASE_URL = 'https://management-api.x.ai';

/** `allow` may spend · `block` must not · `inactive` guard not configured. */
export type SpendVerdict = 'allow' | 'block' | 'inactive';

export interface XaiBillingConfig {
  managementKey?: string;
  teamId?: string;
  baseUrl: string;
  /** Operator cap on the current period's postpaid amount, in USD. */
  capUsd?: number;
}

export interface SpendStatus {
  verdict: SpendVerdict;
  /** Amount owed for the current postpaid billing period, USD. Null if unread. */
  postpaidDueUsd: number | null;
  /** Remaining prepaid credit, USD. Null if unread. */
  prepaidBalanceUsd: number | null;
  softLimitUsd: number | null;
  hardLimitUsd: number | null;
  capUsd: number | null;
  /** Human-readable justification. Always populated. */
  reason: string;
}

export interface XaiBillingDeps {
  fetch: typeof globalThis.fetch;
}

export class XaiSpendBlockedError extends Error {
  constructor(readonly status: SpendStatus) {
    super(`xAI spend guard blocked: ${status.reason}`);
    this.name = 'XaiSpendBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function readBillingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): XaiBillingConfig {
  const rawCap = env['SUDO_XAI_SPEND_CAP_USD']?.trim();
  const cap = rawCap ? Number(rawCap) : NaN;
  return {
    managementKey: env['XAI_MANAGEMENT_KEY']?.trim() || undefined,
    teamId: env['XAI_TEAM_ID']?.trim() || undefined,
    baseUrl: env['XAI_MANAGEMENT_BASE_URL']?.trim() || DEFAULT_BASE_URL,
    ...(Number.isFinite(cap) && cap >= 0 ? { capUsd: cap } : {}),
  };
}

export function isGuardConfigured(cfg: XaiBillingConfig): boolean {
  return Boolean(cfg.managementKey && cfg.teamId);
}

// ---------------------------------------------------------------------------
// Defensive numeric extraction
// ---------------------------------------------------------------------------

/**
 * Pull a USD amount out of an unknown response shape.
 *
 * Tries each candidate key path in order. Also understands the two encodings xAI
 * is known to use elsewhere: a plain number, and integer "ticks" where
 * 1 tick = 1e-10 USD (proven against `cost_in_usd_ticks` on /v1/responses).
 *
 * Returns null when nothing usable is found — never 0, because "no spend found"
 * and "spend is zero" must not be confused by a guard.
 */
export function extractUsd(body: unknown, keys: readonly string[]): number | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;

  for (const key of keys) {
    const v = key.split('.').reduce<unknown>(
      (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
      obj,
    );
    if (typeof v === 'number' && Number.isFinite(v)) {
      return key.endsWith('_ticks') ? v / 1e10 : v;
    }
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return key.endsWith('_ticks') ? Number(v) / 1e10 : Number(v);
    }
  }
  return null;
}

const DUE_KEYS = [
  'amount_due_usd', 'amount_usd', 'total_usd', 'amount',
  'amount_due', 'total', 'invoice.amount_usd', 'preview.amount_usd',
  'amount_due_usd_ticks', 'amount_usd_ticks',
] as const;

const BALANCE_KEYS = [
  'balance_usd', 'balance', 'prepaid_balance_usd', 'credit_balance_usd',
  'balance_usd_ticks', 'balance_ticks',
] as const;

const SOFT_KEYS = ['soft_limit_usd', 'soft_limit', 'monthly_soft_limit_usd'] as const;
const HARD_KEYS = ['hard_limit_usd', 'hard_limit', 'monthly_hard_limit_usd'] as const;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function getJson(
  cfg: XaiBillingConfig,
  path: string,
  deps: XaiBillingDeps,
): Promise<{ ok: true; body: unknown } | { ok: false; detail: string }> {
  const url = `${cfg.baseUrl}/v1/billing/teams/${encodeURIComponent(cfg.teamId!)}/${path}`;
  try {
    const res = await deps.fetch(url, {
      headers: { Authorization: `Bearer ${cfg.managementKey!}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // Never echo the response body wholesale — billing payloads carry PII.
      return { ok: false, detail: `HTTP ${res.status} on ${path}` };
    }
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function getPostpaidPreview(cfg: XaiBillingConfig, deps: XaiBillingDeps) {
  return getJson(cfg, 'postpaid/invoice/preview', deps);
}
export async function getSpendingLimits(cfg: XaiBillingConfig, deps: XaiBillingDeps) {
  return getJson(cfg, 'postpaid/spending-limits', deps);
}
export async function getPrepaidBalance(cfg: XaiBillingConfig, deps: XaiBillingDeps) {
  return getJson(cfg, 'prepaid/balance', deps);
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

const defaultDeps: XaiBillingDeps = { fetch: (...a) => globalThis.fetch(...a) };

/**
 * Read authoritative spend and return a verdict.
 *
 * Semantics, chosen deliberately:
 *  - **Not configured ⇒ `inactive`.** It must not break the lanes that work
 *    today just because nobody has minted a management key yet.
 *  - **Configured but unreadable ⇒ `block`.** This is the whole point. A guard
 *    that silently degrades to "allow" on an API error is the failure mode
 *    `cost-tracker.checkBudget()` already has; it will not be repeated here.
 *  - **Over the operator cap or over xAI's own hard limit ⇒ `block`.**
 *
 * Never throws.
 */
export async function getSpendStatus(
  cfg: XaiBillingConfig = readBillingConfigFromEnv(),
  deps: XaiBillingDeps = defaultDeps,
): Promise<SpendStatus> {
  const base: SpendStatus = {
    verdict: 'inactive',
    postpaidDueUsd: null,
    prepaidBalanceUsd: null,
    softLimitUsd: null,
    hardLimitUsd: null,
    capUsd: cfg.capUsd ?? null,
    reason: '',
  };

  if (!isGuardConfigured(cfg)) {
    return {
      ...base,
      reason:
        'xAI spend guard inactive — set XAI_MANAGEMENT_KEY (Console → Settings → Management Keys) ' +
        'and XAI_TEAM_ID to enable. Spend is NOT being verified.',
    };
  }

  const [preview, limits, prepaid] = await Promise.all([
    getPostpaidPreview(cfg, deps),
    getSpendingLimits(cfg, deps),
    getPrepaidBalance(cfg, deps),
  ]);

  if (!preview.ok) {
    return {
      ...base,
      verdict: 'block',
      reason: `Spend unverifiable (${preview.detail}) — failing closed rather than assuming $0.`,
    };
  }

  const postpaidDueUsd = extractUsd(preview.body, DUE_KEYS);
  const prepaidBalanceUsd = prepaid.ok ? extractUsd(prepaid.body, BALANCE_KEYS) : null;
  const softLimitUsd = limits.ok ? extractUsd(limits.body, SOFT_KEYS) : null;
  const hardLimitUsd = limits.ok ? extractUsd(limits.body, HARD_KEYS) : null;

  const status: SpendStatus = {
    ...base,
    postpaidDueUsd,
    prepaidBalanceUsd,
    softLimitUsd,
    hardLimitUsd,
  };

  if (postpaidDueUsd === null) {
    return {
      ...status,
      verdict: 'block',
      reason:
        'Could not read an amount from the postpaid preview response — the field names are ' +
        'UNVERIFIED against a live management key. Failing closed rather than reading an ' +
        'unrecognised response as zero spend.',
    };
  }

  if (cfg.capUsd !== undefined && postpaidDueUsd >= cfg.capUsd) {
    return {
      ...status,
      verdict: 'block',
      reason: `Postpaid due $${postpaidDueUsd.toFixed(2)} has reached the operator cap ` +
        `$${cfg.capUsd.toFixed(2)} (SUDO_XAI_SPEND_CAP_USD).`,
    };
  }

  if (hardLimitUsd !== null && postpaidDueUsd >= hardLimitUsd) {
    return {
      ...status,
      verdict: 'block',
      reason: `Postpaid due $${postpaidDueUsd.toFixed(2)} has reached xAI's hard limit ` +
        `$${hardLimitUsd.toFixed(2)}.`,
    };
  }

  const headroom = cfg.capUsd !== undefined ? cfg.capUsd - postpaidDueUsd : null;
  return {
    ...status,
    verdict: 'allow',
    reason: `Postpaid due $${postpaidDueUsd.toFixed(2)}` +
      (headroom !== null ? `, $${headroom.toFixed(2)} under the operator cap.` : '.'),
  };
}

// ---------------------------------------------------------------------------
// Cached read — this sits on an LLM call path, so it must not add an HTTP
// round-trip per request. A short TTL keeps it authoritative enough for a
// spend cap (which moves in cents per call) while costing ~nothing.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 120_000;
let cached: { at: number; status: SpendStatus } | null = null;

/** Test seam — drop the memoised verdict. */
export function __resetSpendCache(): void {
  cached = null;
}

/**
 * {@link getSpendStatus} memoised for {@link CACHE_TTL_MS}.
 *
 * A `block` verdict is cached too: if billing is unreadable, re-hammering the
 * API once per LLM call would turn an outage into a stampede.
 */
export async function getSpendStatusCached(
  cfg: XaiBillingConfig = readBillingConfigFromEnv(),
  deps: XaiBillingDeps = defaultDeps,
  now: () => number = Date.now,
): Promise<SpendStatus> {
  const t = now();
  if (cached && t - cached.at < CACHE_TTL_MS) return cached.status;
  const status = await getSpendStatus(cfg, deps);
  cached = { at: t, status };
  return status;
}

/**
 * Guard entry point for spend-incurring paths.
 *
 * @throws {XaiSpendBlockedError} when the verdict is `block`.
 */
export async function assertXaiSpendAllowed(
  cfg: XaiBillingConfig = readBillingConfigFromEnv(),
  deps: XaiBillingDeps = defaultDeps,
): Promise<SpendStatus> {
  const status = await getSpendStatusCached(cfg, deps);
  if (status.verdict === 'block') {
    log.error({ reason: status.reason }, 'xAI spend guard BLOCKED a spend-incurring call');
    throw new XaiSpendBlockedError(status);
  }
  if (status.verdict === 'inactive') {
    log.warn({ reason: status.reason }, 'xAI spend guard inactive');
  }
  return status;
}
