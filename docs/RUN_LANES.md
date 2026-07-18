# Session + global run lanes (GW-11)

`policy.ts` priority lanes govern LLM CALLS; nothing capped concurrent agent RUNS.
Background work (dream engine, cognitive stream, standing orders, cron) each
self-throttled ad hoc. GW-11 adds a unified admission layer.

## Module (`src/core/agent/run-lanes.ts`)
`RunLanes` (singleton `getRunLanes()`), built on the GW-5 run registry:
- **Per-session mutex** — `acquireRunSlot(sessionKey, lane)` admits at most one
  active run per session (mid-run arrivals are handled by the GW-5 steer buffer,
  not a second run). A second acquire for a busy session queues FIFO.
- **Global lane semaphores** — caps parallelism by class: `user` 4, `subagent` 4,
  `background` 2, `cron` 1. Tunable via `SUDO_RUN_LANES="user=4,background=2,…"`.
- **Admission policy** — the `user` lane NEVER drops (unbounded FIFO wait);
  `background`/`cron` lanes queue FIFO with a cap (default 50) and overflow drops
  the OLDEST waiter (+ a telemetry-visible `dropped` counter), never the newest.
- **`drainAndSuspend(timeoutMs)`** — stop admitting + wait for active runs to
  finish; pairs with GW-9's verified restart handoff so a restart hands off
  cleanly. `resume()` undoes a timed-out drain.

`acquireRunSlot` returns a `release` fn that frees BOTH the session mutex and the
lane slot — always call it in a `finally`.

## Wiring
- `gateway-turn-handler.ts` acquires a `user`-lane slot around each channel turn
  (`SUDO_RUN_LANES_ENABLED=1`). Released in the same `finally` that ends the run
  registry entry.

## Flags & default
- `SUDO_RUN_LANES_ENABLED=1` — turn on run-lane admission. **Default OFF** → exact
  current concurrency behavior (per-peer serialization only). Conservative because
  prod concurrency cannot be verified against a live daemon in this change.
- `SUDO_RUN_LANES="user=4,background=2,subagent=4,cron=1"` — per-lane caps.

## Deferred (documented, not silently skipped)
- Admission is wired at the channel turn handler (user lane) only. The cron /
  standing-orders / heartbeat / sessions.send / subagent runners are NOT yet
  routed through `acquireRunSlot` — they keep their existing ad-hoc throttles. Wire
  each to its lane (`cron`/`background`/`subagent`) in a follow-up; the module +
  lane taxonomy are ready.
- `drainAndSuspend` is a tested API but not yet called from the restart/shutdown
  path (`registerShutdown` in cli.ts / GW-9 restart-helper). Wire it there so a
  restart drains lanes before handing off.
- Retiring now-redundant per-feature throttles (cognitive-stream cadence stays —
  it is about LLM burn, not run concurrency) is left until the runners above are
  actually routed through lanes.
