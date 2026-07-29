# ADR 0003 — Credential failure domains in the brain failover chain

- Status: **Accepted** (rev 2; rev 1 draft reviewed 2026-07-29)
- Date: 2026-07-29
- Driver: 2026-07-29 brain-chain outage post-mortem

## Problem

The failover chain advertises 6 profiles but contains only **3 failure domains**: 4 of the
6 `models.primary` slots (`config/sudo-ai.json5`) are `claude-oauth/*` models sharing ONE
credential file (`data/claude-oauth.json`) and ONE Anthropic org policy. On 2026-07-29 a
single org-level setting (`oauth_not_allowed_for_organization`, HTTP 403) killed four
slots at once — correlated failure dressed as redundancy.

`ModelFailover` (`src/core/brain/failover.ts`) treats every profile as independent:

1. **No domain propagation.** An `auth_permanent` error disables only the profile that was
   tried. The chain then walks the remaining three claude-oauth slots, each burning a live
   wire call + 403 + disable cycle on a credential already proven dead. Same for `auth`
   (401) and `billing` cooldowns — all account-scoped, all applied per-model.
2. **No domain-aware recovery.** If the credential recovers, nothing re-admits cooled
   siblings early.
3. **Health surfaces overstate redundancy** — `getStatus()` reports 6 independent
   profiles.

## Alternatives considered

1. **Config-only: diversify/reorder `models.primary`.** Doesn't fix the mechanism; the
   retry burn recurs for any future shared-credential chain. Rejected as the whole fix.
   Specifically considered promoting `google/gemini-2.5-flash` above the claude-oauth
   block: **rejected** — Frank deliberately ordered fable as first fallback for quality,
   and with domain propagation the cost of the claude block being dead is exactly one
   wire call, so the reorder buys almost nothing.
2. **Domain-aware failover in `ModelFailover`** — account-scoped error classes propagate
   across profiles sharing a credential. Small, general, evolves the existing class.
   **Chosen.**
3. **Full credential-registry subsystem.** Over-engineered: exactly one credential per
   provider today, so `provider` IS the domain key. Rejected per simplicity rule.
4. **Dedup the chain to one slot per provider.** Drops the deliberate
   fable/opus/sonnet/haiku tier capability. Rejected (never-drop-capabilities).

## Decision

Extend `ModelFailover` with a failure-domain concept. No new subsystem, no config schema
change. Guarded by `SUDO_FAILOVER_DOMAINS` (default **ON**; `=0` restores per-profile
behavior).

1. **Domain key = `provider`**, derived in the constructor, stored on `ModelProfile`.
   Every credential today is per-provider.
2. **Account-scoped errors propagate as COOLDOWNS, never as disables.** In
   `recordError`, when the class is `permanent`, `auth`, or `billing`:
   - The erroring profile is handled exactly as today (permanent → disabled).
   - Every OTHER profile in the same domain receives a cooldown from the matching
     schedule (`permanent`/`auth` → `AUTH_COOLDOWN`, `billing` → `BILLING_COOLDOWN`),
     computed from the **erroring profile's** consecutive-error count (domain evidence
     escalates the domain's cooldown), stamped with a new `cooldownClass` field, and
     never SHORTENING an existing cooldown. Siblings' own `consecutiveErrors` are not
     touched — the error is evidence about the credential, not about those models.
   - Rationale for cooldown-not-disable on `permanent`: a miscategorized model-scoped
     403 must not permanently kill the whole domain. With cooldowns, a real org block
     costs one live wire call per ~cooldown-ceiling window (bounded, cheap) and the
     domain self-heals when the block lifts; a false positive self-heals the same way.
   - Model-scoped classes (`transient`, `other`) never propagate.
   - The last-resort cap (`LAST_RESORT_MODEL_IDS`, 60s) outranks propagated cooldowns.
3. **Success propagates recovery.** `recordSuccess` on any profile clears domain
   siblings' cooldowns **whose `cooldownClass` is account-scoped** (`auth`/`billing`) —
   a working call proves the shared credential works. Transient cooldowns and disabled
   siblings are untouched (disable stays per-profile and permanent, as today).
4. **Observability.** `cooldownClass` + `domain` ride in `getStatus()` snapshots;
   propagation and domain-recovery each log one structured line with the affected
   profile list.

## Tradeoffs

- A real org block no longer hard-disables the sibling slots — they retry once per
  cooldown ceiling (~30 min for auth) until they individually 403 and disable. Bounded
  waste (single call per window) traded for automatic recovery when the block lifts.
- A billing/auth blip on one model briefly cools healthy same-provider siblings. By
  classification these are account-scoped, so this is correct more often than not; the
  success-propagation rule un-parks them on the next domain success.
- `recordSuccess` gains cross-profile writes — coupling that mirrors reality (the
  credential IS shared state).
- `cooldownClass` is additive on `ModelProfile`; snapshot consumers must tolerate it.

## Consequences

- One org-policy failure costs one wire call instead of four; the chain reaches the next
  live domain immediately.
- Credential recovery is automatic chain-wide (success-propagation) instead of requiring
  a restart for cooled profiles.
- Health/telemetry can report true redundancy (domains, not slots).
- Behavioral tests in `tests/brain/failover-domains.test.ts` cover: permanent-error
  propagation, non-propagation of transients, billing propagation, success recovery
  scoped to account-classes, the `SUDO_FAILOVER_DOMAINS=0` escape hatch, never-shorten,
  last-resort cap, and next-domain selection after an org-block event.
