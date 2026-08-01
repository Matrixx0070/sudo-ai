/**
 * @file grok-seat.ts
 * @description GrokSeat — the single entry point to the $30 Grok subscription seat
 * (ADR 0008). A FAÇADE, not a subsystem: it owns login, health, and the recovery
 * policy, and delegates every capability to the existing `grok-*` modules.
 *
 * Why this exists: the seat's ~17 capabilities were already built across 30+
 * modules, but nothing composed them and nothing could answer "is the seat
 * healthy?". Five separate outages in one week were all SILENT — an OAuth token
 * dead for 6 days, a statsig algorithm drift, an absent warm browser, an env var
 * that never reached the process, and a revoked free model that quietly turned a
 * free lane metered. Each was individually cheap to detect and none was detected.
 *
 * DESIGN RULE (enforced by review, see ADR 0008): this file adds NO capability
 * logic. If a method here starts doing more than compose/observe/delegate, the
 * logic belongs in the capability module instead.
 *
 * THE SEAT HAS TWO INDEPENDENT AUTH LANES. That duality is real (xAI runs two
 * different auth systems) and is deliberately made explicit rather than hidden:
 *  - COOKIE lane (`data/grok-web-session.json`) — grok.com /rest/*: chat, image,
 *    video, voice, RAG, files, memory, automations, skills, workspaces.
 *    Subscription-covered, $0, rate-limited rather than billed.
 *  - OAUTH lane (`data/xai-oauth.json`) — cli-chat-proxy: run-code, native
 *    function-calling. **METERED as of 2026-07-31** (the free build model was
 *    revoked); see project-xai-free-lane-revoked.
 *
 * Health checks NEVER spend money: only cookie-lane, statsig-free, $0 endpoints
 * are probed live, and the OAuth lane is inspected OFFLINE (JWT decode) — never
 * by issuing a generation call.
 */

import { createLogger } from './grok-runtime.js';
import { getGrokWebSessionManager, type GrokWebStatus } from './grok-web-session-manager.js';
import { getXaiOAuthManager, type XaiOAuthStatus } from './xai-oauth-manager.js';
import { isGrokBrowserlessActive } from './grok-statsig-pool.js';

const log = createLogger('llm:grok-seat');

/** Verdict for one checked component. `degraded` = works, but not on the fast path. */
export type SeatHealth = 'ok' | 'degraded' | 'down' | 'unknown';

export interface SeatCheck {
  name: string;
  health: SeatHealth;
  /** What was observed — facts, not advice. */
  detail: string;
  /** The exact operator action when not ok. Empty when healthy. */
  remedy?: string;
}

export interface SeatStatus {
  /** Worst health across all checks — what a caller should branch on. */
  overall: SeatHealth;
  cookieLane: GrokWebStatus;
  oauthLane: XaiOAuthStatus;
  checks: SeatCheck[];
  /** True when a HUMAN must re-login; no automatic recovery can fix it. */
  needsLogin: boolean;
}

const RANK: Record<SeatHealth, number> = { ok: 0, degraded: 1, unknown: 2, down: 3 };

function worst(checks: SeatCheck[]): SeatHealth {
  return checks.reduce<SeatHealth>((acc, c) => (RANK[c.health] > RANK[acc] ? c.health : acc), 'ok');
}

/** Decode a JWT payload without verifying — we only read our own token's claims. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface SeatDeps {
  /** Injected in tests; defaults to a real cookie-lane fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The seat façade. Construct via {@link getGrokSeat} so both lanes share one
 * instance (and therefore one refresh/demote state) process-wide.
 */
