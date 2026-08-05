# ADR 0010 — Extension contract + single authority (draining the composition root)

- **Status:** Proposed — D1 and D2 are self-contained and reversible; D3 and D4 are staged and need Frank's GO per stage
- **Date:** 2026-08-05
- **Deciders:** Frank (owner)
- **Related:** doctrine #4 (capability > feature, platform > tool, engine > workflow), #5 (simplicity), #6 (architecture emerges — justify the subsystem), #3 (deletion is progress, but never drop a working capability); ADR 0005 (tool sprawl — same "many wrappers, no primitive" instinct); ADR 0009 (memory-write sprawl — same "N backends, no shared API" shape, one layer down)
- **Reference codebase:** `/root/openclaw-study/openclaw` — read-only comparison, 2026-08-05

## Problem

Three independent audits of our wiring against OpenClaw converge on **one root cause**:

> We have no extension contract. Every capability is wired by hand at a single point, and every fact is restated at every use site.

OpenClaw carries **142 bundled extensions** (`extensions/`) on a declarative manifest + typed registry; core does not change to add one. We add capabilities by editing a 6,410-line composition root and by appending rows to whichever table the calling subsystem happens to read.

Four measured symptoms. Every number below was verified directly, not inferred.

### P1 — Background output has no delivery target

`heartbeat.ts` strips `HEARTBEAT_OK` and returns the remaining content *for delivery*. The caller discards it:

```ts
const run = wrappedHeartbeat ?? runHeartbeatTurn;
await run(payload, job);
return;                                   // cli.ts:3805 — text dropped
...
if (payload.kind === 'agentTurn') {
  await executeAgentTurn(payload, job);   // cli.ts:3812 — same
}
```

Autonomy goals (`cli.ts:5192`) and standing orders (`cli.ts:5769`) discard their results too. The only surviving trace is a 500-char line in the daily log. **Unless the agent happens to call a send tool mid-turn, everything it concludes autonomously is thrown away.** This is why autonomous work is invisible to the owner.

OpenClaw resolves an explicit delivery target (`resolveHeartbeatDeliveryTarget`) and ships a **doctor check** (`doctor-heartbeat-session-target.ts`) whose entire purpose is warning that "heartbeats will run but replies are dropped silently". We do it by design and have no doctor.

### P2 — Model facts have no single authority

The same model's price/limits/seat-status live in **six** places with **different fallbacks**:

| Source | Holds | Fallback when a model is missing |
|---|---|---|
| `limits.ts MODEL_LIMITS` | context window, max output | 128K / 8192 (`limits.ts:32`) |
| `limits.ts ALIAS_LIMITS` | per-alias limits, hand-mirrored from `aliases.ts DEFAULTS` | stale alias limits |
| `limits.ts PRICE_TABLE` | USD/M | **$3 / $15** (`limits.ts:286`) |
| `limits.ts SEAT_PROVIDERS` | subscription vs metered | metered (phantom spend) |
| `costs.ts COST_RATES` | USD/M (a *second*, different table) | **$5 / $20** (`costs.ts:75`) |
| `savings-routes.ts:166-177` | hardcoded $5/$20 assumptions | — |

Verified drift, live today:

