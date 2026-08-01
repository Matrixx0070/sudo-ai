# Grok web seat — CDP capture from display :10, 2026-08-01

Captured live from the logged-in `grok-warm-browser` (pm2 id 810, pid 1636608,
`DISPLAY=:10`, Chrome 149.0.7827.53, CDP on `127.0.0.1:9223`). Account: **megastream**,
tier shown as **Grok Business**, session in **Private** mode.

Work was done in a **new tab**; the oracle's own `grok.com/imagine` page was never touched, because
that browser is the production statsig minter.

---

## 1. The `/rest/*` surface the real UI calls (observed, not guessed)

| Endpoint | Method | Body |
|---|---|---|
| `/rest/modes` | POST | `{"locale":"en"}` |
| `/rest/skills` | POST | `{"locale":"en"}` |
| `/rest/system-prompt/list` | POST | `{"pageSize":100}` |
| `/rest/rate-limits` | POST | `{"modelName":"expert"}` |
| `/rest/suggestions/stream` | POST | `{"query":…,"acceptedTypes":[…],"conversationHistory":[…]}` |
| `/rest/connectors/list-v2` | POST | `{"refreshToken":true,"checkWatchChannelValidity":true}` |
| `/rest/connectors/list-available-v2` | POST | `{}` |
| `/rest/onboarding/for-user` | POST | `{"scope":"CONNECTOR_SCOPE_TEAM","scopeId":"<uuid>"}` |
| `/rest/mcp/discovered-tools/list` | POST | `{"scopeId":…,"connectorIds":[…],"scope":"CONNECTOR_SCOPE_TEAM"}` |
| `/rest/media/imagine/quota_info` | POST | — |
| `/rest/app-chat/conversations?pageSize=60` | GET | — |
| `/rest/app-chat/conversations?pageSize=4&workspaceId=<uuid>` | GET | — |
| `/rest/app-chat/conversations_v2/<id>?includeWorkspaces=true&includeTaskResult=true` | GET | — |

`x-statsig-id` is present on `/rest/skills`, `/rest/modes`, `/rest/system-prompt/list`,
`/rest/suggestions/stream`; **absent** on the connector/MCP calls — consistent with the repo's
existing note that MCP connector ops are "cookie-only, statsig-FREE".

## 2. `/rest/modes` — the real mode list (status 200)

```json
{"modes":[
 {"id":"auto",  "title":"Auto",   "description":"Chooses Fast or Expert"},
 {"id":"fast",  "title":"Fast",   "description":"Quick responses · Grok 4.5"},
 {"id":"expert","title":"Expert", "description":"Thinks hard · Grok 4.5"},
 {"id":"heavy", "title":"Heavy",  "description":"Team of Experts · Grok 4.5",
   "availability":{"requiresUpgrade":{"minimumSubscriptionTier":"TIER_SUPERGROK_HEAVY"}}},
 {"id":"build", "title":"Build",  "description":"Build apps and sites · Grok 4.5", "badgeText":"Beta",
   "availability":{"requiresUpgrade":{"minimumSubscriptionTier":"TIER_SUPERGROK_PLUS"}}}],
 "defaultModeId":"auto"}
```

Note the UI's `/rest/rate-limits` call sends `{"modelName":"expert"}`, i.e. **the UI passes a *mode*
id where our bridge passes a *model* id (`grok-4`)**. `grok-4` is still accepted by
`/rest/app-chat/conversations/new` (verified: ok=true, status=200, real modelHash). Whether
`expert` is also accepted there is **UNVERIFIED** — the one attempt returned `403 errorClass=statsig`,
which is a token failure, not a model rejection, so the test was inconclusive. Worth re-running:
if `expert` works it may route to Grok 4.5 rather than whatever `grok-4` resolves to.

## 3. `/rest/skills` — installed skills (status 200)

`docx` · `pdf` · `pptx` · `xlsx` · `skill-creator`

## 4. The X-search toggle is NOT in the Business UI

The screenshot that prompted this hunt (`< Tools / Web search / X search`) is the **consumer
grok.com** composer. On this **Grok Business** seat the composer `+` menu contains only:

> Upload a file · Recent › · Project › · Skills › · Connectors ›

There is no Tools submenu and no X-search toggle anywhere in the composer. So there is no
Business-side UI payload to copy.

## 5. HONEST FAILURE — the message-send POST could not be intercepted

The send provably happens (the tab navigates to `grok.com/c/<uuid>?rid=<uuid>` every time), but the
request never appears in any capture. Six approaches tried, all negative:

1. Playwright `page.on('request')` — sees GETs and other POSTs, not the send.
2. Wider filter over every `grok.com` POST — same.
3. `newCDPSession(page)` + `Network.enable` + `Target.setAutoAttach`.
4. Browser-level websocket CDP + `setAutoAttach` + `Network.enable` per attached session.
5. Same, plus `Target.getTargets` → explicit `attachToTarget` on the pre-existing
   `shared_worker` and `worker` blob targets (they pre-date auto-attach, so this was the leading
   hypothesis — it did not fix it).
6. In-page monkey-patch of `window.fetch` **and** `XMLHttpRequest.prototype.send/open` — captured
   20 other `/rest/*` POSTs, zero conversation sends.

Conclusion: the Business chat transport does not use page-visible `fetch`/XHR and is not surfaced by
CDP Network on any attachable target. Likely a WASM/worker channel with its own transport.
**Not solved. Do not assume otherwise.**

## 6. Why this does not block anything

The original question — how to make the seat search X — is already answered from the API side and
live-proven (see `audit/00-DECISIONS.md` D-16):

> `POST /rest/app-chat/conversations/new` with **`disableSearch: false`** and **`toolOverrides: {}`**.
> No X-search key is required; Grok invokes X search itself when the query warrants it.
> Verified: `toolMarkers: ["webSearchResults"]`, and 5/5 returned post URLs confirmed real against an
> independent lane, with a fabricated control correctly failing to resolve.

The UI payload would have been a nice cross-check. It is not a prerequisite.
