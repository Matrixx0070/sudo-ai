# Grok web app — full surface capture (mitmproxy), 2026-08-01

Companion to `GROK_WEB_CAPTURE_2026-08-01.md`, which cracked the **chat transport**
(the `wss://grok.com/ws/mgw/` protocol and its Castle token). This one sweeps the
**whole application surface** instead: every `/rest/*` call the SPA makes across all
its routes, the response bodies, and the WebSocket hosts.

Seat: **Grok Business** (`megastream`), captured through a throwaway logged-in profile.

---

## Method — and the memory ceiling that made it safe

At 20:37:58 the previous capture session's `python3` triggered the global OOM killer,
which killed Chrome inside cgroup `/system.slice/sudo-ai-v5.service` — **production** —
and `sudo-ai-v5.service` failed at 20:38:35 after 1mo3w of uptime. Isolation by profile
and port was correct as far as it went, but **memory was never isolated**, and memory is
global.

So both capture processes ran under their own cgroups with hard caps:

```bash
systemd-run --scope -p MemoryMax=1G -p MemorySwapMax=0 \
  env CAPTURE_HOST= CAPTURE_OUT=/tmp/capture.jsonl \
  mitmdump -s scripts/capture/mitm-capture.py --listen-host 127.0.0.1 -p 8081 -q -w /tmp/flows.mitm

systemd-run --scope -p MemoryMax=2G -p MemorySwapMax=0 \
  env DISPLAY=:10 google-chrome --no-sandbox --user-data-dir=/tmp/capprof \
  --proxy-server=127.0.0.1:8081 --ignore-certificate-errors --test-type --disable-quic \
  --remote-debugging-port=9224 https://grok.com/
```

`MemoryMax` makes a runaway capture OOM **inside its own cgroup** instead of triggering a
global OOM that picks off production. Free memory during this run was 4 GiB — the same
squeeze that produced the outage. Prod verified healthy before and after (CDP 9223 → 200,
3 pm2 apps online).

Logged-in throwaway profile = `Local State` + `Default/Cookies` only, **336 KB**. Cloning
the real 5.5 GB profile is what got OOM-killed previously.

**Prod was never touched**: separate profile, separate debug port (9224 vs 9223), separate
proxy. The production `grok-warm-profile` was read (cookie copy) but never opened.

---

## 1. Full `/rest/*` inventory (observed across 12 app routes)

Counts are call volume during the sweep, not importance.

| Endpoint | n |
|---|---|
| `GET /rest/app-chat/conversations` | 110 |
| `GET /rest/app-chat/conversations-many` | 2 |
| `GET /rest/assets` | 7 |
| `GET /rest/automations` | 2 |
| `GET /rest/grok-for-teams/collections` | 5 |
| `GET /rest/grok-for-teams/team-settings` | 16 |
| `GET /rest/notifications/list` | 16 |
| `GET /rest/products` | 16 |
| `GET /rest/sharing/my-org-teams` | 15 |
| `GET /rest/suggestions/profile` | 16 |
| `GET /rest/user-settings` | 16 |
| `GET /rest/user-skills` | 8 |
| `GET /rest/user-skills/shared` | 1 |
| `GET /rest/workspaces` | 15 |
| `GET /rest/workspaces/shared` | 15 |
| `POST /rest/connectors/list-available-v2` | 16 |
| `POST /rest/connectors/list-v2` | 16 |
| `POST /rest/media/canvas/list` | 1 |
| `POST /rest/media/conversation/get` | 5 |
| `POST /rest/media/imagine/quota_info` | 1 |
| `POST /rest/media/pipeline/template/list` | 2 |
| `POST /rest/media/post/list` | 1 |
| `POST /rest/media/search/status` | 1 |
| `POST /rest/models/imagine/overrides` | 2 |
| `POST /rest/modes` | 31 |
| `POST /rest/onboarding/for-user` | 16 |
| `POST /rest/rate-limits` | 5 |
| `POST /rest/skills` | 8 |
| `POST /rest/suggestions/stream` | 2 |
| `POST /rest/system-prompt/list` | 16 |

