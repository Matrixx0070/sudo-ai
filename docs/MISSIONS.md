# Missions — goals that survive days, sessions, and restarts

## The problem this solves

Before this, a goal you gave in Telegram lived in exactly one place: a chat
transcript. Everything shipped on 2026-08-05 (run journal, honest stop reasons,
budget visibility, resumable halts) made a **single run** survivable. None of it
made work survive across **days**, because of a hard structural gap:

- The only thing that wakes the agent unprompted is the heartbeat cron.
- The heartbeat runs in a **dedicated session** (`cli.ts`: "Creates or reuses a
  dedicated session for the cron job") — it cannot see the chat session holding
  your goal.
- The heartbeat prompt is a fixed checklist (`workspace/HEARTBEAT.md`) that says
  *"Act ONLY on the sections named in the Due tasks line"* — there is no slot for
  your goal, and it is explicitly told not to invent one.

So a 3-day goal stalled the moment the first turn ended.

A **Mission** is the durable object that closes that gap. It lives on disk, so
any session — chat, cron, or a process started tomorrow — can pick it up.

## Shape

```
data/missions/<id>.json
  goal          the outcome you asked for
  steps[]       plan; each step has description + doneWhen (a CHECKABLE criterion)
  cursor        index of the next step — advances ONLY on verified completion
  artifacts[]   real things produced (paths, PRs, URLs)
  blockers[]    typed: owner_decision | credential | money | external | error
  spendUsd      accumulated across every advance run (from the gateway ledger)
  maxSpendUsd   mission-wide ceiling (null = none)
  deadline      ISO date (null = open-ended)
  status        planning | active | blocked | paused | completed | failed | cancelled
```

## How a mission advances

### When it wakes

Advancement is **event-driven and busy-gated**, matching the OpenClaw heartbeat
design this system's heartbeat came from (`heartbeat-wake`: `requestHeartbeat`
+ `requests-in-flight` / `cron-in-progress` / `lanes-busy` skips with retry).
A plain interval was wrong in both directions — a mission created on an idle
machine waited up to 30 minutes for no reason, and the timer could fire a work
turn while the owner was mid-conversation.

- A wake is **requested** on: mission created, unblocked, resumed, a user turn
  finishing, startup, and after each productive step.
- Bursts **coalesce** into one tick.
- A wake while a user turn is in flight **defers and retries** — it is never
  dropped, and never interrupts the owner.
- A productive step **chains** into the next one, so an idle machine runs a
  mission to completion instead of sleeping between steps.
- The scheduler interval (`SUDO_MISSION_TICK_MIN`) remains only as a floor.

One tick advances **one step of one mission** (the longest-waiting
eligible one, so nothing starves):

1. **Plan** (first tick) — the goal is decomposed into steps. A step without a
   checkable `doneWhen` is **dropped by the parser**; a plan that ends up empty
   falls back to one self-describing step rather than silently doing nothing.
2. **Execute** — the step's prompt carries the goal, completed work, and
   artifacts across the session boundary, then runs as a real agent turn with
   full tools (through the same `executeAgentTurn` seam cron uses).
3. **Verify** — a **separate** call is shown the work and answers
   `DONE:` / `NOT_DONE:` / `BLOCKED|kind:`. The executing turn does not grade
   itself on "did I finish".
4. **Settle** — `DONE` advances the cursor. `NOT_DONE` retries (max 3 attempts,
   then escalates). `BLOCKED` parks the mission and messages you. An
   unparseable verdict counts as NOT_DONE — the cursor never moves on ambiguity.

## Guarantees

- **No fake progress.** The cursor moves only on a verified criterion.
- **No infinite grinding.** 3 attempts per step, 6 consecutive failed advances
  ends the mission as `failed` — both surface to you.
- **Owner-gated work asks instead of guessing.** Money, credentials, and product
  decisions become typed blockers that park the mission.
- **Crash-safe.** Atomic writes (tmp + rename); a throwing advance is recorded
  and the mission is preserved; a bad tick can never kill the scheduler.
- **Budget is per MISSION**, not per run — a 3-day goal is many runs, and per-run
  limits say nothing about the total.

## Operating it

```
meta.mission action="create"  goal="..." [maxSpendUsd=] [deadline=]
meta.mission action="list"
meta.mission action="status"  missionId="mission-..."
meta.mission action="unblock" missionId="..." note="what you supplied"
meta.mission action="pause" | "resume" | "cancel"
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `SUDO_MISSIONS` | **off** | `1` arms autonomous advancement. This is the path that spends money with no human in the loop, so it opts in explicitly. |
| `SUDO_MISSION_TICK_MIN` | `30` | Minutes between ticks, clamped to [5, 720]. |

With the flag off, missions can still be created, listed and inspected — they
simply do not self-advance.

## Known limits (honest)

- Each advance is still bounded by `LoopGuard` (50 consecutive tool calls) and
  `agents.maxIterations` (150). A mission moves in increments, not one
  continuous multi-day burn — which is the intended shape, but it means a step
  must be sized to fit one work session.
- Verification is only as good as the `doneWhen` the planner wrote. A vague
  criterion produces a weak check; the parser enforces that one *exists*, not
  that it is excellent.
- `maxSpendUsd` counts **real metered money only**, read from the gateway
  ledger. Flat-subscription lanes (`claude-oauth/`, `ollama/`) are priced at 0
  in `limits.ts` **on purpose** — they ride a seat, not per-token billing.
  Do not "fix" that zero: booking seat calls as dollars has taken this system
  down twice (limits.ts:288 — 418 calls booked as "$51" blew a $50 cap; ollama
  `:cloud` mispricing booked ~$473 of phantom spend and turned a spend cap into
  a total outage). A mission that runs entirely on the seat therefore costs $0
  and never parks on budget; its volume is bounded by the policy layer's daily
  seat CALL ceiling, the plan length, and per-step attempt caps.
  `AgentRunResult.spendUsd` is the NOTIONAL list-price equivalent — useful for
  reporting, never for gating a dollar budget.
- Notifications ride the proactive notifier, so mission reports arrive on the
  configured channel, not necessarily the chat where the goal was given.
