# Enabling GW-5 (mid-run steering) & GW-11 (run lanes) — canary runbook

Both features shipped to `main` **default-OFF**. This is the runbook to turn them
on safely. Nothing here has been executed — it is a checklist for the operator.

## Prerequisite (important)

The live daemon runs via **pm2** (`sudo-ai-v5`, `node --import tsx src/cli.ts`).
As of this writing the prod checkout is **not on `main`**, so the running daemon
does **not yet contain the GW-5/GW-11 code**. Enabling the flags has no effect
until the instance you target is running `main` (commit `1cb18e16` or later).

## Flags

| Flag | Purpose | Recommended canary value |
|---|---|---|
| `SUDO_RUN_LANES_ENABLED` | Master gate for GW-11 run lanes (per-session mutex + global lane caps) | `1` |
| `SUDO_RUN_LANES` | Lane concurrency caps | `user=4,subagent=4,background=2,cron=1` |
| `SUDO_MIDRUN_STEER` | Master gate for GW-5 steer-buffer drain on the loop hot path | `1` |
| `SUDO_QUEUE_MODE_DEFAULT` | Default handling of a message that arrives mid-run | start at `followup`, move to `steer` only after GW-11 looks healthy |

**Ordering matters.** Enable GW-11 first (concurrency safety), observe, then
GW-5. Turning `SUDO_QUEUE_MODE_DEFAULT=steer` is the last and most behavioral
step — it changes what a mid-turn message *does*, on the live ReACT hot path.

## Staged rollout

1. **Lanes only.** Set `SUDO_RUN_LANES_ENABLED=1` + `SUDO_RUN_LANES=...`. Restart.
   Watch that turns still complete, no session deadlocks, background work isn't
   starved. The per-session mutex is the load-bearing invariant (one active run
   per session).
2. **Steering, followup mode.** Add `SUDO_MIDRUN_STEER=1` with
   `SUDO_QUEUE_MODE_DEFAULT=followup` (steer buffer active but default behavior
   unchanged). Confirms the drain path runs with zero behavior change.
3. **Steering, steer mode.** Set `SUDO_QUEUE_MODE_DEFAULT=steer`. Now mid-run
   messages inject at the iteration boundary. Watch closely (see below).

## What to watch (per stage, ~24–48h each)

- **No trust-tier mixing** — an untrusted message must never steer into an owner
  run (it should reroute to followup). This is the security invariant; a
  regression here is a privilege-escalation bug. Grep the logs for steer
  decisions on untrusted callers.
- **No duplicate/dropped turns** — steering must not double-process or lose a
  message. Cross-check `traces.db` turn counts against inbound messages.
- **Concurrency sane** — no run starvation, no lane deadlock; background lane
  capped as configured.
- **Spend flat** — GW-11 shouldn't increase LLM burn; watch `gateway.db`
  `llm_calls` per hour vs baseline.

## Where to set them & restart

Add the vars to `config/.env` (or the pm2 env block in `ecosystem.config.cjs`),
then `pm2 restart sudo-ai-v5`. Confirm at boot: the posture banner + a log line
from `run-lanes` / the steer drain guard should show the flags active.

## Rollback (instant)

Remove the flags (or set the gates to `0`) and `pm2 restart sudo-ai-v5`. Both
features are pure additive gates — with the flags off, the code paths are inert
(the loop drain is a true no-op, `beginRun/endRun` bookkeeping is harmless), so
rollback is a clean restart with no state migration.

## True canary alternative (no prod risk)

Instead of enabling on the prod daemon, run a **separate instance** from a fresh
`main` clone with its own `DATA_DIR`, its own pm2 name, and no channel
credentials (smoke-only), flags ON. Drive it with synthetic turns and the GW-13
journey suite. This exercises the hot path without touching the live agent or the
shared checkout.