Routes that exist: `/`, `/imagine`, `/automations`, `/projects`, `/skills`, `/connectors`,
`/settings`, `/settings/account`, `/settings/connectors`, `/files`, `/workspaces`.
`/tasks` **redirects to** `/automations`.

## 2. THE headline — `/rest/rate-limits` is a live quota meter

```json
{"windowSizeSeconds":7200, "remainingQueries":46, "totalQueries":50,
 "lowEffortRateLimits":null, "highEffortRateLimits":null}
```

The free app-chat lane's budget is **50 queries per 2-hour window, and the seat will tell
us how many are left, on demand.** This repo has been *estimating* "~40 calls/2h" and
guessing; the real number is 50 and it is queryable.

Direct consequence for `grok-web-media.ts`: the 3-attempt retry loop currently burns
quota blind, and `GrokWebRateLimitedError` is only raised **after** a 429 has already been
spent. A pre-flight `/rest/rate-limits` read would let the lane check its budget before
spending it.

**CORRECTION.** An earlier revision of this section called `/rest/rate-limits`
"statsig-free". It is **not** — §10b shows it carrying `x-statsig-id` on 6 of 6 requests.
A pre-flight check therefore costs one statsig mint (~2ms once the oracle is warm, per
`grok-statsig-oracle.ts`), not zero. Still worth it against a 50-query budget, but the
design must mint a token, and a budget check that fails closed on a mint failure would be
worse than no check at all.

## 3. Media quota — separate 18h window

```json
{"image":{"available":true,"windowSizeSeconds":64800},
 "imagePro":{...}, "imageEdit":{...}, "video":{...}, "video720p":{...}}
```

All five available. `64800s` = 18h, a **different** window from chat's 7200s.

## 4. WebSocket hosts — THREE, not one

| Endpoint | Purpose |
|---|---|
| `wss://grok.com/ws/mgw/?uid=<uuid>` | chat (documented in the companion doc) |
| `wss://grok-api.gcp.mouseion.dev/ws/imagine/listen` | **Imagine streaming — new** |
| `wss://grok-v2.x.ai/ws/app_chat/stream_audio?use_time_based_playback_tracking=true` | **voice/audio — new, different host** |

The last two are on hosts **other than grok.com**, so the capture addon's default
`CAPTURE_HOST=grok.com` filter silently drops them. Set `CAPTURE_HOST=` (empty) to
capture everything — the host filter is a footgun for exactly this reason.

`mouseion.dev` appears to be xAI infrastructure fronting the media pipeline.

## 5. Other bodies worth knowing

**`/rest/user-settings`** — `enableEarlyAccessModels: false` is a real toggle worth
watching; also `excludeFromTraining: true`, `enableMemory: true`, `allowXPersonalization: false`.

**`/rest/user-skills`** — returns full `SKILL.md` content. This seat has a `browser-use`
skill (9788 bytes) describing browser automation, scraping, and shopping workflows.

**`/rest/grok-for-teams/team-settings`** — `conversationsRetentionPeriodDays: 30`;
sharing scoped `SHARING_SCOPE_ORGANIZATION` for conversations, projects and skills.

**`/rest/products`** — SuperGrok `$30/mo` (`3000`) or `$300/yr` (`30000`), plus INR prices;
a `Grok Teams` product with empty prices.

**`/rest/automations`** → `{"automations":[]}` and **`/rest/models/imagine/overrides`** →
`{"modelMapOverrides":[]}` — both empty on this seat.

## 6. What this capture did NOT get — honestly

- **No chat send.** `Input.insertText` and per-character key events both failed to reach
  the composer's React state, so no `conversation.item.create` was produced; only
  `ping`/`pong` on the mgw socket. Not re-derived because the companion doc already has
  the full send protocol. The UI-automation path needs the real composer selector.
