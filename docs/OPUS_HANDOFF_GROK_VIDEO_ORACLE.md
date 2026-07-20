# OPUS HANDOFF — Grok Video via Headless Statsig Oracle (GWV campaign)

**Written by:** Fable, 2026-07-20, after a full live reverse-engineering session that PROVED the mechanism end-to-end (real 2 MB MP4 generated server-side).
**Executor:** Opus, autonomous. **Reviewer/unblock/deploy:** Fable via `docs/CAS_WIRING_QA.md` (append `Q-GWV<n>`).
**Doctrine + gotchas bind:** `docs/OPUS_HANDOFF_CAS_WIRING.md` §1/§2/§6, and `docs/OPUS_HANDOFF_GROK_WEBSESSION.md` (the GW campaign this builds on). **Builds ON** the merged GW stack — reuse it, do NOT fork.

## 0. Mission
Make `sudo-ai grok video "<prompt>"` generate a **real video FREE on the user's $30 Grok subscription** (grok.com web-app path, never `api.x.ai`), robustly, by minting the `x-statsig-id` anti-bot token on demand from a **lightweight on-demand headless browser** ("the oracle") and serving the video request via the existing curl_cffi bridge. Image lane already ships free+browserless; this adds the video lane.

## 1. FABLE-PROVEN FACTS (live, 2026-07-20 — verify still-true, then build; do NOT re-derive)

**Why a browser is REQUIRED (path B / pure-Node is DEAD — do not attempt):** the video endpoint `POST /rest/app-chat/conversations/new` (modelName `imagine-video-gen`) is gated by header `x-statsig-id`. That token is minted by grok's own client code and — proven by stack-filtered CDP tracing of a real mint — its computation does `document.createElement('div') → div.animate(<transform derived from a page seed>) → getComputedStyle(div)`, folding the **browser rendering/animation engine output** into the signature (plus a rotating `<meta name="grok-site―verification" content=...>` seed and `.r-gswh7` SVG `d` attrs). This is a deliberate anti-headless fingerprint; it CANNOT be reproduced in Node/jsdom. A **real (headless is fine) rendering engine** must mint it. The SHA-256/base64 crypto is otherwise pure-JS.

**The minter is exposable and callable on demand (PROVEN):**
- Request-signing middleware lives in the main app chunk (2026-07-20: `cdn.grok.com/_next/static/chunks/0igp2fphstmjc.js`). It does: `i = new URL(url).pathname.split("?")[0]; t = await d0(i, method); headers.set("x-statsig-id", t)`.
- `async function d0(path, method)` lazy-loads a self-contained minter module (2026-07-20: chunk `0lcqe.jc2e4am.js`, module id `4629918`) whose `default()` returns the minter `o(path, method)`.
- **Exposure recipe (Fable ran this, got a working token):** CDP `Debugger.enable` → `Debugger.setBreakpointByUrl` at the `d1` body (the `t=await d0(...)` site) → trigger any app request (navigation to `/imagine` fires many signed requests) → on `Debugger.paused`, `Debugger.evaluateOnCallFrame({callFrameId, expression:"globalThis.__grokMint=d0"})` → resume + remove breakpoint. Then `globalThis.__grokMint(path, method)` (via `Runtime.evaluate` with `awaitPromise:true`) mints a **fresh 94-char token on demand**, using the live page's rendering engine + current seed.
- **Token properties (PROVEN):** keyed on `(path, method, timestamp)` + page seed + render fingerprint; **NOT bound to request body**; **NOT single-use** (accepted multiple replays inside its window); **TTL ≈ 20–45s** (server freshness check). Because we mint-and-use in <1s, **the TTL is irrelevant** — never replay a captured token; always mint fresh per request.

**End-to-end PROVEN (Fable, live):** mint via `__grokMint('/rest/app-chat/conversations/new','POST')` → feed the token to curl_cffi `POST /rest/app-chat/conversations/new` (impersonate=chrome, captured Cookie+UA, real text-to-video body) → **HTTP 200 streaming → real 2 MB ISO-MP4** at `https://assets.grok.com/users/<uid>/generated/<vid>/generated_video.mp4`. Bogus-body probe with a valid token returns backend `400 "Invalid source post id"` (past the anti-bot gate); a stale/absent token returns `403 {"code":7,"message":"Request rejected by anti-bot rules."}` — that 400-vs-403 is the zero-quota health probe.

