# ADR 0012 — Which OpenClaw *patterns* sudo-ai adopts (and which it does not)

- **Status:** Proposed — 2026-08-06
- **Deciders:** Frank (owner)
- **Related:** ADR 0010 (extension contract + single authority — D1/D2/D3 shipped),
  ADR 0011 (identity root vs state root — in flight), ADR 0005 (tool sprawl),
  ADR 0009 (memory-write sprawl)
- **Reference codebase:** `/root/openclaw-study/openclaw` @ `package.json:3` version
  `2026.6.2` — read-only, 2026-08-06
- **Owner's hard constraint:** *"I think in that way no one say it Frank product,
  everyone say it's an OpenClaw fork."* Nothing here vendors OpenClaw code or renames
  their modules into ours. Each item below extracts a **design decision**, then states
  how *our existing* structure evolves into it. Where our structure already expresses
  the decision, the answer is "extend it", not "add a subsystem" (doctrine #6).

## Method note (so the claims are auditable)

Every OpenClaw claim below cites a file:line I opened in this session. Every sudo-ai
claim cites a file:line in this worktree. Two claims of *absence* were made with a
positive control on the same instrument (noted inline) because an empty grep is not
evidence. Anything I did not verify is listed under **Not verified**.

## Problem

ADR 0010 established the diagnosis (no extension contract; facts restated at every use
site) and shipped three of its four decisions. ADR 0011 covers the state/identity root
split. That leaves the questions this ADR was asked: **provider integration**,
**wake/scheduling**, **config typing**, and — the part that matters in twelve months —
*what is the unit of extension when new providers appear monthly and the thing adding
them is a model, not a human?*

The forward-looking framing that drives the ranking:

> A capability should be added by emitting **data validated against a schema**, not by
> threading **code** through a composition root. A model twelve months out will be
> excellent at the first and still unreliable at the second, because only the first has
> a mechanical failure signal.

That is the single design decision worth taking from OpenClaw. Everything below is an
instance of it.

---

## Findings

### F1 — OpenClaw keys its LLM adapter registry by **wire protocol**, not by vendor

`packages/llm-core/src/types.ts:6-15` declares exactly **nine** known APIs —
`openai-completions`, `mistral-conversations`, `openai-responses`,
`azure-openai-responses`, `openai-chatgpt-responses`, `anthropic-messages`,
`bedrock-converse-stream`, `google-generative-ai`, `google-vertex`. `types.ts:18`
(`Api = KnownApi | (string & {})`) admits ids outside that set, and the `ollama`
extension uses one (`extensions/ollama/openclaw.plugin.json:73`, with its own
`extensions/ollama/src/stream.ts`).

`packages/llm-runtime/src/api-registry.ts:77-90` is the whole registry: a
`Map<string, provider>` keyed by that api id, with `sourceId` ownership so
`unregisterApiProviders(sourceId)` (`:103-109`) can unload one plugin's adapters
cleanly. Core registers **eight** of the nine in one function,
`src/llm/providers/register-builtins.ts:342-411`; the ninth
(`bedrock-converse-stream`) is registered by an extension like any third-party one —
`extensions/amazon-bedrock/register.sync.runtime.ts:7` imports the same
`registerApiProvider` from `openclaw/plugin-sdk/llm`. **Core's own adapters use the
plugin seam, so the seam cannot rot.**

The payoff is measurable. Across `extensions/*/openclaw.plugin.json` there are **37**
provider declarations naming a wire api; **27 of them say `openai-completions`**
(counts: 27 / 5 anthropic-messages / 2 openai-responses / 1 openai-chatgpt-responses /
1 azure-openai-responses / 1 ollama). Cerebras — a whole provider — ships **zero
transport code**: `extensions/cerebras/openclaw.plugin.json` is a manifest declaring
`baseUrl`, `"api": "openai-completions"`, four model rows with price/context/modality,
one env var, and one auth choice; `extensions/cerebras/index.ts:10` is a single
`defineSingleProviderPluginEntry({...})` call (`src/plugin-sdk/provider-entry.ts:221`).

**Design decision:** *provider = data; wire protocol = code.* N providers, 8 adapters.

### F2 — sudo-ai already has both halves of F1, wired by hand rather than by table

We are much closer than ADR 0010's framing suggests. `src/llm/transport.ts:232`
`resolveRoute()` already dispatches on a `family` field that **is** a wire protocol —
`'anthropic'`, `'xai-responses'`, openai-compat otherwise (see the family branches at
`transport.ts:560`, `539`, and the parser switch at `transport.ts:673-674`). And
`src/llm/custom-providers.ts:31` already exposes an operator-facing
`adapter: 'openai' | 'anthropic' | 'google'` seam driven by `SUDO_CUSTOM_PROVIDERS`,
consumed at `transport.ts:297-310`, so an operator *can* add an OpenAI-compatible
endpoint with no code change at all.

What is hand-wired is the **built-in** set. Adding a first-class openai-compat provider
today is four edits in lockstep, in three files:

| edit | file:line |
|---|---|
| base URL | `src/llm/endpoints.ts:14-21` `PROVIDER_BASE_URLS` |
| API-key env | `src/llm/client.ts:117` `ProviderKeyName = keyof PROVIDER_KEY_ENVS` |
| route membership | `src/llm/transport.ts:121` `OPENAI_COMPAT_BUILTINS` (also read at `:283` and `:430`) |
| catalog row | `src/llm/model-catalog.ts` builtin table |

Two providers already escaped that table into bespoke branches: `ollama`
(`transport.ts:285-287` for the URL, `:421-424` for a hardcoded `Bearer ollama`) and
`google` (`transport.ts:288-296`, `:425-429`). Both are exactly the *"same shape,
special-cased"* pattern the OpenClaw table removes.

**A second, sharper defect.** `src/llm/model-catalog.ts:267-268` exports
`registerCatalogRows()` — the config/runtime-authority seam that ADR 0010's D2 built so
higher-authority rows could override the built-in table. It has **no production
caller**: repo-wide (`--include=*.ts,*.mts,*.tsx`, excluding `node_modules`) the only
hits are its own definition and `tests/llm/model-catalog.test.ts:14,147,150,155,160`.
*Instrument validated:* the same grep over `meteredCostUsd` returns real callers in
`src/llm/limits.ts:22,310` and `src/core/brain/costs.ts:26,243`.

Consequence, live today: a provider added via `SUDO_CUSTOM_PROVIDERS` resolves, calls,
and is then priced at `CATALOG_DEFAULTS` — **$3/$15 per M and 128K context**
(`model-catalog.ts:225-229`) — silently, with no way to say otherwise. That is the same
failure class as the `ollama` mispricing that produced the documented ~$473 phantom
spend, one layer up. The fix is not a new subsystem; it is **calling a function we
already built and already tested**.

### F3 — OpenClaw's wake is an event with a busy gate; its timer is a floor

`src/infra/heartbeat-wake.ts:318` `requestHeartbeat({source, intent, reason})` is the
driver. Intents are typed (`:29`: `scheduled | event | immediate | manual`). Every wake
can be refused for three named busy reasons — `HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT`,
`HEARTBEAT_SKIP_CRON_IN_PROGRESS`, `HEARTBEAT_SKIP_LANES_BUSY` (`:11-13`) — and those
skips are **retryable rather than dropped** (`:19-26`). `src/cron/service/wake.ts:18-24`
enqueues a system event and *then* pokes the loop.

Restart behaviour is explicitly bounded: `src/cron/service/timer.ts:90-91`
`DEFAULT_MISSED_JOB_STAGGER_MS = 5_000` and `DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5`;
`:79` clamps any timer arm to `MAX_TIMER_DELAY_MS = 60_000`; `:88` `MIN_REFIRE_GAP_MS =
2_000` exists solely to break a re-trigger spin loop (their issue #17821). And the
suppression rule is a pure function with a name —
`src/cron/heartbeat-policy.ts:15` `shouldSkipHeartbeatOnlyDelivery`.

**sudo-ai already adopted this — for exactly one caller.** `src/core/agent/mission/wake.ts:1-57`
is an event-driven, busy-gated, coalescing wake with typed reasons and a
`BUSY_RETRY_MS` retry, and its header (`:5-18`) names `heartbeat-wake` as the source of
the design (shipped as #1077).

Cron did not get it. `src/core/cron/scheduler.ts:128,156` is a blind
`setInterval(TICK_MS)`; the only concurrency guard is per-job re-entry
(`:258-260`). There is **no global busy gate** — nothing consults "is a user turn in
flight" — and no stagger. Catch-up is partial and asymmetric: `cron`-kind jobs do
back-fire a missed window (`:84-98`, `prev > lastRunMs`) and `every`-kind jobs fire on
elapsed time (`:78-82`), but **`at`-kind jobs are lost outright** — `isDue` fires them
only inside a 1-second window around the target (`:75`), so a one-shot scheduled during
a restart never runs and reports nothing. Combined with no stagger, a restart after a
long outage back-fires every missed recurring job at once, unthrottled, with no check on
whether the owner is mid-conversation.

### F4 — OpenClaw refuses to load a plugin without a config schema

`src/plugins/manifest.ts:1764-1767`: `configSchema` is read, and a missing one is a hard
load failure — `"plugin manifest requires configSchema"`. Cerebras's is
`{"type":"object","additionalProperties":false,"properties":{}}` — i.e. *"I take no
config, and anything you pass me is an error."* The mandatory part is the decision;
the JSON Schema is just the notation.

sudo-ai's counterpart is ADR 0010's D4 (not yet executed). The distinct thing to take
from OpenClaw is **mandatory, not optional** — because an optional schema is the state
we already have, and it is why `src/core/config/flag-lint.ts:132` needs
`SUDO_ALLOW_CONTRADICTORY_CONFIG` as an escape hatch that `src/cli.ts:463-466` honours
by booting in a "weakened" posture.

### F5 — Where sudo-ai is already better (do **not** import these)

1. **Billing class is a lane property, not a model property.** `src/llm/model-catalog.ts:22-35`
   splits `meteredCostUsd()` (what a budget may spend) from `notionalCostUsd()`
   (reporting only), because the *same* model is $0 on `claude-oauth/` and metered on
   `anthropic/`. OpenClaw's manifest carries a flat `cost` block per model
   (`extensions/cerebras/openclaw.plugin.json`) with no seat concept at all. Their
   catalog cannot express our most important money fact. Adopting their row shape
   verbatim would re-introduce the confusion that parked a $0 mission at "$8.80 of
   $5.00" and, historically, cost two outages (`limits.ts:287-292`).
2. **One policy owner for retry / breaker / lanes / budget.** `src/llm/policy.ts:1-20`
   — including the asymmetry rule (user priority never blocked; background fail-closed)
   and fail-open-on-policy-bug. This is a genuinely good piece of design and nothing in
   the OpenClaw provider path replaces it.
3. **The IR interceptor seam.** `src/llm/ir-interceptor.ts:1-11` — a process-wide seam
   that makes every model call deterministically replayable, *provably inert* when
   unset. This is what makes the eval sandbox (ADR 0007) possible.
4. **Zone classification and F18 quarantine of external model text.** No equivalent was
   sought or found in OpenClaw; it is a project invariant and stays.

---

## Alternatives considered

1. **Adopt OpenClaw's plugin *package* system** (external packages, install-time
   security scanning, host-version compatibility, a 132-manifest `extensions/` tree).
   **Rejected** — ADR 0010 already rejected this for the same reason and the reason has
   not changed: it presumes third-party distribution we do not have. We take the
   contract, never the distribution.
2. **Split `src/llm` into `llm-core` / `llm-runtime` packages, as OpenClaw does.**
   **Rejected.** Their split exists to serve a public `plugin-sdk` surface
   (`package.json:1400`). We have no third-party consumers, so the split buys us build
   complexity and buys the design nothing. Doctrine #5: the simpler design wins.
3. **JSON manifest files for internal capabilities.** **Rejected.** A TypeScript
   declaration object is checked by `tsc` at build time; a JSON file needs a runtime
   validator to reach the same guarantee. `src/core/channels/channel-registry.ts:52`
   `ChannelDeclaration` already proves the typed-object form works for us. JSON earns
   its keep when the author is a *separate package*; ours are in-repo.
4. **Do nothing; the custom-provider env var is enough.** **Rejected** — F2 shows it is
   enough to *route* and not enough to *price*, and the mispricing is silent.

---

## Decision

Four proposals, ranked by **(value twelve months out) / (migration cost)**. P1 and P2
each delete more than they add; P3 rides D4; P4 is a recommendation only.

### P1 — One provider declaration table; delete the four hand-synced seams (highest ratio)

**Take:** provider = data, wire protocol = code (F1).

**How our structure evolves into it — no new subsystem.** `src/llm/transport.ts` already
has the `family` axis and `custom-providers.ts` already has the operator-facing
declaration. Collapse the four hand-synced built-in seams into **one exported array of
declarations** living where the base URLs already live (`src/llm/endpoints.ts`), each
row carrying: `{ id, family, baseUrl, apiKeyEnv, catalogRows }`.

Then:

- `OPENAI_COMPAT_BUILTINS` (`transport.ts:121`) becomes derived — **deleted as a literal**.
- `PROVIDER_KEY_ENVS` / `ProviderKeyName` (`client.ts:117`) becomes derived from the
  same array — `ProviderKeyName` stays as a type alias so the ~7 downstream importers
  (`voice.ts:15`, `survival-probe.ts:8`, `codex.ts:19`, `models.handler.ts:19`, …) are
  untouched.
- The `ollama` (`transport.ts:285-287`, `:421-424`) and `google` (`:288-296`,
  `:425-429`) special cases become ordinary rows — `ollama` with a static `Bearer
  ollama` key and an env-overridable base URL, `google` pointing at
  `GOOGLE_OPENAI_COMPAT_URL`, both of which the declaration shape already expresses.
  **Roughly 25 lines of branch logic deleted, not moved.**
- `custom-providers.ts` produces rows of the **same** type, so a custom provider and a
  built-in differ only in *authority*, which the catalog already models
  (`model-catalog.ts:42-45`: `config 0 > builtin 1 > runtime 2`).

**Bundled with it, and shippable alone as the smallest useful slice:** wire
`registerCatalogRows()` (F2) to `SUDO_CUSTOM_PROVIDERS` so a declared provider carries
its own price and context window instead of silently inheriting $3/$15/128K. This is a
call site for an already-tested function — the smallest diff in this ADR and the one
that closes a live money defect.

*Twelve-month value:* adding a provider becomes emitting one typed object with a known
shape — a task a model does reliably and a schema can reject. Today it is four edits in
three files where **missing any one fails silently and differently**, which is precisely
the task class models still get wrong.

*Migration cost:* one file's worth of table plus mechanical deletion. No behaviour change
if the table is transcribed correctly, which a round-trip test can assert against the
current constants before the constants are removed.

*Success criterion (state it now, measure it later — ADR 0010 taught us this):* adding
a first-class openai-compat provider touches **exactly one** file, and
`src/llm/transport.ts` is net **smaller**. If either fails, P1 failed; revert it
(doctrine #5).

### P2 — One wake primitive; cron and heartbeat ride it

**Take:** wake on an event, gate on busy, retry the skip, treat the timer as a floor,
and bound restart catch-up (F3).

**How our structure evolves into it — promote, don't invent.**
`src/core/agent/mission/wake.ts` is already this design; it is merely *mis-scoped* to
one caller. Move it to a neutral home (`src/core/scheduling/wake.ts`), keep its
injected-deps shape (`WakeDeps { tick, isBusy, hasWork }`, `wake.ts:50-57` — it owns no
runtime handles by construction), and let `CronScheduler` and the heartbeat request
wakes through it. `CronScheduler`'s `setInterval` (`scheduler.ts:156`) becomes the
floor, not the driver.

Three concrete defects this closes, each independently testable:

1. **No global busy gate.** Cron can currently land an autonomous turn mid-conversation;
   the mission lane already refuses to. `isBusy()` already exists and already covers
   web/gateway turns and cron (#1078).
2. **Unbounded restart catch-up.** Adopt the *shape* of `timer.ts:90-91` — a stagger and
   a per-restart cap — with our own numbers. Today every missed recurring job fires at
   once.
3. **`at`-kind jobs are silently lost across a restart** (`scheduler.ts:75`, 1-second
   window). Either back-fire them like `cron`-kind jobs, or record a typed
   `missed-while-down` reason. Silently never firing a one-shot the owner scheduled is
   the worst of the three.

*Twelve-month value:* as autonomy increases, "when may the agent act" stops being a
timer question and becomes a contention question. One busy gate that every background
lane consults is the only version of that which stays correct as lanes multiply.

*Migration cost:* a file move plus two call sites. The design is already written,
reviewed, and shipped once.

### P3 — Make the capability config schema **mandatory** (rides ADR 0010 D4)

**Take:** F4 — a capability that declares no schema does not load; unknown keys are an
error, not a shrug.

**How our structure evolves into it:** D4 already proposes per-capability typed config.
The single amendment this ADR adds is *mandatory + closed*: every declaration in the
channel registry (`channel-registry.ts:52`) and the P1 provider table carries a config
type, and validation rejects unknown keys. That is what lets the drift machinery —
`flag-lint.ts` and its `SUDO_ALLOW_CONTRADICTORY_CONFIG` escape hatch
(`flag-lint.ts:132`, honoured at `cli.ts:463-466`) — be **deleted** rather than
extended. An optional schema deletes nothing, which is why D4 as written could quietly
end up net-additive.

*Cost:* nil beyond D4; it is a constraint on D4, not extra work.

### P4 — Recommendation only: two cron schedulers exist, one is dormant

`src/core/consciousness/cron-scheduler.ts` is **676 lines** implementing a second,
independent 5-field cron scheduler with its own jitter, one-shot handling, missed-task
detection and JSON persistence. Repo-wide it is exported (`consciousness/index.ts:48,54`)
and tested (`tests/consciousness/cron-scheduler.test.ts:17`) but **never instantiated in
production** — the only `new CronScheduler(...)` is `src/cli.ts:3806`, constructing the
`src/core/cron` one. *Instrument validated:* the same grep pattern returns the expected
production hits for `CronScheduler` across ten files.

It has capabilities the live scheduler lacks (deterministic jitter; explicit missed-task
detection — the very gap P2 must close). Per the standing rule, **this is surfaced, not
removed.** Two honest options for the owner: (a) harvest its jitter + missed-task logic
into P2 and then retire it, or (b) leave it. Do not let it rot as a third source of
truth about *when things run*.

### Explicitly NOT adopting

- **The plugin package/distribution system** — no third-party surface (see Alternatives 1).
- **The `llm-core` / `llm-runtime` package split** — build cost, no design gain (Alt. 2).
- **JSON manifests for in-repo capabilities** — loses `tsc` (Alt. 3).
- **Their five-tier catalog authority** (`src/model-catalog/authority.ts:9-15`:
  `config 0 > manifest 1 > cache/runtime-refresh 2 > provider-index 3`). Our three tiers
  (`model-catalog.ts:42-45`) map to the sources we actually have. Adding `manifest` and
  `provider-index` tiers before those sources exist is speculative structure.
- **Their model row shape**, which has no seat/metered concept (F5.1).
- **A `src/plugin-sdk` public surface.** Nothing consumes it. Doctrine #6.

---

## Tradeoffs

- **P1 concentrates provider facts in one table.** A bug there is a bug in every
  provider. That is the same bet D2 already took and won; mitigate the same way — keep
  it pure and table-driven, and keep the seat-pricing regression test that carries the
  outage history.
- **P1 touches the money path.** `ProviderKeyName` is imported by seven modules; the
  type must survive the refactor byte-identical or auth breaks in voice, probes and the
  admin models handler. Assert the derived table equals the current constants *before*
  deleting them.
- **P2 makes cron quieter and later.** Jobs that used to fire during a conversation will
  now wait. That is the intent, but a job starved by a permanently-busy system is a new
  failure mode; the retry needs a ceiling and a typed `starved` reason, not silence.
- **P2's `at`-job fix changes behaviour on purpose.** One-shots that silently vanished
  will start firing after a restart. That is correct and must be called out at deploy.
- **P3 will find dark capabilities.** Making schemas closed converts "quietly ignored
  key" into "boot error". Stage it per capability; a config key that never worked is not
  a capability being dropped, but the distinction has to be checked case by case.
- **P4 is a non-decision until the owner answers.** Leaving it unanswered is the actual
  risk.

## Consequences

- Adding a provider goes from **four silent-failure edits across three files** to one
  typed row — and a custom provider stops being priced at a default it never declared.
- `src/llm/transport.ts` gets *smaller* (P1's success criterion), not larger.
- Every background lane consults **one** busy gate; "may the agent act now" has one
  answer instead of one per scheduler.
- The flag-drift machinery becomes deletable (P3), which is D4's actual payoff and the
  part most at risk of being skipped.
- No capability is removed anywhere in this ADR. P4 is a recommendation with two named
  options and no default.
- **Nothing here touches identity, constitution, `PROTECTED_PATHS`, a memory-write lane,
  or the Grok/statsig lane.**

## Migration

Order is by ratio, and each step ships green and deploys before the next begins.

1. **P1a** — wire `registerCatalogRows()` to `SUDO_CUSTOM_PROVIDERS`. Smallest diff in
   this document; closes a live silent-mispricing defect. Regression test: a declared
   custom provider with a price is *not* charged `CATALOG_DEFAULTS`.
2. **P1b** — the provider declaration table; delete `OPENAI_COMPAT_BUILTINS`, the
   `ollama`/`google` branches, and derive `PROVIDER_KEY_ENVS`. Gate: an equivalence test
   asserting the derived table matches today's constants, landed *before* the constants
   are removed. Then measure `transport.ts` line count against the criterion.
3. **P2** — promote `mission/wake.ts`; move cron onto it; add the busy gate, the
   restart stagger/cap, and the `at`-job fix. Three separately-provable regressions.
4. **P3** — folded into D4 as a constraint, not a separate PR.
5. **P4** — owner decision. No code until then.

Revert criteria are stated per proposal above. P1 that does not shrink `transport.ts`,
or P2 that does not remove a scheduler branch, has failed its own test and comes out.

## Not verified

Stated plainly, because it is worth more than confidence I have not earned:

- I did **not** run OpenClaw, or exercise any of its code. Every OpenClaw claim is
  static reading of the checkout at `/root/openclaw-study/openclaw`.
- I did **not** locate where the `ollama` extension registers its non-builtin
  `api: "ollama"` adapter; I only confirmed the manifest declares it
  (`extensions/ollama/openclaw.plugin.json:73`) and that `types.ts:18` permits it.
- I did **not** review `/root/openclaw-security-audit`; nothing in this ADR rests on it.
- I did **not** measure how many sudo-ai `at`-kind cron jobs exist in production, so the
  blast radius of the P2 `at`-job fix is unquantified. The code path is confirmed;
  the exposure is not.
- The "27 of 37" wire-protocol count is a grep over `extensions/*/openclaw.plugin.json`
  only. Extensions declaring providers *outside* that manifest field would not be counted.
- No measurement of P1's actual line-count delta exists yet — the success criterion is
  stated so it can be checked, not because it has been.
- **This ADR is docs-only.** `tsc`, the test suite and `check:arch` were run to prove
  no source changed, not to validate any proposal.
