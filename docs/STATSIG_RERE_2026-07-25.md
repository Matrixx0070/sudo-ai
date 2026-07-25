# Statsig fingerprint re-RE (2026-07-25) — grok.com anti-bot minter drift

Context: pure-Node `x-statsig-id` minter (`src/llm/grok-statsig-mint.ts`) broke (403). grok
reskinned the spinner AND changed the fingerprint algorithm. This doc banks the re-RE progress so
a future session resumes without re-capturing. Ground truth: `docs/statsig-rere-groundtruth-2026-07-25.json`
(16 loads: seedBytes, anim keyframes, obs color/transform, targetDhex, dReads spinner path).

## Re-reversed & VERIFIED (16/16 against ground truth)
1. **Spinner paths drifted** — re-captured, in `docs/statsig-rere-newpaths-2026-07-25.json` (4 paths, index = seed[5]%4). Replaces R_GSWH7_PATHS.
2. **Color-segment selector CHANGED: `seed[41]%16` → `seed[21]%16`** (selects which C-segment of the path gives colors). This is the key algorithm change found.
3. color0=seg[0:3], color1=seg[3:6] (first 6 numbers of the selected C-segment) — unchanged.
4. Rotation `floor(g[6]*300/255+60)` — unchanged (16/16).
5. Easing controls g[7..10] — structure intact.
6. dHex from computed-style (`computeDhex(color,transform)`) — unchanged (16/16: computeDhex(obs)==targetDhex).

## THE HOLDOUT: `currentTime` (animation sample phase)
Old: `round((seed[19]%16)*(seed[29]%16)*(seed[36]%16)/10)*10`. DEAD.
Evidence it changed: three loads with old-S=0 give curT 80/830/1010; curT/10 contains primes >15
(43,83,101) so it is NOT a nibble product. Exhaustively falsified (across 16 samples): 2/3-byte
nibble & raw products, byte mods, scaled byte-pairs, single-g mods/scales, 2-g products. Structure unknown.

## Source-extraction path (for next session)
- `__grokMint` is a 91-char lazy wrapper: `async(e,t)=>{ n??=a().catch(...); i=await n; return i(e,t) }`. Real minter = `i = await a()` (lazy webpack module).
- grok's webpack registry is NOT a window global (only `webpackChunkStripeJSouter` + `__next_s` exist). So can't dump modules via the chunk global.
- DEFINITIVE next step: after a successful mint (hoists `globalThis.__grokMint`), CDP `Runtime.getProperties(__grokMint, ownProperties:false)` → `[[Scopes]]` → walk closure → get `a` (loader) or `n` (resolved minter promise) → `callFunctionOn`/toString to read the minter source + the currentTime computation. NOTE: the warm browser at :9223 degraded during this session (mint began failing) — RESTART it before resuming.

## Status
5/6 components re-reversed & verified. currentTime unresolved — needs the debugger-scope source extraction above (or a large slow sample harness). It is a MOVING TARGET (will drift again) → permanent RE maintenance. The oracle (browser) path works when the browser is healthy; pure-Node is an optimization, not a blocker.

## UPDATE — real minter source EXTRACTED (scope-walk works)
Method (proven): restart warm browser → oracle.mint hoists `globalThis.__grokMint` (even when the
app-chat call fails, the hoist happens) → CDP `getProperties(__grokMint, ownProperties:false)` →
`[[Scopes]]` → find closure var `n` (subtype promise) → `Runtime.awaitPromise(n)` → the real minter →
`callFunctionOn(this.toString())`. Artifact: `docs/statsig-realminter-obfuscated-2026-07-25.js` (1049 chars).

Minter structure (confirms our sha256 RE exactly):
  async(W=path, n=method) => {
    u = floor(Date.now()/1000 - EPOCH)*... (r timestamp)
    o = rLE bytes of u
    d = seed (from meta)
    f = c[C(1003,1026,942,1044,"j01N")](y, d)   // <-- FINGERPRINT (dHex), incl. currentTime, is HERE
    sha = sha256( [n,W,u].join("!") + SALT + f )  // method!path!r + salt + dHex  ✓ matches RE
    token = base64( k0 ++ (seed48 ++ rLE ++ sha16 ++ 0x03) ^ k0 )  ✓ matches RE
  }

