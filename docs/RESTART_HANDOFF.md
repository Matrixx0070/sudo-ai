# Verified restart handoff (GW-9)

SUDO restarts (updater merge→pull+restart, Kairos `systemctl restart`) used to be
fire-and-forget: nothing proved the successor came up before the predecessor was
gone, and probes had to wait 80s+ post-restart to avoid false failures. GW-9 adds
a sentinel-file protocol so a restart can be **verified**.

## Protocol (`src/core/health/restart-sentinel.ts`)

Files live under `DATA_DIR/restart/`:

- `intent.json` — `{ reason, initiator, ts, gitSha }`. Written by the **initiator**
  BEFORE the restart is triggered (`writeRestartIntent`).
- `ready.json` — `{ bootTs, gitSha, port }`. Written by the **successor** once boot
  is complete (gateway listening + SecurityGuard up + channels started) via
  `completeBootHandoff`, which also deletes `intent.json`.

### Initiator side
- **Kairos** (`consciousness/kairos.ts`): before the guarded `systemctl restart`
  it calls `writeRestartIntent(..., { initiator: 'kairos' })`.
- **Meta/updater** (`tools/builtin/meta/restart-helper.ts`): `scheduleDetachedRestart`
  records `{ initiator: 'updater' }` before spawning the detached restarter.
- An external supervisor that SURVIVES the restart can call `waitForReady(dir,
  { sinceMs, timeoutMs })` to poll for a fresh `ready.json` (a ready written before
  `sinceMs` is rejected — it belongs to a prior boot). Timeout ⇒ alert.

### Boot side (`src/cli.ts`, after "v5 modules initialized")
`completeBootHandoff` runs once init is done:
- Intent present, fresh ⇒ logs "resumed from intended restart".
- Intent present, **stale** (> 10 min, `DEFAULT_STALE_MS`) ⇒ the previous handoff
  likely failed: `log.error` (surfaces on the Telemetry log tab) and, if the
  intent was Kairos-initiated, Kairos enters a 1h restart **cooldown**
  (`applyFailedHandoffCooldown`) so a bad restart cannot loop.
- Always writes `ready.json`.

### Kairos cooldown
`isKairosRestartOnCooldown()` gates the RAM-critical restart branch. After a failed
handoff Kairos will not restart again for `KAIROS_RESTART_BACKOFF_MS` (1h).

## Budgets / invariants
Pure-local file I/O, zero LLM/network calls, no new recurring job. Systemd remains
the process supervisor; the sentinel adds verification, not lifecycle ownership.

## Deferred
Owner-Telegram alert on failed handoff is NOT wired at the boot detection point
(would couple boot to the scheduled-messages channel seam); the failed handoff is
surfaced via `log.error` on the Telemetry tab + the Kairos cooldown. Wire the
Telegram owner-ping in a follow-up if the log surface proves insufficient.
