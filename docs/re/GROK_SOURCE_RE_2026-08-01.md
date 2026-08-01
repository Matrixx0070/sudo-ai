# grok.com — source-level reverse engineering, 2026-08-01

The earlier documents in `docs/GROK_WEB_*` were **traffic observation**: mitmproxy and CDP
recording what the UI happened to do. That is a floor, not a map. This one reads the
**shipped client source** instead, which is what actually defines the surface.

The difference is not marginal:

| method | endpoints found |
|---|---|
| traffic capture (2 browser sessions, 12 routes, ~2,500 requests) | **30** |
| source extraction (93 chunks, 16.9 MB) | **467** |

**15× more surface exists than the UI ever touched.** Full list:
[`grok-endpoints.txt`](./grok-endpoints.txt).

## Method

```bash
# 1. Pull the real bundles (curl_cffi — plain curl is Cloudflare-walled)
#    93 chunks referenced from https://grok.com/, 16.9 MB total.
# 2. Extract string literals matching /rest/* and /api/*.
# 3. Read call sites for the ones that matter — the generated API client
#    embeds each path, method, request body shape AND response shape.
```

Step 3 is the part traffic capture cannot give you: the client is generated from a schema,
so the **contract is in the source verbatim**, including fields the UI never sends.

Tooling present and used: `curl_cffi`, `webcrack`, `restringer`, `js-beautify`, `mitmproxy`.
**Burp Suite Community** is now installed at `/opt/BurpSuiteCommunity` (bundled JRE 25 —
the system's Java 17 is too old, so invoke the launcher, not `java -jar`):

```bash
DISPLAY=:10 /opt/BurpSuiteCommunity/BurpSuiteCommunity
```

## Subsystems that were completely invisible to traffic capture

- **`/rest/agent-sandbox/*`** — full sandbox lifecycle: `sessions`, `sessions/with-image`,
  `{id}/hibernate`, `/restore`, `/snapshot`, `/logs`, `/status`, `preview-token`,
  `shared-seed`, `fork-binding`.
- **`/rest/app-deployer/v1/*`** — app deployment: `projects`, `deployments`, `build-logs`,
  `custom-domains`, `env-vars:batchSet`, and notably **`projects/{id}/xai-api-key`**.
- **`/rest/sandbox_environments/*`** — environments, cache, `rebuild-cache`,
  `preinstalled-packages`.
- **`/rest/voice/*`** — far beyond TTS/STT: `grokcasts`, `saved-voices`, `voices/{id}/personality`,
  `voices/{id}/share-link`, `align`, `passphrase/{id}/verify` (voice enrolment), `top`, `search`.
- **`/rest/media/canvas/*` and `/rest/media/pipeline/*`** — a node graph and a template
  system with `create/fork/publish/rollback/save`.
- **`/rest/finance/*`** — `{ticker}/summary`, `/chart/{timespan}`, `/financials/{timeframe}`,
  `related_tickers`.
- **`/rest/github/*`** — installations, repositories, branches, `compare/{range}`,
  pull-requests.
- **`/rest/auth/*`** — ~35 endpoints incl. MFA start/finish, `link-account`, `list-teams`,
  `swap-account-credentials`, `create-anon-user`.

## Live-probed, and NEW quota surfaces the SDK did not know about

All cookie-only, `$0`, verified this session:

| endpoint | result |
|---|---|
| `/rest/tasks/usage` | `{frequentUsage:0, frequentLimit:10, occasionalUsage:0, occasionalLimit:30}` — **automation slots** |
| `/rest/assets/storage-usage` | `5,368,709,120` total / `64,366,123` used — **5 GB asset quota** |
| `/rest/usage/free-usage-gates` | `{chat,imagine,voice,build}` each `{allowance,remaining}` — anon-tier gates, all `0` on a subscribed seat |
| `/rest/auth/get-user-feature-controls` | `{allowNsfwContent:true, alwaysShowNsfwContent:true}` |
| `/rest/app-chat/tts-voices` | full voice catalogue (`altair`, `ara`, `atlas`, …) |
| `/rest/dev/models` | `403 access denied` — internal/admin only |
| `/rest/models` | `501 Method Not Allowed` on GET |

`tasks/usage` and `assets/storage-usage` are real budget dimensions alongside
`rate-limits`: an agent can exhaust **automation slots** or **5 GB of storage** without ever
touching the chat quota.

## `/rest/app-chat/run-code` — exists, free, and does not work

Contract, lifted verbatim from the generated client (`chatRunCodeRaw`):

```
POST /rest/app-chat/run-code
  body     { language, code }
  response { success, stdout, stderr, outputFiles }
```

This mattered because `coder.grok-run-code` currently rides **cli-chat-proxy and bills**,
while this path is on the free cookie lane. Tested live:

- `HTTP 200`, response shape exactly as the source declares
- **`quota spent: 0`** (measured `rate-limits` before/after)
- but `success:false`, `stderr:"An unexpected error occurred while executing your code."`

`language:"python"` is correct — it appears in the source alongside `node`, `bash`, `cpp`,
`typescript`, `ruby`, `javascript`, `java`, `go`, `rust`. Adding a minted `x-statsig-id`
changed nothing (same 200, same generic error).

**UNRESOLVED.** The endpoint answers, costs nothing, and refuses to execute. Untested
hypotheses: it needs a provisioned sandbox first (`/rest/agent-sandbox/sessions` or
`/rest/sandbox_environments/*`), it requires a conversation binding, or it is dead code
retained in the client. Worth one more pass, because a working free code lane would take
`coder.grok-run-code` off the metered path entirely.

## Why this matters for the SDK

The SDK models ~20 capabilities. The seat exposes **467 endpoints**. Anything built from
traffic observation alone was scoped to whatever the UI clicked that day — which is how
`agent-sandbox`, `app-deployer`, voice enrolment and the storage/automation quotas were all
missed. Source extraction should precede capability work, not follow it.