REMAINING: `currentTime` is inside the fingerprint helper `c[C(...)](y,d)` = `c[t(-261,"j01N")]`, behind
obfuscator.io-style string-array + control-flow obfuscation. Keyword extraction fails (getComputedStyle/
currentTime/animate are decoded string-table lookups, not literals). To finish: resolve `t`(string decoder)
+ `c`(method object) from the minter's [[Scopes]] (1340 vars), decode `t(-261,"j01N")`, dump `c[key]`,
then deobfuscate that helper (recursively) — OR hook Animation.currentTime + collect seed→currentTime samples.
This is a dedicated deobfuscation pass on a MOVING target. sha256 pipeline + 5/6 components are DONE.

## ✅ SOLVED (2026-07-25) — pure-Node minter CRACKED + live-gate proven
Extracted the live minter source via CDP scope-walk (needs stable Xvfb display — X :10 was flaky;
started fresh Xvfb :99). Deobfuscated the fingerprint helper `y` by decoding the string-table (`t`) +
method object (`c`) live. Two changes vs old algorithm (everything else — bezier, computeDhex, rotation,
round(S/10)*10, token/sha256 assembly — UNCHANGED):
  - segment selector: seed[41]%16 → **seed[21]%16**
  - currentTime: (seed[19]%16)*(seed[29]%16)*(seed[36]%16) → **(seed[4]%16)*(seed[14]%16)*(seed[7]%16)**
Applied to src/llm/grok-statsig-mint.ts + scripts/grok-web/statsig_mint.mjs (lockstep) + new R_GSWH7_PATHS.
VERIFIED: deriveFingerprint 16/16 vs ground truth; TS test 11/11; mjs reference 18/18; and a PURE-NODE
token (curl seed → mintStatsigFromSeed → app-chat gate) **passed the live gate HTTP 200, grok replied
"PURE-NODE-OK", NO BROWSER**. => SUDO_GROK_STATSIG_BROWSERLESS=1 now yields fully headless, zero-browser,
one-time-cookie-login minting for the whole connector stack.

## Full minter deobfuscation (robustness confirmations, decoded live)
Decoded the string-table (t) + method-object (c) lookups in the minter. Confirmed our hardcoded
constants against the live source:
  - SALT: t(278,"5dtf")->"Eozrk"-> **"obfiowerehiring"** (static string, NOT rotating) — matches STATSIG_SALT ✅
  - timestamp: k["now"]() = **Date.now()** ✅ (r formula intact → R_EPOCH 1682924400 confirmed by passing tokens)
  - arithmetic ops: W-n(sub), W*n(mul), W+n(add), W(n)(apply), W()(call), join, concat ✅
  - fingerprint helper c["wWizx"] = apply wrapper -> the real fn is `y(seed)`; y decoded to:
      a = seed[21]%16 (segment);  currentTime k = (seed[4]%16)*(seed[14]%16)*(seed[7]%16);
      rgb interp + rotation + computeDhex(color+transform) — all matching our impl.
Token assembly (payload seed48++rLE++sha16++0x03, k0 XOR mask, base64) independently proven byte-consistent
AND live-gate-passed. => The pure-Node minter is FULLY understood; no hidden steps.

## Remaining for OPERATIONAL robustness (not cracking — build tasks)
1. Enable browserless-first by default (SUDO_GROK_STATSIG_BROWSERLESS=1) so the connector mints pure-Node,
   zero browser, in prod. Oracle stays as fallback only.
2. Algorithm-drift canary: extend scripts/grok-web/statsig_canary.mjs to re-derive the byte indices
   (seed[21], seed[4/14/7]) + paths from the live minter via the scope-walk and alert on change — so the
   next drift is an EARLY WARNING, not silent 403s. Recovery recipe (scope-walk -> decode t/c -> new bytes)
   is documented above.

## Complete minter confirmation (every step verified vs live source, 2026-07-25)
Decoded the minter's closure functions — our pure-Node reproduction is byte-exact end to end:
  k=Date (Date.now timestamp); J=atob (base64 seed decode); N=g(a(n))[seed[5]%4] (bucket=seed[5]%4);
  y=fingerprint (segment seed[21]%16, currentTime (seed[4]%16)*(seed[14]%16)*(seed[7]%16));
  V=slice(0,16) (sha16); z=3 (0x03 terminator); U=(W,n,t)=>n?W^t[0]:W (k0 XOR mask);
  b=createHash("...256") (SHA-256); h=btoa(...) (base64 output). NOTHING unaccounted for.
cf_clearance note: normal curl requests refresh __cf_bm but NOT cf_clearance (Cloudflare-challenge-issued);
its refresh needs the browser (or cookie re-import). Session held for hours in testing → long-lived.
