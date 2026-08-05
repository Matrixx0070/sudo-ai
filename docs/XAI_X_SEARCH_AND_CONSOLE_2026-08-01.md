# xAI `x_search` API + console.x.ai surface — 2026-08-01

Written after Frank correctly pushed back: *"So you did not find any x search tool or api endpoints?
I think you're just capturing grok.com — also try console.x.ai."*

**He was right.** I had anchored on grok.com's chat UI and concluded "there is no X-search field, Grok
just decides." That conclusion is true *for grok.com*, and it is also the wrong place to have been
looking. xAI ships a **first-class, documented, callable X-search tool** on its own API. I missed it.

---

## 1. THE ANSWER — `x_search` is a real server-side tool

```
POST https://api.x.ai/v1/responses
Authorization: Bearer $XAI_API_KEY
```

```json
{
  "model": "grok-4.5",
  "input": [{ "role": "user", "content": "..." }],
  "tools": [{
    "type": "x_search",
    "allowed_x_handles": ["handle1"],       // max 20; mutually exclusive with excluded_
    "excluded_x_handles": ["handle2"],      // max 20
    "from_date": "2026-07-30",              // ISO8601
    "to_date":   "2026-08-01",
    "enable_image_understanding": true,
    "enable_video_understanding": true
  }],
  "max_output_tokens": 400
}
```

Note the predecessor is gone: the old Live Search API (`search_parameters`) was **retired
2026-01-12** and now returns `410 Gone`. The Agent Tools API (`tools: [{type: "x_search"}]`) is the
current path.

### Live probe — one call, verified

```
HTTP 200 | 22,987 ms
X POST URLS RETURNED: 3
   https://x.com/dee_naliaks/status/2083230488937087027
   https://x.com/ys_bappy/status/2082843793045553608
   https://x.com/SimplyAnnisa/status/2082721718397706584
citations field present: true
output item types: reasoning, custom_tool_call, custom_tool_call, reasoning, reasoning,
                   custom_tool_call, custom_tool_call, reasoning, reasoning, message
```

Real posts, real citations, structured `custom_tool_call` items. **This is the endpoint. It works.**

### Cost — measured, not estimated

The response self-reports usage. Decoded:

```
input_tokens 15,805 (9,088 cached) · output_tokens 1,337 · x_search_calls 4
cost_in_usd_ticks 441,824,000
```

Component math — cached 9,088 × $0.50/M + fresh 6,717 × $2/M + output 1,337 × $6/M +
4 tool calls × $0.005 = **$0.0460**, against `ticks/1e10` = **$0.0442**. They agree within a cent,
so **1 tick = 1e-10 USD** and **this call cost $0.0442**.

Published rates: `x_search` and `web_search` are **$5 per 1,000 invocations**; `grok-4.5` is
$2.00/M input, $6.00/M output (<200k), cached input $0.30–0.60/M.

**The budget warning that matters:** the agent chose to make **4 `x_search` calls for one
question**. Cost scales with the model's autonomous decisions, not with your request count. At this
rate hourly polling is **~$1.06/day ≈ $32/month** — materially more than the ~$7/month the official
X trends endpoint would cost, though it returns semantic results with citations rather than a bare
trend list.

Anything wiring this in **must** cap `max_tool_calls` and run under the enforced spend cap
(roadmap B6, still the top open P0), given `cost-tracker.checkBudget()` currently has zero callers.

---

## 2. How this reconciles with the grok.com finding

Both are true, and they are about different products:

| | grok.com (consumer/Business chat) | api.x.ai (developer API) |
|---|---|---|
| X search invocation | implicit — Grok decides; **no payload field** | **explicit** — `tools:[{type:"x_search"}]` |
| Controls | none | handles allow/exclude, date range, media understanding |
| Results | `render_citation` `CITATION_KIND_X_POST` in the WS stream | `custom_tool_call` + citations in JSON |
| Cost | covered by the seat subscription | metered, $5/1k tool calls + tokens |
| Auth | cookies + statsig (+ best-effort castle) | `XAI_API_KEY` bearer |

So the earlier work was not wrong, it was **incomplete**: it characterised the seat lane correctly
and never asked whether the metered API exposed the tool explicitly. It does.

**Practical consequence:** there are now *two* viable X sources —
- **seat lane (grok.com), $0 marginal** — no controls, Grok decides when to search;
- **API lane (api.x.ai), ~$0.044/query** — precise handle/date filtering, deterministic invocation.

For a trend scanner the seat lane is the cheap default; the API lane is worth it when you need
*specific handles* or a *date window*, which is exactly what competitor-monitoring wants.

---

## 3. console.x.ai — captured surface

Logged in as the `enchilada-latch-nullify` team. **The team id is
`56504cd4-01d0-49a9-9a6b-88ebbc2b36c7` — the same id that appears as `scopeId` in grok.com's
`/rest/mcp/discovered-tools/list` calls**, confirming the Grok Business seat and the xAI console are
the same tenant.

The console is a Next.js RSC app (117 RSC requests; data arrives in the component stream, not a REST
API). Its real API is **gRPC-web** (`content-type: application/grpc-web+proto`):

| RPC | Purpose |
|---|---|
| `prod_mc_billing.UISvc/AnalyzeBillingItems` | line-item spend for a date range; req carries `2026-07-03 00:00:00`→`2026-08-01 23:59:59`, `usd`, groupings `items`/`units`, team id |
| `prod_mc_billing.UISvc/GetAmountToPay` | current amount owed, broken out per line item |
| `prod_mc_billing.UISvc/ListPrepaidBalanceChanges` | prepaid balance ledger + invoice codes |
| `auth_mgmt.AuthManagement/GetTeam` | team + member metadata |
| `auth_mgmt.AuthManagement/ListUserInvitations` | pending invites |
| `console.x.ai/api/observability/client-metrics` | the only plain-JSON endpoint (telemetry) |

### The finding that matters for the money guard

The `GetAmountToPay` response body contains, in plaintext among the proto:

```
us-west-2 API grok-4.5 X searches
us-west-2 API grok-4.5 Reasoning text tokens
us-west-2 API grok-4.5 Completion text tokens
us-west-2 API grok-4.5 Prompt text tokens
File Storage (MB-minute)
```

**`X searches` is billed as its own line item.** So spend from `x_search` is independently
observable — which is exactly the hook the standing money guard needs (memory:
*"NEVER xai-oauth on brain chain without console.x.ai check"*, after cli-chat-proxy once billed
~$80/day).

**UNVERIFIED / not built:** reading these programmatically needs the protobuf schemas or careful
grpc-web frame parsing. The endpoints and request shapes are known; the decode is not done. That is
a concrete, bounded next step for automating the money guard rather than eyeballing the console.

No credentials, balances, emails or invoice codes are recorded in this document.

---

## 4. Honest scorecard

- **Missed it initially.** Frank's push was correct and cost me an hour of grok.com spelunking that
  answered a narrower question than the one that mattered.
- The grok.com work still stands and is still useful (WS protocol, typed citations, castle
  best-effort correction), but it was the wrong place to *start*.
- General lesson, third instance this session after Reddit and castle: **check the vendor's own
  documented API before reverse-engineering their UI.** Reverse engineering is the fallback, not the
  opening move.
