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
spent. A pre-flight `/rest/rate-limits` read (cookie-auth, and **statsig-free** — it is not
on the gated path) would let the lane check its own budget before spending it.

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

## Reproducing

`scripts/capture/mitm-capture.py` (unchanged) plus the two `systemd-run` commands above.
Use `CAPTURE_HOST=` to avoid dropping non-grok.com hosts, and **always** run under
`MemoryMax` — this box has hit the global OOM killer twice in one day.
