# console.x.ai — authenticated capture, 2026-08-01

Companion to `GROK_WEB_SURFACE_CAPTURE_2026-08-01.md` (the grok.com $30 seat). This is the
**metered** side, captured so the two can be compared directly.

**PII NOTE:** the billing page exposes a cardholder name, billing email and postal address.
They are deliberately **not** recorded here — this repo is a candidate for open-sourcing.
Same for full API-key values; only the labels are kept.

---

## The connection that matters

`console.x.ai` resolves to team **`56504cd4-01d0-49a9-9a6b-88ebbc2b36c7`** — the **same team
id** that appears in the grok.com capture (`/rest/grok-for-teams/team-settings`,
`/rest/notifications/list?teamId=`). The $30 Grok Business seat and the metered API console
are the same team, not separate accounts.

| | grok.com seat | console.x.ai API |
|---|---|---|
| billing | flat $30/mo | per-token, metered |
| budget | **50 queries / 2h**, queryable via `/rest/rate-limits` | credit balance + spend tiers |
| gate | `x-statsig-id` (30 of 34 endpoints) | `Authorization: Bearer xai-…` |
| observed cost | $0 beyond subscription | $161.20 invoiced |

## ⚠️ BILLING IS FAILING — three consecutive invoices

| Reference | Date | Amount | Status |
|---|---|---|---|
| `ANN2-WYC7-WHV4` | 7 Jul 2026 | $47.80 | **Failed** |
| `VVAS-RZ2E-YXD3` | 4 Jun 2026 | $30.47 | **Failed** |
| `QFME-GBHE-K9YU` | 3 May 2026 | $460.65 | **Failed** |

~**$539 unpaid across three months.** Credits remaining `$149.97`; invoiced spend `$161.20`.

### RETRACTED — this did NOT cause the free-lane revocation

An earlier revision said the failed invoices "plausibly explain"
`project-xai-free-lane-revoked`. **Investigated, and that is wrong.**

| date | event |
|---|---|
| 3 May / 4 Jun / 7 Jul | the three invoices fail |
| **25 Jul** | `grok-4.5-build-free` **proven working at cost 0** |
| 26 Jul – 1 Aug | **20,884 API requests served**, $0.26 |
| 31 Jul | free variant 404s; `grok-4.5` meters |
| 1 Aug | subscription **ACTIVE**, Tier 3, $149.97 credits |

Two independent disproofs:

1. **The free lane still worked on 25 July** — 18 days after the most recent failed invoice
   and nearly three months after the largest. A revocation caused by those payments would
   have landed in May, not late July.
2. **The metered API kept serving 20,884 requests through 26 Jul–1 Aug**, i.e. after all
   three failures, and the subscription still reports `SUBSCRIPTION_STATUS_ACTIVE` today. A
   suspended account does not serve requests.

So the original conclusion in `project-xai-free-lane-revoked` stands: this was an **xAI
entitlement/product change** — a free-tier API grant that ended — not account punishment.
The 404 text names whichever team the token belongs to, so *both* teams see it; it was never
specific to one account's standing.

**The unpaid invoices remain a real and separate problem.** ~$539 outstanding is its own
risk, and the move from card invoices to prepaid credits is consistent with a card that
stopped working. It simply is not the cause of the lane going away.

## Rate-limit tiers (metered lane)

```
Tier 0  $0        Tier 1  $50      Tier 2  $250     Tier 3  $1,000    Tier 4  $5,000
"Spend $4,345 more to unlock Tier 4."
```

Tiers are **cumulative spend**, so the team sits at Tier 3 with roughly **$655** lifetime
spend. Tiers apply to **text models only**; Voice and Imagine increases go through
sales@x.ai.

## Usage (7 days, to 1 Aug 2026)

```
Spend $0.26   (-98.5% w/w)     Tokens 257,892     Requests 20,884
  Text            $0.26   prompt 129.9K ($0.17) / completion 18.2K ($0.05)
  Image & Video  <$0.01
  Grok Build     <$0.01
  Voice           $0.00
```