**Video request shapes** (full detail in `docs/grok-web-imagine-protocol.md §4`):
- Text-to-video (no source image, PROVEN): body `{"temporary":true,"modelName":"imagine-video-gen","message":"<prompt> --mode=custom","enableSideBySide":true,"responseMetadata":{"experiments":[],"modelConfigOverride":{"modelMap":{"videoGenModelConfig":{"aspectRatio":"9:16","videoLength":6,"resolutionName":"720p"}}}}}`. Stream JSON lines → `result.response.streamingVideoGenerationResponse.videoUrl` at `progress:100` → prefix `https://assets.grok.com/`.
- Image-to-video: first `POST /rest/media/post/create {mediaType:"MEDIA_POST_TYPE_IMAGE", mediaUrl:"<imagine-public url>"}` → `post_id`; then conversations/new with `videoGenModelConfig.parentPostId=<post_id>`.
- Health/quota: `POST /rest/media/imagine/quota_info` (no statsig needed) → `video720p.remainingQueries` (≈8 per 18h window).

## 2. THE BUILD (GWV campaign; own worktrees/PRs; reuse GW modules)

Reuse (already merged/deployed — do NOT fork): `src/llm/grok-web-media.ts`, `src/llm/grok-web-session-manager.ts`, `src/llm/grok-web-capture.ts` (Playwright headless launcher — has the strict-TLS default from #891), `src/llm/grok-web-bridge.ts`, `scripts/grok-web/grok_web_replay.py`, `src/cli/commands/grok.ts` (`grok video`), `docs/grok-web-imagine-protocol.md`. Spec-3 durable-profile infra for the browser.

### GWV1 — The Statsig Oracle (`src/llm/grok-statsig-oracle.ts`)
A managed, **on-demand, headless** grok.com page that exposes the minter and serves `mintStatsig(path, method): Promise<string>`.
- **Launch:** headless Chrome via the existing Playwright launcher (`grok-web-capture.ts`) with the durable grok profile (SSO logged-in) + a CDP endpoint. Same host as the server (cf_clearance IP-binding). Navigate to `https://grok.com/imagine` (loads the minter + seed).
- **Expose `d0`:** implement the breakpoint-grab recipe (§1) via CDP. **Make the breakpoint self-healing across grok redeploys** (chunk names/offsets change): do NOT hardcode the offset. Instead, at runtime: enumerate parsed scripts, `getScriptSource` the app chunk, locate the signing site by SEARCHING for the stable string `x-statsig-id` and the adjacent `await d0(`/`.set("x-statsig-id"` pattern, compute line/col from the match, set the breakpoint there. Fall back to a clear `Q-GWV` escalation if the pattern is not found (grok changed the shape).
- **Mint:** `Runtime.evaluate("globalThis.__grokMint(path, method)", {awaitPromise:true})`. Re-grab if `__grokMint` is missing (page reloaded).
- **Lifecycle — honor "no browser held open":** launch lazily on the first video request; keep warm only during an active idle window (env `SUDO_GROK_ORACLE_IDLE_MS`, default e.g. 120000) then close; re-launch on next use. Never a permanently-open browser. Expose `warm()`, `mint()`, `close()`, and a health check.
- **Secrets:** never log cookies/statsig/seed; lengths/booleans only.

### GWV2 — Wire video generation through the oracle (`src/llm/grok-web-media.ts`)
Replace the current best-effort video path so it: (1) reads `quota_info` (graceful "quota exhausted"); (2) for image-to-video, does `media/post/create`; (3) **mints a fresh statsig via the oracle for `/rest/app-chat/conversations/new` + `POST`**; (4) curl_cffi POSTs the video body with that fresh token (bridge already exists); (5) streams to `progress:100`, returns the `assets.grok.com` mp4 URL; (6) downloads the mp4 (curl_cffi + cookies) to the media dir; (7) quarantines returned text per repo invariants. On `403 anti-bot`: re-mint once (fresh oracle grab), retry; if still 403 → surface a clear error, NEVER fall back to metered `api.x.ai`.

### GWV3 — CLI/surface + flag
`sudo-ai grok video "<prompt>" [--image <url>] [--length N] [--aspect 9:16] [--res 720p]` uses the oracle path. Keep flag-gate `SUDO_GROK_WEBSESSION` (default OFF until Fable live-verifies). Add `SUDO_GROK_ORACLE_IDLE_MS`. Register any new flags in `flag-manifest.json` (`tsx scripts/gen-flag-manifest.ts`).

### GWV4 — Tests
Unit-test the oracle with a MOCKED CDP/Playwright (no live browser in CI): breakpoint-offset finder against a recorded chunk fixture; mint returns the mocked token; lifecycle (lazy launch, idle close, re-grab on reload). Mock the curl_cffi bridge for the media flow (recorded 200 stream fixture → mp4 URL parse). Extend `tests/gdrive/hot-path.test.ts` equivalent so `src/core/*` never imports the oracle. Zero live-net, zero LLM spend, no secrets in fixtures.

## 3. INVARIANTS / CONSTRAINTS
- **Mint fresh per request, <1s mint→use.** Never replay captured tokens (TTL ~20–45s). Never store a token.
- **Headless real engine is mandatory** (rendering fingerprint). On-demand, not held open. Same host as curl_cffi (IP-binding).
- **curl_cffi impersonate=chrome mandatory** for the POST; match captured UA; carry all grok.com cookies.
- **grok.com path only = subscription-free.** NEVER `api.x.ai`. If quota exhausted or 403 unrecoverable → inform user; do NOT fall back to metered API (would cost money).
- **Secrets:** cookies/statsig/seed 0600, never logged/committed, quarantine returned content.
- **Grok stays OFF `config/sudo-ai.json5 models.primary`** — this is a media capability, not text routing. Do not touch the model chain, `config/.env`, `ecosystem.config.cjs`, `feat/gdrive-*`.
- **Do NOT deploy** — Fable owns deploy + the money-meter verification (console.x.ai spend must stay FLAT — the whole point).
- Repo gotchas: worktrees off fresh origin/main; one PR per slice; green-CI-to-merge is Fable's; Semgrep-logged-out → python edits; regen flag-manifest on new flags; verify merged diff.

## 4. ACCEPTANCE
- Oracle: lazy headless launch → self-healing breakpoint locate → `mintStatsig('/rest/app-chat/conversations/new','POST')` returns a 94-char token that passes the anti-bot gate (bogus-body probe → 400 not 403); idle-closes; re-grabs after reload. (Live step needs the durable profile; unit tests mock CDP.)
- `sudo-ai grok video "a paper boat on calm water"` → returns a real `assets.grok.com` mp4 (verified `ftyp` magic), **console.x.ai Monthly spend UNCHANGED** (Fable verifies the $ meter).
- 403 → one re-mint retry → clear error, never metered fallback. Quota exhaustion surfaced gracefully.
- CI green; merged-diff verified; secrets never in logs/tests/CI.

## 5. Escalate `Q-GWV<n>` in `docs/CAS_WIRING_QA.md`. Track rows GWV1..GWV4 in `docs/CAS_WIRING_STATUS.md`. 5-part reports. Honest UNVERIFIED where live-browser wasn't exercised (CI can't run the real oracle).

## 6. HONEST RISK LEDGER (state in the final wrap)
Grok can change the signing shape (chunk names, the `d0` call pattern, the seed/animation fingerprint) on any redeploy → the breakpoint-locate must self-heal on the stable `x-statsig-id` string and escalate if the shape changes. Headless spin-up latency (~5–10s) on cold video requests (acceptable; mint itself is <1s once warm). Cloudflare cookie refresh still applies (reuse GW4 refresh). This lane is genuinely more brittle than image (which needs no statsig at all) — image stays the reliable default; video is the value-add.
