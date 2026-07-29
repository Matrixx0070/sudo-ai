/**
 * Statsig algorithm-drift canary — cron entry.
 *
 *   npx tsx scripts/grok-web/statsig_drift_canary.mts
 *   # exit 0 = healthy, 2 = ALGORITHM DRIFT (re-run scope-walk recovery), 1 = other/session
 *
 * Schedule every 6h (cron "0 0,6,12,18 * * *") and alert on non-zero exit:
 *   pm2 start scripts/grok-web/statsig_drift_canary.mts --name statsig-drift --cron "0 0,6,12,18 * * *" --no-autorestart
 *   # or cron:  0 0,6,12,18 * * *  npx tsx .../statsig_drift_canary.mts || <alert>
 *
 * One healthy run costs ~1 free-lane query; a drift run costs ~2. Negligible.
 */

process.env['SUDO_GROK_WEBSESSION'] ??= '1';

import { checkStatsigDrift, type GateProbe } from '../../src/llm/grok-statsig-drift-canary.js';
import { mintStatsigFromSeed } from '../../src/llm/grok-statsig-mint.js';
import { callGrokWebBridge } from '../../src/llm/grok-web-bridge.js';
import { getGrokWebSessionManager } from '../../src/llm/grok-web-session-manager.js';
import { getGrokStatsigOracle } from '../../src/llm/grok-statsig-oracle.js';

const PATH = '/rest/app-chat/conversations/new';
const session = await getGrokWebSessionManager().ensureHealthy();
const creds = { cookie: session.cookie, userAgent: session.userAgent };

const mintPureNode = async (): Promise<string> => {
  const s = await callGrokWebBridge({ op: 'seed' }, creds);
  if (!s.ok || !s.seed) throw new Error(`seed fetch failed: ${s.errorClass ?? 'no seed'}`);
  return mintStatsigFromSeed(s.seed, PATH, 'POST', Date.now());
};

const mintOracle = (): Promise<string> =>
  getGrokStatsigOracle({ cdpUrl: process.env['SUDO_GROK_ORACLE_CDP_URL'] ?? undefined }).mint(PATH, 'POST');

const probeGate = async (statsigId: string): Promise<GateProbe> => {
  const r = await callGrokWebBridge(
    { op: 'chat', message: '.', modelName: 'grok-4', temporary: true, disableSearch: true, timeoutSec: 30 },
    { ...creds, statsigId },
  );
  return { passed: r.ok === true, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.errorClass ? { errorClass: r.errorClass } : {}) };
};

const result = await checkStatsigDrift({ mintPureNode, mintOracle, probeGate });
console.log(JSON.stringify(result));
process.exit(result.status === 'healthy' ? 0 : result.status === 'algorithm_drift' ? 2 : 1);
