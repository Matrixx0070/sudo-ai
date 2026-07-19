# Spec — Per-Session Cache Affinity (opt-in)

Status: DESIGN / future opt-in. Author: beat-openclaw campaign, 2026-07-19.
Resolves the S1 tension surfaced in `docs/BEAT_OPENCLAW_FINAL.md` **without**
regressing the S16 smart-routing lead.

## Problem

OpenClaw reaches 91.6% prompt-cache-read share because it uses **one model** —
every turn hits the same provider, so the byte-stable prefix + append-only
history stay warm in that provider's cache. SUDO-AI's `_smartRoute`
(`src/core/brain/brain.ts:1546`) instead picks the best model **per turn**
(claude for complex, grok for simple — the S16 outcome-gated routing lead). Verified
live 2026-07-19: even with grok pinned primary + window 150, only ~11/60 turns
stayed on grok; the router oscillated across providers and each switch reset that
provider's cache → aggregate ~30% despite individual turns hitting **87–89%**.

So ≥90% single-provider cache and per-turn smart routing are mutually exclusive
**globally**. The fix is to make it a **per-session choice**, not a global one.

## Design

A session-scoped **cache-affinity** mode. When ON for a session, the conversational
route sticks to ONE provider for the life of that session (so cache stays warm);
when OFF (default), smart routing is unchanged. This is additive and opt-in — the
S16 router remains the default and still governs every non-affinity session and
every non-conversational call.

### Mechanism

1. **Affinity state** — a per-session record `{ sessionId, provider, model, pinnedAt }`
   held in session state (extend the session store / `run-registry`, keyed by
   `sessionId`). Chosen once per session:
   - Explicit: operator/config sets the provider (e.g. `grok-4-fast` — the
     cache-friendliest cheap tier), OR
   - First-turn winner: let `_smartRoute` pick on turn 1, then **pin that provider**
     for the rest of the session.
2. **Router seam** — at the top of `_smartRoute(request)` (brain.ts:1546), before
   the premium/cheap/category logic:
   ```
   if (sessionCacheAffinityEnabled(request.sessionId)) {
     const pin = getSessionAffinity(request.sessionId);   // {model} or null
     if (pin) return { model: pin.model, reason: 'cache-affinity', kind: 'affinity' };
     // else: fall through to normal routing THIS turn, then record the winner as the pin
   }
   ```
   `request.sessionId` already exists on `BrainRequest` (types.ts:155). Non-conversational
   callers (RAG, judge, consciousness) pass no affinity → unaffected.
3. **Failover still allowed** — if the pinned provider hard-fails (not just
   rate-limits), affinity yields to the failover chain for that turn but does NOT
   repin (so a transient blip doesn't permanently switch the session). Optionally
   re-pin only after N consecutive pin failures.
4. **Pairs with the two proven levers** — cache affinity is only useful alongside
   BO2b's byte-stable prefix (`SUDO_PROMPT_CACHE_TAIL_MEMORY`, shipped) and a
   large append-only window (`SUDO_AGENT_WINDOW_SIZE`, e.g. 150). The affinity mode
   should imply/recommend both for affinity sessions.

### Config

- `SUDO_SESSION_CACHE_AFFINITY` — global default OFF. `1` = affinity ON for new
  sessions; the router pins per session.
- `SUDO_CACHE_AFFINITY_PROVIDER` — optional explicit pin target (e.g.
  `xai-oauth/grok-4-fast-non-reasoning`); unset = first-turn-winner.
- Per-session override (e.g. a `/cache on` command or an admin toggle) so a user
  can opt a specific long session into affinity without changing the global default.

## S16 protection (hard requirement)

- Default OFF → zero behavior change; smart routing and all learning/eval
  (self-eval, episodic, flywheel, EMA tool-bias) run exactly as today.
- When ON, the router is not disabled — it still runs for non-affinity sessions,
  non-conversational calls, and the affinity first-turn pick; outcome signals are
  still recorded. Affinity only constrains the *conversational* model for *that*
  session. No learning mechanism is removed.
- Acceptance test must run the full S16 suite (`tests/learning tests/agent` +
  flywheel/replay) green with affinity both OFF and ON.

## Expected outcome

For an affinity session on a cache-friendly provider + byte-stable prefix +
append-only window: per-turn cache climbs to the proven ~87–89% and, held on one
provider across the session, the aggregate reaches **≥90% by turn 50** — matching
OpenClaw — while the *default* experience keeps SUDO-AI's smart routing. Cost/msg
for affinity sessions drops well under OpenClaw's $0.007 (cheap model × high
cache). Users pick per session: best-model-per-turn (default) or
cheapest-warm-cache (affinity).

## Rollout

1. Session affinity store + `_smartRoute` seam + the two flags. Unit tests: an
   affinity session stays on one provider across turns; failover-on-hard-fail
   without repin; OFF = byte-identical routing.
2. Live-verify on an isolated instance: 50-turn affinity session on grok-4-fast +
   window 150 → measure cache-read share ≥90% + cost/msg < $0.007 (the clean
   measurement blocked in the campaign by provider oscillation is now possible
   because the session is pinned). S16 suites green both modes.
3. Optional `/cache on|off` command + admin toggle; docs.

## Files touched (estimate)
- `src/core/brain/brain.ts` (`_smartRoute` seam + first-turn pin capture).
- session state / `src/core/agent/run-registry.ts` (affinity record) — or a small
  `src/core/brain/cache-affinity.ts` map keyed by sessionId.
- `src/core/brain/types.ts` (optional affinity hint on BrainRequest).
- config flag manifest + `.env.example`.
- tests: `tests/brain/cache-affinity.test.ts` + an S16 regression run.
