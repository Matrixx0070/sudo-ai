# GrokWebSession (GW) Campaign — Status Ledger

**Spec:** `docs/OPUS_HANDOFF_GROK_WEBSESSION.md`. **Executor:** Opus. **Reviewer/merge:** Fable.
States: `TODO | IN_PROGRESS | BLOCKED(Q-GWn) | PR(#n) | MERGED(#n) | DEPLOYED | DONE`

| WS | Title | State | PR | Flag | Evidence |
|---|---|---|---|---|---|
| GW1 | Discover generate endpoints | PR(#886) | #886 | — | `docs/grok-web-imagine-protocol.md`; image=WS `wss://grok.com/ws/imagine/listen` (inline base64 JPEG), video=`/rest/app-chat/conversations/new` streaming; all 3 lanes replayed headless 200/JPEG |
| GW2 | Python replay bridge | PR(#887) | #887 | SUDO_GROK_WEB_* | 9 tests; live: probe 200, image JPEG 99855B |
| GW3 | GrokWebSessionManager | PR(#888) | #888 | — | 10 tests; 0600 persist, refresh state machine |
| GW4 | Capture-at-setup + headless refresh | PR(#889) | #889 | GROK_WEB_CDP_ENDPOINT | 8 tests; live: headless cookie capture (2603B) + CDP statsig sniff (len 94) |
| GW5 | Wire image/video into grok CLI | PR(#890) | #890 | SUDO_GROK_WEBSESSION (OFF) | 5 tests; LIVE e2e: `grok image` → real 146675B JPEG on subscription |

## Proven mechanism (2026-07-20, live, same host/IP as browser)
- **Image:** plain `websocket-client` + Cookie (no TLS impersonation, no statsig) → 101 + valid JPEG blobs.
- **Video:** `curl_cffi impersonate=chrome` + Cookie + **`x-statsig-id`** → `post/create` 200, `app-chat/conversations/new` 200 streaming; final mp4 at `assets.grok.com/users/<uid>/generated/<video_id>/generated_video.mp4`.
- **Probe:** `curl_cffi` + Cookie → `quota_info` 200 (18h window, `windowSizeSeconds:64800`).

## Q&A with Fable
- **Q-GW1 (video statsig):** `app-chat/conversations/new` (video kickoff) requires a client-JS-generated `x-statsig-id` (403 without; reusable ≥20s with). Image path needs none. Recommendation: GW4 captures a fresh `x-statsig-id` alongside cookies at browser spin-up, persists it in the session store, reuses it, and re-captures (headless) on an app-chat 403 — mirroring the cf_clearance refresh path. Ship IMAGE first (zero statsig risk), gate VIDEO behind the same flag but note its extra fragility.
- **A-GW1 (Fable, 2026-07-20) — APPROVED as proposed.** IMAGE is the robust PRIMARY (WS lane needs neither TLS-impersonation nor statsig — ship confidently). VIDEO: capture `x-statsig-id` at durable-browser spin-up alongside cookies/cf_clearance, persist 0600, reuse within its window, re-capture headless on an app-chat 403 (mirror the cf_clearance refresh path exactly). Gate video behind the same `SUDO_GROK_WEBSESSION` flag but mark it BEST-EFFORT / more fragile in code + docs (statsig TTL unproven long-term; ~20s reuse is the only data; the refresh path is its safety net). If statsig is short-lived in practice, video degrades to a headless re-capture per call — acceptable, documented, image unaffected.


## Session close (2026-07-20)
All 5 GW slices built + tested + PR'd (stack #886→#887→#888→#889→#890, merge order = same). 32 grok-web unit tests green; new-file typechecks clean. LIVE-proven end to end: `sudo-ai grok image` generates a real JPEG on the subscription via the WS lane. Video is best-effort (statsig via CDP-sniff of the live browser; A-GW1). Next: Fable merges the stack (green-only) + deploys + runs the $-meter verification (console.x.ai Monthly spend flat while generating). Honest limitation: a fresh Playwright launch cannot boot grok's API layer, so headless statsig capture requires the live browser over CDP — image is unaffected.
