/**
 * @file grok-statsig-drift-canary.ts
 * @description Early-warning detector for grok.com statsig-algorithm drift.
 *
 * The pure-Node minter (grok-statsig-mint.ts) reproduces grok's anti-bot
 * fingerprint algorithm. grok changes that algorithm from time to time (it did
 * on 2026-07-25: segment byte 41→21, currentTime bytes 19/29/36→4/14/7). When
 * that happens, pure-Node tokens silently start failing the anti-bot gate (403)
 * and the connector quietly falls back / fails over — losing the free lane with
 * no signal. This canary turns that into an explicit alert.
 *
 * The check is empirical and unambiguous:
 *   1. mint a PURE-NODE token, probe the anti-bot gate.
 *        gate 200 (or past-gate) → HEALTHY (algorithm current).
 *   2. if the pure-Node token is anti-bot-REJECTED (403/statsig):
 *        mint an ORACLE (real in-page) token, probe the gate.
 *          oracle passes + pure-Node rejected → ALGORITHM_DRIFT (browser mints
 *            correctly, our reproduction does not) → re-run the scope-walk
 *            recovery (docs/STATSIG_RERE_2026-07-25.md).
 *          both rejected → SESSION_ISSUE (cookie/cf_clearance/Cloudflare), not drift.
 *
 * Fully dependency-injected so it is unit-testable without a browser or network.
 * The runnable cron entry is scripts/grok-web/statsig_drift_canary.mjs.
 */

import { createLogger } from './grok-runtime.js';

const log = createLogger('llm:grok-statsig-canary');

export type DriftStatus = 'healthy' | 'algorithm_drift' | 'session_issue' | 'error';

export interface DriftResult {
  status: DriftStatus;
  detail: string;
  pureNodeGate?: number;
  oracleGate?: number;
}

/** Outcome of probing the anti-bot gate with a given statsig token. */
export interface GateProbe {
  /** True when the token passed anti-bot (200, or a past-gate validation error). */
  passed: boolean;
  status?: number;
  /** 'statsig' when the failure was the anti-bot rejection specifically. */
  errorClass?: string;
}

export interface DriftCanaryDeps {
  /** Mint a token with the pure-Node algorithm (seed → mintStatsigFromSeed). */
  mintPureNode: () => Promise<string>;
  /** Mint a token via the real in-page oracle (ground truth). */
  mintOracle: () => Promise<string>;
  /** Probe the anti-bot gate with a token. */
  probeGate: (statsigId: string) => Promise<GateProbe>;
}

/**
 * Run one drift check. Never throws for the expected failure modes — returns a
 * classified DriftResult; only truly unexpected errors surface as status 'error'.
 */
export async function checkStatsigDrift(deps: DriftCanaryDeps): Promise<DriftResult> {
  try {
    const pnToken = await deps.mintPureNode();
    const pn = await deps.probeGate(pnToken);
    if (pn.passed) {
      return { status: 'healthy', detail: 'pure-Node token passed the anti-bot gate', pureNodeGate: pn.status };
    }
    // Pure-Node token failed. Only an anti-bot (statsig) rejection points at drift.
    if (pn.errorClass !== 'statsig' && pn.status !== 403) {
      return {
        status: 'session_issue',
        detail: `pure-Node probe failed non-anti-bot (${pn.errorClass ?? pn.status}) — not algorithm drift`,
        pureNodeGate: pn.status,
      };
    }
    // Disambiguate: does the REAL in-page minter still pass?
    const orcToken = await deps.mintOracle();
    const orc = await deps.probeGate(orcToken);
    if (orc.passed) {
      const detail =
        'ALGORITHM DRIFT: oracle token passes but pure-Node token is anti-bot-rejected. ' +
        'grok changed the statsig algorithm — re-run the scope-walk recovery (docs/STATSIG_RERE_2026-07-25.md).';
      log.error({ pureNodeGate: pn.status, oracleGate: orc.status }, detail);
      return { status: 'algorithm_drift', detail, pureNodeGate: pn.status, oracleGate: orc.status };
    }
    return {
      status: 'session_issue',
      detail: 'both pure-Node and oracle tokens rejected — session/cloudflare issue, not algorithm drift',
      pureNodeGate: pn.status,
      oracleGate: orc.status,
    };
  } catch (err) {
    return { status: 'error', detail: `drift check errored: ${(err as Error).message}` };
  }
}

/**
 * Run the canary with the real production wiring.
 *
 * The deps above are injected so the logic stays unit-testable; this assembles
 * the live versions so callers (the watchdog, the CLI script) do not each
 * re-derive them and drift apart.
 *
 * COST: `probeGate` sends a real one-character chat turn, so a run consumes TWO
 * of the ~40 free grok-4 calls in the rolling 2h window (one pure-Node probe,
 * one oracle probe). No money — the cookie lane is subscription-covered — but
 * not free of quota, which is why the watchdog runs this at most once a day
 * rather than on its 60s tick.
 */
export async function runStatsigDriftCanary(): Promise<DriftResult> {
  const REQ_PATH = '/rest/app-chat/conversations/new';
  const [{ mintStatsigFromSeed }, { callGrokWebBridge }, { getGrokWebSessionManager }, { getGrokStatsigOracle }] =
    await Promise.all([
      import('./grok-statsig-mint.js'),
      import('./grok-web-bridge.js'),
      import('./grok-web-session-manager.js'),
      import('./grok-statsig-oracle.js'),
    ]);

  const session = await getGrokWebSessionManager().ensureHealthy();
  const creds = { cookie: session.cookie, userAgent: session.userAgent };

  return checkStatsigDrift({
    mintPureNode: async () => {
      const s = await callGrokWebBridge({ op: 'seed' }, creds);
      if (!s.ok || !s.seed) throw new Error(`seed fetch failed: ${s.errorClass ?? 'no seed'}`);
      return mintStatsigFromSeed(s.seed, REQ_PATH, 'POST', Date.now());
    },
    mintOracle: () =>
      getGrokStatsigOracle({ cdpUrl: process.env['SUDO_GROK_ORACLE_CDP_URL'] ?? undefined }).mint(REQ_PATH, 'POST'),
    probeGate: async (statsigId: string) => {
      const r = await callGrokWebBridge(
        { op: 'chat', message: '.', modelName: 'grok-4', temporary: true, disableSearch: true, timeoutSec: 30 },
        { ...creds, statsigId },
      );
      return {
        passed: r.ok === true,
        ...(r.status !== undefined ? { status: r.status } : {}),
        ...(r.errorClass ? { errorClass: r.errorClass } : {}),
      };
    },
  });
}