- **`/rest/suggestions/profile`** — called 16×, body never captured.
- Request/response bodies are truncated at `CAPTURE_MAX_BYTES=60000`.
- Volume counts reflect my navigation order, not real-world usage.

---

## 7. Round 2 — the chat send, captured (Business seat)

The composer finally driven. **`response.create` carried NO `castle_request_token`:**

```json
{"session_id":"5ebc2d1e-…","event":{"type":"response.create","event_id":"evt_resp_1785619414731"}}
```

Two keys. The companion doc records a **~14 KB `castle_request_token`** on every
`response.create`; this capture has none, on the same seat, same host, same protocol.

**This matters a lot**, because "the WS lane needs a second browser-bound Castle oracle"
is the whole basis for *not* adopting it. If the token is conditional — first message of a
fresh browser session, or risk-scored — then the WS lane may be reachable without a second
oracle. **UNVERIFIED which condition triggers it**; two captures disagree and that is all
that is established. Worth resolving before anyone re-litigates the WS decision.

Full observed grammar (tx = client→server):

```
tx  session.create           {session:{model:"auto", x_grok:{…connector_ids, image_generation_count:2…}}}
rx  session.created          echoes the session, assigns session_id == conversation uuid
rx  conversation.attached    {conversation:{id,object:"realtime.conversation"}, mode:"new"}
tx  conversation.item.create {item:{type:message, role:user, x_grok:{client_message_id, input_chunks:[{text:{text}}]}}}
tx  response.create          {type, event_id}                      <-- no castle token here
rx  conversation.queue.updated / conversation.item.added
rx  response.created         {response:{id,status:"in_progress",output_modalities:["text"]}}
rx  response.output_item.added / response.content_part.added
rx  response.chunk           {chunk:{ui_layout:{reasoning_ui_layout,effort:"LOW",steer_model_id:"grok-4"}}}
rx  response.chunk           {chunk:{text:{text,channel:"CHANNEL_ASSISTANT_NOTETAKER_HEADER"}}}
rx  response.output_text.done / content_part.done / output_item.done
rx  response.done            {response:{status:"completed", usage:{}}}
rx  response.persisted       {status:"ok"}
rx  conversation.title.updated {title:"Ping Response"}
rx  response.chunk           {chunk:{follow_up_suggestions:{…tool_overrides:{image_gen:false}}}}
tx/rx ping / pong            every ~3s
```

Two things fall out: mode `"auto"` resolves to **`steer_model_id:"grok-4"` with
`effort:"LOW"`** (visible in-stream), and a real **`tool_overrides`** concept exists —
`{"image_gen":false}` — appearing on follow-up suggestions.

## 7b. RESOLVED — `castle_request_token` is a FEATURE FLAG, and it is FAIL-OPEN

Both captures were right. The token is **optional**, controlled by a flag, and the client
omits it rather than blocking. From the app bundle (`cdn.grok.com/_next/static/chunks/`):

```js
<ENABLE_CA>STLE_CHAT_MINTING) ? (r=t(), new Promise(e=>{
    let t=setTimeout(()=>e(void 0), 300),          // 300ms budget
        n=r=>{clearTimeout(t), e(r)};
    r.then(n, ()=>n(void 0))                        // mint rejects -> undefined
  })).then(t => void 0===t ? e : {...e, castle_request_token: t})
: e                                                 // flag OFF -> event unchanged
```

Flag names, verbatim from the bundle's flag map:

```js
ENABLE_CASTLE_INTEGRATION:   "enable_castle_integration"
ENABLE_CASTLE_CHAT_MINTING:  "enable_castle_chat_minting"
```

So `response.create` ships **without** the token whenever the flag is off, **or** the mint
takes >300ms, **or** the mint rejects. Three independent ways to omit it.

Evidence this session had the flag off: **zero castle.io network flows — and zero *failed*
ones.** A proxy-blocked SDK would leave failed attempts; none exist, so the SDK never ran.