- **`ollama/*` has no `COST_RATES` entry at all** → `$5/$20 per M` in that path. That is precisely the mispricing that produced the documented **~$473 phantom spend and a total product outage** (`limits.ts:299-311`). It is harmless only because the budget reads the *other* table.
- **`sudo/judge`** routes to `claude-oauth/claude-haiku-4-5-20251001` (dated id, `aliases.ts:49`). `limits.ts:276` prices that exact key $1/$5; `costs.ts:68` keys the **bare** `anthropic/claude-haiku-4-5`, so `resolveCostRate` misses and returns $5/$20 — **5× input, 4× output** in the brain path.
- **Seat contradiction:** `limits.ts:312` prices `claude-oauth/` at $0 (correct — flat seat); `costs.ts:204` rewrites it to `anthropic/` and bills full API rates (correct — notional reporting). Both are right for their purpose and **nothing declares which one a budget may use**. This directly caused a $0 research mission to park at "$8.80 of $5.00" (#1076 → #1079).

Adding one model requires **9 files edited in lockstep**, each failing silently and differently.

OpenClaw normalizes every source into one `NormalizedModelCatalogRow` carrying price + context + modality + reasoning **together**, keyed by a normalized `mergeKey` (which would have eliminated our dated-vs-bare bug at the door), merged by a fixed numeric authority — `config 0 > manifest 1 > cache/runtime-refresh 2 > provider-index 3` (`model-catalog/authority.ts:9-15`). Same-tier conflicts **drop both rows and record a conflict** rather than letting one silently win (`manifest-planner.ts:86-108`).

### P3 — `cli.ts` is the only composition root

**6,410 lines**, 114 static + **228 dynamic** imports, **30 distinct `core/*` subsystems**, ~61 shutdown registrations, 14 hardcoded cron entries.

Adding a channel is a **mandatory two-place edit**: the adapter block, *and* the `gatewayFinalize` expression at `cli.ts:3279-3282` which **re-derives every channel's enablement by hand**. Miss the second and the channel registers and never starts. Registration already happens twice by design — `registry.ts:475-489` documents superpowers and plan-mode tools arriving via *both* the builtin loader and an explicit `cli.ts` call, with `register()` made idempotent to paper over it.

By contrast a whole OpenClaw channel is a **15-line manifest**, and its plugin API exposes ~40 typed `register*` seams (`registerTool`, `registerChannel`, `registerProvider`, `registerModelCatalogProvider`, `registerHttpRoute`, …) with the boundary enforced by a package contract, per-plugin permission grants, exclusive slots, and boundary regression tests.

### P4 — Flags instead of typed config, and config that lies

- **819** `SUDO_*` names in `flag-manifest.json` — including the extraction artifacts `"SUDO_16"` and `"SUDO_ADMIN_"`. Only ~187 are set anywhere in `ecosystem.config.cjs`. `cli.ts` alone reads 166.
- Single features need **multiple switches that must agree**: NotebookLM is `SUDO_NOTEBOOKLM === '1' && SUDO_GDRIVE === '1'`; Telegram needs json5 `channels.telegram.enabled` **and** `SUDO_TELEGRAM_DISABLE !== '1'` — two different config systems for one channel.
- **Dead config:** `config/sudo-ai.json5:104` documents Discord as `tokenEnvKey: 'DISCORD_BOT_TOKEN'`; `cli.ts:2872` gates on `DISCORD_TOKEN`. **Setting the documented variable does nothing.**
- **Dark capabilities:** the `google` custom-provider adapter registers then fails per-call (`custom-providers.ts:14-17`); Grok voice is pinned `'0'`; iMessage/IRC/Matrix/Signal/SMS/Email adapters ship and are unreachable without hand-set env combos.
- We have built **infrastructure whose only job is managing the drift this design creates**: a ghost-flag linter, a contradiction table, and `SUDO_ALLOW_CONTRADICTORY_CONFIG` — an escape-hatch flag to override the linter. OpenClaw needs none of it because enablement is one typed `PluginsConfig` plus per-plugin schemas.

## Alternatives considered

1. **Do nothing; keep fixing symptoms.** Rejected. The same class has now cost: two documented pricing outages, a $0 mission parked at $8.80, invisible autonomy, and a channel-config surface that lies. Each fix is cheap; the recurrence is the cost.
2. **Adopt OpenClaw's plugin package system wholesale** (external packages, install-time security scanning, host-version compat). Rejected as scope: it presumes third-party distribution we do not have. We take the *contract* (declare + register + authority), not the *distribution*.
3. **One god config file** replacing all flags. Rejected: moves the sprawl rather than removing it, and breaks the operational property that a flag can be flipped in `ecosystem.config.cjs` without a release.
4. **Rewrite `cli.ts`.** Rejected — doctrine #8 (ship small, always deployable) and #3 (never drop a working capability). `cli.ts` is drained incrementally by moving *registration* out, never by a big-bang rewrite.

## Decision

Four changes, executed in this order. Each is independently shippable and independently revertible.

### D1 — Give background work a delivery target (fixes P1)

A background turn resolves an explicit `{channel, peerId}` delivery target and **delivers its non-suppressed output**, or records a typed `no-target` reason. Add a doctor check that fails loudly when a configured background job has no reachable target, modelled on `doctor-heartbeat-session-target.ts`.

*Why first:* smallest diff, largest behavioural change — it converts autonomy from invisible to reporting, and it makes every later change observable.

### D2 — One model catalog with an authority order (fixes P2)

A single `ModelCatalog` keyed by a normalized `mergeKey`, each row carrying context window, max output, price, seat/metered class, and reasoning flag **together**. Sources merge by fixed precedence (explicit config > built-in table > runtime discovery), same-tier conflicts are dropped and recorded rather than silently resolved. `limits.ts`, `costs.ts`, `aliases.ts` and `savings-routes.ts` become *readers*.

The seat/metered distinction becomes an explicit field with two named accessors — `meteredCostUsd()` (what budgets may use) and `notionalCostUsd()` (reporting only) — so the ambiguity that parked a $0 mission cannot recur.

*Non-negotiable:* seat lanes stay priced $0 for budgets. See `limits.ts:288` for the two outages caused by "fixing" that zero.

### D3 — A capability registry; `cli.ts` becomes a thin boot (fixes P3)

Channels, providers, tool groups and cron jobs are **declared** by their own modules and discovered by a registry, the way `loadBuiltinTools` already discovers tools. `cli.ts` iterates the registry instead of naming each capability twice. `gatewayFinalize`'s hand-written enablement expression is derived from the registry, so a capability can no longer register and fail to start.

Staged, one capability family per PR, `cli.ts` shrinking measurably each time. No behaviour change per stage.

### D4 — Typed capability config; delete the drift machinery (fixes P4)

Each registered capability owns a typed config schema (enabled, credentials key, options), replacing scattered `process.env['SUDO_…']` reads at point of use. `sudo-ai.json5` and env keep working as *sources*, but there is one resolution path and one declared key per capability. Contradiction rules become schema validation; the ghost-flag linter and `SUDO_ALLOW_CONTRADICTORY_CONFIG` are then **deleted**, not extended.

*Explicitly in scope:* fixing the Discord `DISCORD_BOT_TOKEN`/`DISCORD_TOKEN` mismatch and auditing every dark capability for whether it is intentionally off or accidentally unreachable.

## Tradeoffs

- **A registry is indirection.** It only pays for itself if it *removes* more than it adds — the test is `cli.ts` line count and the number of files touched to add a channel. If those don't fall, D3 has failed and should be reverted (doctrine #5).
- **A single catalog is a chokepoint.** A bug there is a bug everywhere. Mitigated by keeping it pure/table-driven, making conflicts loud, and pinning the seat-pricing rule with a regression test carrying the outage history.
- **Config migration risks a silent behaviour change** — a flag read today at point of use may not be read tomorrow. Mitigated by keeping env as a source, migrating one capability at a time, and asserting flag-by-flag equivalence before deleting a reader.
- **D1 makes the agent talk more.** Background turns that were silently discarded will start delivering. That is the point, but it needs a sane suppression default (`HEARTBEAT_OK` already exists) or it becomes noise.

## Consequences

- Adding a model becomes **one row**, not nine lockstep edits with nine different silent failures.
- Adding a channel becomes **one declaration**, not two hand-synchronised edits in a 6,410-line file.
- Autonomous work becomes **visible by default** — the single biggest gap between this system and a Claude-Code-style agent, and the reason a mission spine had to be built to carry state a session key could not express (see ADR notes on missions, #1075-#1079).
- The flag linter, contradiction table and its escape hatch become deletable — roughly 819 declared flags collapse toward per-capability schemas.
- **Frozen surfaces are untouched.** Identity, constitution and `PROTECTED_PATHS` are not in scope; nothing here changes a memory-write lane (that is ADR 0009's territory).
- **No capability is removed.** Dark capabilities are surfaced as recommendations with their real reachability status, per the standing rule that a blocked approach is never permission to cut.

## Execution order

1. **D1** — background delivery + doctor check.
2. **D2** — model catalog + metered/notional split.
3. **D3** — capability registry, staged, `cli.ts` shrinking per PR.
4. **D4** — typed capability config, then delete the drift machinery.

Each stage ships green (tsc + `check:arch` + suite), deploys, and is verified live before the next begins.