20,884 requests for $0.26 — the metered lane is being used, but for almost nothing. The
-98.5% drop is consistent with the free-lane revocation plus the money-guard work.

## Models offered (cluster `us-east-1`)

- **Grok 4.5 Code** — 500K context, agentic software/engineering
- **Grok 4.3 Chat** — **1M context**
- **Imagine Video 1.5** — text + image → video
- **Voice Agents** — real-time, reachable via phone number

## API keys (labels only)

Four keys, all created by this account: `Sudo vision` (3 days ago), `Sudo ai` (20 days),
`xAI Chat Playground` (20 days), `xAI Imagine Playground` (24 days).

Key permission model, from the console bundle:

```
permissions_type: "scoped-endpoints" | "scoped-models" | "scoped-all"
has_rate_limit: bool, has_expiry: bool, expiry_days: number|null
```

Auth methods enum: `INVALID=0, BASIC=1, API_KEY=2, OAUTH2=3`.

## Console surface

Nav: Dashboard · API Keys · Models · Usage · Logs · API Code · Chat · Image · Video ·
Voice · Agents (Beta) · Voice Storage · Batches · Platforms.
Settings tabs: Team · General · Billing · Rate Limits · Observability · Team members ·
Security · Domains · Audit Log · Management Keys · Personal.

All routes are `/team/<team-id>/…`. The app is Next.js and renders data into the page
payload — there is **no separate `/api/` JSON surface** to scrape; the only `/api/` calls
observed were `POST /api/observability/client-metrics` and `POST /api/log` (telemetry).
Extracting rendered text via CDP is more reliable here than intercepting requests.

Feature flags seen in the bundle: `api_keys_enabled:true`, `imagine_enabled:true`,
`console_org_enabled:false`, `console_org_switcher_enabled:false`,
`console_imagine_templates_enabled`.

## Round 2 — full settings surface (Google-authenticated session)

Real route slugs, read from the DOM rather than guessed (three earlier guesses 404'd):

```
/team/<id>/settings/{team, billing, rate-limits, observability, users,
                     security, domains, audit, management-keys, account}
```

### CORRECTION to "the same team"

The earlier claim that the $30 seat and the console are "one team" needs refining.
The console team self-describes as **"Personal team to get started with the xAI API"**,
and the Users page carries a distinct link: *"Looking for Grok Business? Manage your
licenses and user's access to Grok Business."*

So the team id is shared, but **Grok Business seat licensing is a separate surface** from
the metered API team. Same entity, two billing relationships — not one merged account.

### Findings

- **Team** — created 1 Aug 2025, 2 members. **Zero Data Retention (ZDR) is available but
  currently blocked**: *"Delete your collections to enable ZDR."* Directly relevant to this
  repo's zone invariants — ZDR is reachable if collections are cleared.
- **Users** — 2 members (a service-style account and the owner). No pending invitations.
- **Security** — all three controls **off**: MFA not enforced, API-key restrictions not
  required, no IP allowlist. Each is available to enable.
- **Domains** — none verified.
- **Audit log** — populated, filterable by Accounts / Models, with actor + operation +
  entity per event. A real audit trail exists for anything the SDK does with a key.
- **Management keys** — **none exist** (distinct from API keys; they administer the team).
- **Observability** — E2E latency **p90/p50 22.72s**, TTFT **327ms**, avg request size
  2.1K tokens (+600%). The 22.7s end-to-end against a 327ms first token means generation
  length, not connection setup, dominates.

## Method notes

Auth came from **`/root/chrome_profile`**, which holds the live `sso` + `sso-rw` cookies on
`.x.ai`. Three profiles were checked first; `/root/.config/google-chrome` looked like the
obvious choice and was a **dead end** — 28 cookies, no session at all. Worth remembering:
enumerate profiles by cookie content, not by which one looks canonical.

`mitmdump` was OOM-killed at its 1 GB cgroup cap mid-sweep
(`constraint=CONSTRAINT_MEMCG`) — **the cap worked exactly as intended**: it died alone and
production was untouched, in contrast to the earlier *global* OOM that took prod down. The
memory hog was the `-w` flow archive; dropping it and raising the cap to 2 GB was stable.