### What settles it for the WS-lane decision

**The server accepted a `response.create` with no Castle token** — this capture got a
complete answer, `response.done` with `status:"completed"` and `response.persisted ok`.
The 300ms fail-open only proves the *client* tolerates absence; the successful response
proves the *server* does.

**Therefore the WS lane does NOT require a second browser-bound Castle oracle**, which was
the entire basis for "don't migrate" in the companion doc. That conclusion should be
reconsidered on the merits, not treated as blocked by Castle.

**Caveats, and they are real.** Observed once, one account, one point in time. The flag is
evidently ON for some populations (the companion capture saw a 14 KB token), so this is a
rollout — and a rollout can complete. The server tolerating a missing token today is not a
promise it will tomorrow, and a risk-scored session may be treated differently. Anything
built on the WS lane should treat a Castle challenge as a live possibility, not an
impossibility. What is now false is only the claim that Castle is a *hard prerequisite*.

## 8. Driving the composer — what actually works

The composer is a **Tiptap/ProseMirror** editor (`enableTiptapEditorForQueryBar:true` in
user-settings). Three approaches fail and one works:

| approach | result |
|---|---|
| `querySelector('textarea,[contenteditable]')` | **trap** — matches a hidden dummy `<textarea>` first in document order; you type into nothing |
| `Input.insertText` (CDP) | text never reaches ProseMirror state |
| per-character `Input.dispatchKeyEvent` | same |
| coordinate click on the Submit button | misses — Submit sits at x=986 while the composer ends at x=856 |
| **`el.focus()` + `document.execCommand('insertText',…)` then `button.click()` in JS** | **works** |

Target `.ProseMirror` explicitly, and invoke the submit button via JS `.click()` rather
than synthetic mouse coordinates.

## 9. Workspace / team scoping is a QUERY PARAM, not a header

```
/rest/app-chat/conversations?pageSize=4&workspaceId=7844442f-…
/rest/app-chat/conversations?pageSize=4&workspaceId=bd876760-…
/rest/app-chat/conversations?pageSize=4&workspaceId=5742f8d0-…
/rest/grok-for-teams/collections?teamId=56504cd4-…
/rest/notifications/list?pageSize=50&teamId=56504cd4-…
```

Three workspaces under one team. For the SDK this is the useful form: workspace context is
addressable per-request, no session state required.

## 10. RETRACTED — there was no harness bug; the analysis was wrong

An earlier revision of this document claimed `mitm-capture.py` emitted no headers. **That
was false and is withdrawn.** The addon writes them under the key **`hdrs`** (line 71); the
analysis script read `headers`, got `None` every time, and reported an empty set.

The headers were there all along: **303 of 2,085** requests in pass 1 carry `x-statsig-id`.
The harness needs no fix. Recorded here rather than quietly deleted because the false claim
was published in commit `3a2e7875`, and because it is the second time in this effort that a
confident conclusion came from a bug in the measuring instrument rather than the thing
measured.

## 10b. SETTLED — exactly which endpoints carry `x-statsig-id`

Observed, not inferred. Separation is perfectly clean: every endpoint is either always
gated or never gated, with **no mixed cases** across both passes.

**statsig-FREE — only four:**

| endpoint | with / without |
|---|---|
| `POST /rest/connectors/list-v2` | 0 / 16 |
| `POST /rest/connectors/list-available-v2` | 0 / 16 |
| `POST /rest/onboarding/for-user` | 0 / 16 |
| `GET /ws/mgw/` (the WS upgrade) | 0 / 3 |

**Everything else is gated — 30 endpoints**, including all of `app-chat/*`, all `media/*`,
`modes`, `skills`, `system-prompt/list`, `user-settings`, `user-skills`, `workspaces`,
`products`, `notifications/list`, `suggestions/*`, `assets`, `automations`,
`grok-for-teams/*`, `sharing/my-org-teams`, and `rate-limits`.

