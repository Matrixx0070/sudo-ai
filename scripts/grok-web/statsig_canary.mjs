// statsig spinner-path canary — early-warning that grok reskinned its loading spinner.
//
// The browserless minter (statsig_mint.mjs / src/llm/grok-statsig-mint.ts) reproduces
// grok's anti-bot fingerprint from 4 hardcoded `.r-gswh7` spinner `d` paths (R_GSWH7_PATHS,
// selected by seed[5] % 4). If grok reskins the spinner those paths change and every mint
// silently starts returning HTTP 403. This canary renders a few throwaway grok.com/imagine
// tabs over the warm Chrome CDP endpoint (default ws 127.0.0.1:9223), collects the live
// spinner `d` reads, and diffs them against the shipped R_GSWH7_PATHS — so drift is caught
// on a schedule instead of in production.
//
// Exit codes:  0 = OK (spinner unchanged) · 1 = DRIFT (reskin — re-capture needed) ·
//              2 = INCONCLUSIVE (browser unreachable, or spinner never rendered).
// Cost: zero LLM/API/network spend beyond the CDP renders on the already-running browser.
// Safety: only throwaway tabs (/json/new + /json/close); NEVER injects the production tab.
//
// Run:       node scripts/grok-web/statsig_canary.mjs [loads]
// Schedule:  cron  →  */360 * * * *  node /root/sudo-ai-v4/scripts/grok-web/statsig_canary.mjs 12 || <alert>
//            pm2   →  pm2 start scripts/grok-web/statsig_canary.mjs --name statsig-canary --cron "0 */6 * * *" --no-autorestart
//   (a non-zero exit is the alert signal; wire it to whatever notifier you use.)
import WebSocket from 'ws';
import http from 'node:http';
import { compareSpinnerPaths, R_GSWH7_PATHS } from './statsig_mint.mjs';

const PORT = Number(process.env.GROK_CDP_PORT || 9223);
const N = Number(process.argv[2] || process.env.STATSIG_CANARY_LOADS || 6);
const SETTLE_MS = Number(process.env.STATSIG_CANARY_SETTLE_MS || 14000);

function httpJson(path) {
  return new Promise((res, rej) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: path.startsWith('/json/new') ? 'PUT' : 'GET' },
      r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(b); } }); },
    );
    req.on('error', rej);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function withPage(tabId, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${tabId}`, { perMessageDeflate: false, maxPayload: 200 * 1024 * 1024 });
    let id = 0; const pend = new Map();
    const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
    ws.on('open', async () => { try { const r = await fn(send); ws.close(); resolve(r); } catch (e) { ws.close(); reject(e); } });
    ws.on('error', reject);
  });
}

// Minimal hook: record every `d` read starting with 'M' (compareSpinnerPaths filters to
// the spinner signature). Mirrors the getAttribute hook in statsig_capture.mjs.
const HOOK = `(function(){window.__cd=[];var g=Element.prototype.getAttribute;` +
  `Element.prototype.getAttribute=function(n){var v=g.apply(this,arguments);` +
  `try{if(n==='d'&&typeof v==='string'&&v[0]==='M'&&window.__cd.length<64)window.__cd.push(v);}catch(e){}` +
  `return v;};})();`;

async function oneLoad() {
  const t = await httpJson('/json/new?' + encodeURIComponent('about:blank'));
  const dReads = await withPage(t.id, async (send) => {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
    await send('Page.navigate', { url: 'https://grok.com/imagine' });
    await sleep(SETTLE_MS);
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__cd||[])', returnByValue: true });
    return JSON.parse(r.result.value || '[]');
  });
  await httpJson('/json/close/' + t.id);
  return dReads;
}

(async () => {
  const all = []; let ok = 0, err = 0;
  for (let k = 0; k < N; k++) {
    try { all.push(...(await oneLoad())); ok++; }
    catch (e) { err++; process.stderr.write(`[statsig-canary] load ${k} error: ${e.message}\n`); }
  }

  if (ok === 0) {
    console.error(`[statsig-canary] INCONCLUSIVE: no successful loads — is the warm grok browser up on CDP ${PORT}? (errors=${err})`);
    process.exit(2);
  }

  const r = compareSpinnerPaths(all);
  const summary = JSON.stringify({
    loads: ok, errors: err, sampled: r.sampled, spinnerSeen: r.spinnerSeen,
    matchedBuckets: r.matchedBuckets, missingBuckets: r.missingBuckets, unknownLive: r.unknownLive.length,
  });

  if (r.spinnerSeen === 0) {
    console.error(`[statsig-canary] INCONCLUSIVE: 0 spinner-shaped paths across ${ok} loads — spinner may not have rendered or the selector moved. ${summary}`);
    process.exit(2);
  }

  if (!r.ok) {
    console.error('[statsig-canary] DRIFT: grok spinner changed — browserless minting WILL start returning 403.');
    console.error(`  ${r.unknownLive.length} unknown live spinner path(s); buckets still matching: [${r.matchedBuckets.join(',')}] of 4`);
    for (const p of r.unknownLive) console.error(`   NEW: ${p.slice(0, 96)}${p.length > 96 ? '…' : ''}`);
    console.error('  RE-CAPTURE: node scripts/grok-web/statsig_capture.mjs 18 /tmp/pathb.json  → re-derive R_GSWH7_PATHS');
    console.error('             (group by seed[5]%4) in BOTH scripts/grok-web/statsig_mint.mjs and src/llm/grok-statsig-mint.ts,');
    console.error('             then refresh the FP fixtures in statsig_mint.test.mjs + tests/llm/grok-statsig-mint.test.ts.');
    console.error(`  ${summary}`);
    process.exit(1);
  }

  console.log(`[statsig-canary] OK: spinner unchanged (matches ${R_GSWH7_PATHS.length} shipped paths). ${summary}`);
  if (r.missingBuckets.length) {
    console.log(`  note: buckets [${r.missingBuckets.join(',')}] not observed this run — sampling, not drift; raise loads (arg1) for full 4-bucket coverage.`);
  }
  process.exit(0);
})();
