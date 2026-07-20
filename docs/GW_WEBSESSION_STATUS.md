# GrokWebSession (GW) Campaign — Status Ledger

**Spec:** `docs/OPUS_HANDOFF_GROK_WEBSESSION.md`. **Executor:** Opus. **Reviewer/merge:** Fable.
States: `TODO | IN_PROGRESS | BLOCKED(Q-GWn) | PR(#n) | MERGED(#n) | DEPLOYED | DONE`

| WS | Title | State | PR | Flag | Evidence |
|---|---|---|---|---|---|
| GW1 | Discover generate endpoints | DONE (protocol) | feat/gw1-imagine-protocol | — | `docs/grok-web-imagine-protocol.md`; image=WS `wss://grok.com/ws/imagine/listen` (inline base64 JPEG), video=`/rest/app-chat/conversations/new` streaming; all 3 lanes replayed headless 200/JPEG |
| GW2 | Python replay bridge | TODO | — | — | curl_cffi (REST) + websocket-client (WS) proven; curl_cffi WS is BROKEN in-env (err 52) |
| GW3 | GrokWebSessionManager | TODO | — | — | mirror `src/llm/xai-oauth-manager.ts` |
| GW4 | Capture-at-setup + headless refresh | TODO | — | — | must also capture `x-statsig-id` for video lane |
| GW5 | Wire image/video into xai-oauth provider | TODO | — | `SUDO_GROK_WEBSESSION` (OFF) | image path fully proven; video path needs statsig plumbing (Q-GW1) |

## Proven mechanism (2026-07-20, live, same host/IP as browser)
- **Image:** plain `websocket-client` + Cookie (no TLS impersonation, no statsig) → 101 + valid JPEG blobs.
- **Video:** `curl_cffi impersonate=chrome` + Cookie + **`x-statsig-id`** → `post/create` 200, `app-chat/conversations/new` 200 streaming; final mp4 at `assets.grok.com/users/<uid>/generated/<video_id>/generated_video.mp4`.
- **Probe:** `curl_cffi` + Cookie → `quota_info` 200 (18h window, `windowSizeSeconds:64800`).

## Open questions for Fable
- **Q-GW1 (video statsig):** `app-chat/conversations/new` (video kickoff) requires a client-JS-generated `x-statsig-id` (403 without; reusable ≥20s with). Image path needs none. Recommendation: GW4 captures a fresh `x-statsig-id` alongside cookies at browser spin-up, persists it in the session store, reuses it, and re-captures (headless) on an app-chat 403 — mirroring the cf_clearance refresh path. Ship IMAGE first (zero statsig risk), gate VIDEO behind the same flag but note its extra fragility. OK to proceed on this design?