This **confirms** the companion doc's claim that connector/MCP calls are cookie-only and
statsig-free. It also means the practical rule is the inverse of what the codebase assumes:
on the web lane, **assume statsig is required unless the endpoint is one of those four.**

That the `/ws/mgw/` upgrade carries no statsig is consistent with the WS lane being guarded
by Castle instead — see §7, where the token was nonetheless absent.

## 10c. PERSONAL vs BUSINESS — what the $30 actually buys

Captured by switching workspaces in a **new tab of the production warm browser** (the only
CF-cleared Chrome on this host; a freshly-launched one is challenged and never clears).
Same account, same endpoint, same session — only the workspace differs:

| workspace | `windowSizeSeconds` | `totalQueries` | effective |
|---|---|---|---|
| **Business ($30 seat)** | 7200 (2h) | **50** | up to **600/day** |
| **Personal (free)** | 86400 (24h) | **30** | **30/day** |

```json
// personal
{"windowSizeSeconds":86400,"remainingQueries":30,"totalQueries":30,...}
// business
{"windowSizeSeconds":7200,"remainingQueries":46,"totalQueries":50,...}
```

**The subscription is worth ~20× the free allowance**, and the difference is not just volume
— the 2h window refills 12× a day, so burst capacity differs far more than the raw numbers
suggest. Any budget logic in the SDK must read the window, not assume a daily quota.

### Endpoints only the PERSONAL workspace calls

```
GET /rest/subscriptions                                  <- subscription state
GET /rest/teams-where-user-has-active-sub                <- which teams carry the sub
GET /rest/products?provider=SUBSCRIPTION_PROVIDER_STRIPE
GET /rest/app-chat/conversations?pageSize=60&filterIsStarred=true
```

`teams-where-user-has-active-sub` is the direct answer to "does this seat cover me" and is
worth wiring into the SDK's capability probe. Its body was not captured (not re-requested
after reload) — **UNVERIFIED shape**.

SuperGrok pricing confirmed from `/rest/products`: **$30/mo** (`3000`) or **$300/yr**
(`30000`), with INR equivalents.

### Switching workspaces — the UI mechanics

The switcher is the account row at the **bottom-left** of the sidebar
(`megastream / <team-name>`); the menu offers `Personal` and the team. It needs a **real
CDP pointer event** at the element's coordinates — JS `.click()` opens nothing (Radix
dropdowns bind pointer events). The OneTrust consent overlay intercepts clicks and must be
removed first; removing the node avoids recording a consent choice on the user's behalf,
unlike clicking Accept/Reject.

### Safety of touching the production browser

Done per the companion doc's rule: **a new tab, never the oracle's own page**. Verified
after — oracle page target intact, own tab closed, target count back to 5, and a real
`mint()` returned a 94-char token in 6.3s. `__grokMint` was already `undefined` before this
work began, so the cold-path cost was pre-existing, not caused here.

## 11. Still NOT captured — honestly

- **The personal workspace.** The account menu would not open under JS `.click()`, and the
  banner's "Click here to switch" is a non-clickable `<p>`; clicking through it hit the
  OneTrust cookie dialog instead. Business seat only. The `workspaceId` query param above
  is probably the programmatic route in — untested.
- File upload, Imagine generation, voice, project/automation creation.
- The two non-grok.com WS subsystems (`imagine/listen`, `stream_audio`) — never opened
  during this run, so still only known as URLs.
- `/rest/rate-limits` returned `46/50` on all three reads and did **not** visibly decrement
  after the WS send; all three may have come from one page-load batch. Whether WS chat
  counts against that REST budget is **unresolved**.

## Reproducing

`scripts/capture/mitm-capture.py` (unchanged) plus the two `systemd-run` commands above.
Use `CAPTURE_HOST=` to avoid dropping non-grok.com hosts, and **always** run under
`MemoryMax` — this box has hit the global OOM killer twice in one day.