export class GrokSeat {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  public constructor(deps: SeatDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * OFFLINE snapshot — no network, safe to call on every request/boot. Answers
   * "do we hold credentials, and does a human need to act?" It deliberately does
   * NOT prove the credentials still work; use {@link doctor} for that.
   */
  public status(): SeatStatus {
    const cookieLane = getGrokWebSessionManager().status();
    const oauthLane = getXaiOAuthManager().status();
    const checks: SeatCheck[] = [
      this.checkCookieCreds(cookieLane),
      this.checkOAuthCreds(oauthLane),
      this.checkStatsigPath(),
    ];
    return {
      overall: worst(checks),
      cookieLane,
      oauthLane,
      checks,
      needsLogin: cookieLane.needsRelogin === true || oauthLane.needsRelogin === true,
    };
  }

  /**
   * LIVE health check. Proves the cookie lane actually authenticates and reports
   * remaining free quota, then folds in the offline checks.
   *
   * Costs $0: `/rest/subscriptions` and `/rest/rate-limits` are cookie-only and
   * statsig-free. The metered OAuth lane is NEVER exercised — a health check that
   * spends money is a bug, and this seat has already produced one $161 surprise.
   */
  public async doctor(): Promise<SeatStatus> {
    const base = this.status();
    const live = await this.probeCookieLane();
    const checks = [...base.checks, ...live];
    return { ...base, checks, overall: worst(checks) };
  }

  private checkCookieCreds(s: GrokWebStatus): SeatCheck {
    if (s.needsRelogin === true) {
      return {
        name: 'cookie-credentials',
        health: 'down',
        detail: 'grok.com sso cookie is dead',
        remedy: 'Re-run the one-time web-session login (`sudo-ai grok websession setup`).',
      };
    }
    if (!s.connected) {
      return {
        name: 'cookie-credentials',
        health: 'down',
        detail: 'no grok.com session stored',
        remedy: 'Run the one-time web-session login to capture cookies.',
      };
    }
    const ageDays = s.capturedAt
      ? Math.floor((this.now() - Date.parse(s.capturedAt)) / 86_400_000)
      : undefined;
    return {
      name: 'cookie-credentials',
      health: 'ok',
      detail: `session stored${ageDays === undefined ? '' : `, captured ${ageDays}d ago`}`,
    };
  }

  private checkOAuthCreds(s: XaiOAuthStatus): SeatCheck {
    if (s.needsRelogin === true || !s.connected) {
      return {
        name: 'oauth-credentials',
        health: 'down',
        detail: s.needsRelogin === true ? 'refresh token rejected' : 'not connected',
        // Personal vs Team is a REAL fork: both meter today, but the consent tab
        // determines which principal (and therefore which invoice) is used.
        remedy: 'Run `sudo-ai xai-oauth login` and pick the intended principal on the consent screen.',
      };
    }
    const expMs = s.expiresAt ? Date.parse(s.expiresAt) : NaN;
    if (Number.isFinite(expMs) && expMs <= this.now()) {
      return {
        name: 'oauth-credentials',
        health: 'degraded',
        detail: `access token expired at ${s.expiresAt} (refresh on next use)`,
      };
    }
    return { name: 'oauth-credentials', health: 'ok', detail: `token valid until ${s.expiresAt ?? 'unknown'}` };
  }

  /**
   * Which statsig minting path is live. The pure-Node fast path is ~instant; the
   * browser oracle is ~30s and needs a headed browser. Reporting `degraded` for
   * the oracle is not pedantry — it is the difference between a 30s turn and a
   * failed one, and it went unnoticed for days.
   */
  private checkStatsigPath(): SeatCheck {
    const flag = process.env['SUDO_GROK_STATSIG_BROWSERLESS'];
    if (flag !== '1') {
      return {
        name: 'statsig-minting',
        health: 'degraded',
        detail: 'browserless fast path OFF — minting via the browser oracle (~30s/call)',
        remedy:
          'Expected while the pure-Node algorithm is drifted. Re-derive it (docs/STATSIG_RERE_2026-07-25.md), ' +
          'confirm with the drift canary, then set SUDO_GROK_STATSIG_BROWSERLESS=1.',
      };
    }
    return isGrokBrowserlessActive()
      ? { name: 'statsig-minting', health: 'ok', detail: 'browserless fast path active' }
      : {
          name: 'statsig-minting',
          health: 'degraded',
          detail: 'browserless demoted after an anti-bot rejection — using the oracle until cooldown',
          remedy: 'Run scripts/grok-web/statsig_drift_canary.mts to confirm whether the algorithm drifted.',
        };
  }

  /**
   * Live cookie-lane probe. Both endpoints are statsig-free and $0.
   * Never throws — a doctor that dies tells you nothing.
   */
  private async probeCookieLane(): Promise<SeatCheck[]> {
    const session = getGrokWebSessionManager().loadSession();
    if (!session) {
      return [{ name: 'cookie-lane-live', health: 'down', detail: 'no session to probe' }];
    }
    const headers = {
      'User-Agent': session.userAgent,
      Cookie: session.cookie,
      Origin: 'https://grok.com',
      Referer: 'https://grok.com/',
      'Content-Type': 'application/json',
    };
    const out: SeatCheck[] = [];
    try {
      const r = await this.fetchImpl('https://grok.com/rest/subscriptions', { headers });
      out.push(
        r.ok
          ? { name: 'cookie-lane-live', health: 'ok', detail: `seat authenticates (HTTP ${r.status})` }
          : {
              name: 'cookie-lane-live',
              health: 'down',
              detail: `seat rejected the session (HTTP ${r.status})`,
              remedy: 'Re-run the one-time web-session login.',
            },
      );
    } catch (err) {
      out.push({
        name: 'cookie-lane-live',
        health: 'unknown',
        detail: `probe failed: ${(err as Error).message}`,
      });
      return out; // network is down; the quota probe would only repeat the same error
    }

    try {
      const r = await this.fetchImpl('https://grok.com/rest/rate-limits', {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestKind: 'DEFAULT', modelName: 'grok-4' }),
      });
      const body = (await r.json()) as { remainingQueries?: number; totalQueries?: number };
      const left = body.remainingQueries;
      const total = body.totalQueries;
      out.push(
        left === 0
          ? {
              name: 'free-quota',
              health: 'degraded',
              detail: `grok-4 free quota exhausted (0/${total ?? '?'}) — resets within the 2h window`,
            }
          : { name: 'free-quota', health: 'ok', detail: `grok-4 ${left ?? '?'}/${total ?? '?'} free calls left` },
      );
    } catch (err) {
      out.push({ name: 'free-quota', health: 'unknown', detail: `quota probe failed: ${(err as Error).message}` });
    }
    return out;
  }
}

let singleton: GrokSeat | null = null;

/** Process-wide seat façade, so both lanes share one refresh/demote state. */
export function getGrokSeat(): GrokSeat {
  singleton ??= new GrokSeat();
  return singleton;
}

/** Test hook — drop the shared instance. */
export function __resetGrokSeat(): void {
  singleton = null;
}

/** One-line summary for logs/CLI: `ok | 6 checks | grok-4 40/40 free calls left`. */
export function formatSeatStatus(s: SeatStatus): string {
  const failing = s.checks.filter((c) => c.health !== 'ok');
  const head = `${s.overall} | ${s.checks.length} checks`;
  if (failing.length === 0) return `${head} | all healthy`;
  return `${head} | ${failing.map((c) => `${c.name}=${c.health}`).join(', ')}`;
}

export { log as __grokSeatLog };
