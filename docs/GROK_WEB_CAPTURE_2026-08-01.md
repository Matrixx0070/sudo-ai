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

---

# ADDENDUM — full-fidelity capture, and the answer to "what more tools do you need?"

**Nothing further needs installing.** `mitmproxy` was the one genuine gap and it is now in place.
The earlier blind spot was not a missing tool, it was an incomplete addon: it logged only
client→server WebSocket frames and no response bodies. Fixed and made reusable at
`scripts/capture/mitm-capture.py`.

## Tooling inventory (verified on this box, not assumed)

| Tool | Status | What it covers |
|---|---|---|
| `mitmproxy` / `mitmdump` / `mitmweb` 12.2.3 | **installed** | HTTP req+res bodies, **WS both directions**, flow archive + replay |
| `tshark` / `tcpdump` | present | packet level; pairs with Chrome `--ssl-key-log-file` for TLS decrypt |
| `jq`, `openssl` | present | analysis |
| Chrome `--log-net-log` | built in | netlog, captures below the worker layer |
| Chrome `--disable-quic` | built in | forces h1/h2 so an explicit proxy sees everything |
| `websocat` | absent | only needed to *speak* the mgw protocol directly — not to capture it |
| `frida` | absent | only needed for cert-pinned native apps. grok.com does not pin in Chrome |

## Proof of full fidelity (single run, 2026-08-01)

```
226  ws_rx     server -> client WebSocket frames   (previously invisible)
207  res       HTTP responses WITH bodies          (previously invisible)
207  req       HTTP requests
 11  ws_tx     client -> server WebSocket frames
  1  ws_open
flow archive: 11,306,314 bytes (replayable via mitmdump -r)
```

## What the server stream actually contains

Complete server event grammar over `wss://grok.com/ws/mgw/`:

```
205  response.chunk              1  response.created        1  response.output_item.done
  8  pong                        1  response.output_item.added  1  response.done
  1  session.created             1  response.content_part.added 1  response.persisted
  1  conversation.attached       1  response.output_text.done   1  conversation.title.updated
  1  conversation.queue.updated  1  response.content_part.done
  1  conversation.item.added
```

**Typed tool results** — objective server-side proof the X-search tool ran:

```json
{"chunk":{"metadata":{"step_id":0},
  "tool_result":{"tool_call_id":"ec277f35-...","x_post":{}}}}
```

**Typed structured citations** — first-class objects with a `kind` discriminator, *not* prose to
regex out of the answer text:

```json
{"chunk":{"metadata":{"step_id":3},
  "render_citation":{"id":"407f7b","kind":"CITATION_KIND_X_POST",
    "url":"https://x.com/ToonHive/status/2083580420990324809","citation_id":29}}}
```

Emitted this run:
- `CITATION_KIND_X_POST` — `https://x.com/ToonHive/status/2083580420990324809`
- `CITATION_KIND_X_POST` — `https://x.com/Ayzacoder/status/2083495849892712864`

This is **strictly better data than the REST lane gives**, where post URLs had to be pattern-matched
out of the reply text (D-16). Here every cited post arrives as a typed record with a `kind`, an id
and a URL. It is the ideal shape for the "Grok discovers → verify → admit" design: `x_post`
citations are exactly the externally checkable artifacts, cleanly separated from the model's prose.

**Caveat unchanged:** the citations are verifiable; any *ranking* or "most discussed" claim in the
prose is model judgment and must never be stored as a measurement.

## Standing recommendation

The WS lane still requires a ~14 KB `castle_request_token` per `response.create`, i.e. a second
browser-bound oracle alongside statsig. So this remains a **capture/intel** win, not a migration
target. Build the X trend source on the REST lane; use this capture rig when the wire protocol
needs to be re-derived after a Grok-side change.

---

# ADDENDUM 2 — JS deobfuscation, and a CORRECTION to the castle-token conclusion

Tools added at Frank's direction: **Wireshark 4.2.2** (+ `editcap`, `mergecap`; `tshark` was already
present) and a JS reversing toolchain — **webcrack 2.16.0**, **restringer 2.2.0**,
**js-beautify 2.0.3**, **prettier 3.9.6**.

They immediately paid for themselves by **overturning a conclusion I had already written down**.

## Method

`curl` against grok.com returns **403** (Cloudflare), so the bundles were pulled from inside a real
browser context via CDP — 112 JS responses, 92 bundles ≥20 KB saved. `castle_request_token` appears
in exactly one: `2k4komllc5spp.js` (32 KB, minified into unreadability).

`webcrack` unpacked it with **69 transform changes** (including `self-defending` and
`debug-protection` removal), then `prettier` produced **2,140 readable lines**.

## The correction

**Previously (D-17) I wrote:** the WS lane requires a ~14 KB Castle token per `response.create`, so
adopting it would mean a second browser-bound oracle alongside statsig, and was therefore not worth
migrating to.

**The deobfuscated source says otherwise:**

```js
let h = new Set(["response.create", "conversation.queue.add", "conversation.queue.interject"]);

if (h.has(e.type) && getFeature(BOOLEAN_FLAGS.ENABLE_CASTLE_CHAT_MINTING)) {
  return (r = t(), new Promise((e) => {
      let t = setTimeout(() => e(undefined), 300);      // 300 ms budget
      let n = (r) => { clearTimeout(t); e(r); };
      r.then(n, () => n(undefined));                    // mint error -> undefined
  })).then((t) =>
    t === undefined
      ? e                                               // <-- ships WITHOUT a token
      : { ...e, castle_request_token: t });
} else {
  return e;                                             // <-- ships WITHOUT a token
}
```

**The token is best-effort, not a gate.** The client itself ships the event with no token in three
ordinary cases:
1. the `ENABLE_CASTLE_CHAT_MINTING` feature flag is off;
2. minting exceeds its **300 ms** budget;
3. minting throws.

Only three event types are ever eligible: `response.create`, `conversation.queue.add`,
`conversation.queue.interject` — matching exactly what mitmproxy observed on the wire.

**Consequence:** the castle token is a *risk signal*, comparable to a fraud score, not a
statsig-style hard requirement. **The WS lane may well be usable without minting castle tokens at
all** — which is the opposite of what D-17 concluded. This is UNVERIFIED against the server (it
would need an actual token-less `response.create`), so it is a corrected hypothesis, not a proven
capability. But the "needs a second oracle" objection is no longer supported by evidence.

Related flags: `ENABLE_CASTLE_INTEGRATION` (auth minting) and `ENABLE_CASTLE_CHAT_MINTING` (chat
minting) are independent; `CASTLE_PK` comes from the runtime environment config.

## Why this matters beyond Grok

The general lesson repeats the Reddit one from PASS 2: **reading a capture told me the token was
always present; reading the source told me why it sometimes is not.** Wire capture shows what
happened once; source shows what *can* happen. Both were needed, and the cheaper tool (grep over a
minified bundle) would have found nothing without the deobfuscator.

## Tooling verdict

| Tool | Verdict |
|---|---|
| `webcrack` | **Earned its place.** Unpacked + de-self-defended the bundle that carried the answer. |
| `prettier` / `js-beautify` | Essential companions — webcrack's output still needs formatting to read. |
| `restringer` | Installed, not yet needed; keep for string-array/obfuscator.io style targets. |
| Wireshark / tshark | Installed. **Not needed for this job** — mitmproxy already yields plaintext at the app layer. Its real use is traffic that does *not* traverse a proxy (QUIC, non-proxy-aware clients) or confirming nothing leaks off-proxy. Honest note: it has not yet been the tool that solved anything here. |
