# Mid-run steering + per-session queue modes (GW-5)

Today a message arriving mid-turn waits for the whole ReACT turn to finish
(per-peer serialization in the router / turn handler). GW-5 borrows OpenClaw's
queue semantics so a mid-run message can be folded into the running turn.

## Modes (`src/core/channels/queue-modes.ts`)
Per session (falls back to per-channel, then the global default):
- `steer`     — inject the new message into the current run after the current
  tool call, before the next model call.
- `followup`  — queue a new turn (today's serialize behavior).
- `collect`   — coalesce during a quiet window, then follow up as one turn.
- `interrupt` — abort the current run and start a new turn with the message.

`decideQueueMode()` is a pure function with the hard exclusions baked in:
- **Media** messages are never steered → followup (attachment must not detach
  from its turn).
- **Registered commands / directives** intercept immediately (handled upstream);
  never folded into a run.
- **Trust-tier guard**: a steer that would DOWNGRADE an owner run (untrusted
  content steering an owner turn) is rerouted to followup — tiers are never mixed
  mid-run. The effective steer tier is `min(run, steered)`, so a steer can never
  UPGRADE a run either.

## Steer buffer (`src/core/agent/steer-buffer.ts`)
Per-session (keyed by the loop `sessionId`) queue, cap **20**. On overflow the two
oldest entries are **coalesced** into one summarized line (never silently dropped).
The agent loop drains it at each safe iteration boundary (`loop.ts`, post-tool-exec
/ pre-model-call) and appends each message as `role: 'user'` with a `[mid-run]`
marker (tagged `• untrusted` when the effective tier is untrusted).

## Active-run registry (`src/core/agent/run-registry.ts`)
Tracks the in-flight run per session key (`channel:peerId`) with its `sessionId`
and trust `tier`. The turn handler registers a run on start and clears it in a
`finally`. This is the source of truth for "is a run active + what tier", and the
seed for GW-11's one-run-per-session guarantee.

## Wiring (`src/core/channels/gateway-turn-handler.ts`)
Before the normal enqueue, if a run is active for the session the handler consults
the mode and either steers (push to the buffer, return — no new turn), interrupts
(abort + enqueue), or falls through to followup/collect.

## Flags & default
- `SUDO_MIDRUN_STEER=1` — master switch for the producer. **Default OFF.** When off,
  behavior is byte-identical to today (per-peer serialization); the loop drain is a
  no-op because nothing fills the buffer.
- `SUDO_QUEUE_MODE_DEFAULT` — global default mode. **Default `followup`** (today's
  behavior). Set to `steer` to adopt the spec's intended default.

**DEVIATION from the spec's "global default steer":** the shipped default is the
conservative `followup` + master flag OFF because prod mid-run semantics cannot be
verified against a live daemon in this change (no-deploy constraint). The full
mechanism is built and unit-tested; flip `SUDO_MIDRUN_STEER=1` +
`SUDO_QUEUE_MODE_DEFAULT=steer` after live verification to reach the spec default.

## Deferred
- `collect` routes to the message-coalescer wiring — the decision returns `collect`
  but the handler currently treats it as followup (the coalescer is wired at the
  adapter layer, not this handler). Wire the collect→coalescer bridge in a follow-up.
- `interrupt` aborts only when the active run carries an `abort` hook; the turn
  handler does not yet thread a steering channel, so interrupt currently falls
  through to followup. The abort seam (`InMemorySteeringChannel`) exists and the
  loop already honors it — wiring `run.abort` to it is a small follow-up.
