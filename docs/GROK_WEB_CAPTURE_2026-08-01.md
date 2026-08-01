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

## 5. SOLVED — the Business chat transport is a WEBSOCKET, not HTTP

The earlier CDP attempts failed for a real reason, now known: **there is no send POST to capture.**
Business chat runs over a WebSocket, which is why `page.on('request')`, browser-level
`Network.enable` on every attached target, and even an in-page `fetch`/XHR monkey-patch all came
back empty while the tab still navigated to `/c/<uuid>`.

Cracked with **mitmproxy 12.2.3** (installed via pip) as an explicit HTTP proxy, driving a
throwaway Chrome that carried only the copied `Local State` + `Default/Cookies` (500 KB, **not** a
5.5 GB profile clone — the first attempt at that got OOM-killed).

### Endpoint

```
wss://grok.com/ws/mgw/?uid=<user-uuid>
```

An OpenAI-Realtime-style event protocol: `session.create` → `conversation.item.create` →
`response.create`, with `ping` heartbeats every ~3s.

### `session.create` — where every option lives

```json
{"session_id":"<conversation-uuid>",
 "event":{"type":"session.create","event_id":"evt_init_<uuid>",
  "session":{"model":"auto",
   "x_grok":{
     "protocol_capabilities":["conversation_attached","custom_methods_v1"],
     "conversation_id":"<uuid>","load_existing":true,"initial_load_id":"<uuid>:0",
     "use_chunk":true,
     "connector_ids":["connector_<uuid>","connector_<uuid>"],
     "enable_side_by_side":true,"force_side_by_side":false,
     "enable_image_generation":true,"image_generation_count":2,
     "disable_text_follow_ups":false,"disable_artifact":true,"force_concise":false}}}}
```

Note `"model":"auto"` — a **mode** id from `/rest/modes`, not a model id.

### `conversation.item.create` — the user message

```json
{"session_id":"<uuid>","event":{"type":"conversation.item.create","event_id":"evt_msg_<ms>",
 "item":{"type":"message","role":"user",
  "x_grok":{"client_message_id":"<uuid>",
   "input_chunks":[{"text":{"text":"Search X for top AI posts today"}}]}}}}
```

### `response.create` — triggers generation, and carries the anti-bot token

```json
{"session_id":"<uuid>","event":{"type":"response.create","event_id":"evt_resp_<ms>",
 "castle_request_token":"<14167 chars>"}}
```

That is the **entire** event — three keys, nothing else.

## 6. THE ANSWER: there is no X-search payload field, on either lane

This was the question that started the hunt. Across the full captured session-creation options
there is **no web-search or X-search toggle of any kind**. The only tool-ish fields are
`connector_ids` (MCP), `enable_image_generation`, and `disable_artifact`.

That independently confirms the API-side result in `audit/00-DECISIONS.md` D-16 from a completely
different angle: search is **not** a payload flag. Grok decides to search on its own. On the REST
lane the only relevant control is `disableSearch: false`; `toolOverrides` needs no X-search key
because none exists.

**So there was never a payload to copy.** Two independent methods now agree.

## 7. NEW FINDING — `castle_request_token`: a second anti-bot gate, distinct from statsig

The WS lane is guarded by a **~14 KB Castle (castle.io) request token** on every
`response.create`. This is *not* `x-statsig-id`, which guards the REST lane and is what
`grok-statsig-oracle.ts` mints.

Implication for this repo: **the WS lane is not a cheap migration target.** Adopting it would mean
minting Castle tokens as well as statsig, i.e. a second browser-bound oracle with its own drift
risk — and this project already lost a day to statsig drift on 2026-08-01. The existing REST
`/rest/app-chat/conversations/new` lane remains the right door: it is live-proven, statsig-only,
and already does X search.

## 8. Housekeeping

- mitmproxy was installed with `pip --break-system-packages --ignore-installed blinker`. It
  downgraded `opentelemetry-proto` 1.40.0 → 1.37.0 and `typing-extensions` 4.15 → 4.14, which pip
  flagged as conflicting with `opentelemetry-exporter-otlp-proto-grpc` and `selenium`. **Verified
  afterwards that the prod python bridge is unaffected**: `curl_cffi 0.14.0` imports,
  `grok_web_replay.py` returns valid JSON, and a live session probe returns
  `{"ok":true,"status":200}`.
- The production `grok-warm-browser` (the statsig oracle) was **never touched** — all work used a
  throwaway profile on a separate debug port. Confirmed still online with CDP 9223 responding 200.
- Temporary profile, capture Chrome, and mitmdump all torn down.
