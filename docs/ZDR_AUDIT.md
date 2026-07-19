# F105 — ZDR (Zero-Data-Retention) Audit + Enforcement

**Status:** shipped. `SUDO_ZDR` is now a testable contract across every
user-content persistence path, not a 3-call-site accident.

## What ZDR means here

When ZDR is active (`SUDO_ZDR=1` / `SUDO_DATA_RETENTION_OPT_OUT=1`, a `--zdr`
CLI flag, a JWT claim, or config), **new writes of user content are skipped or
redacted**, while **operational metadata is still persisted** so the system
keeps functioning (budgets, dedup, delivery state machine, error clustering,
retention counters all keep working on hashes/counts/timestamps).

ZDR governs **new writes only**. It never deletes existing rows — retroactive
purge of already-stored history is a separate, explicit decision (not in scope
here). The gate lives at each store's write seam (`isZDRBlocked(op)` /
`isZDRBlockedForChannel(op, channel)` in `src/core/privacy/zdr-mode.ts`); ZDR
OFF is the exact prior behavior on every path.

## Enforcement surface: before → after

Before F105, `SUDO_ZDR` was honored at **3 user-content call-sites** (all
session-persistence):

- `src/core/agent/loop.ts` — end-of-run `sessionManager.save()` + a
  consciousness-recording guard.
- `src/core/sessions/write-through.ts` — per-message immediate persistence.
- (`src/cli.ts` trace_upload gate = telemetry, not local user-content.)

After F105, **6 user-content persistence paths** are honored (3 pre-existing +
**4 newly added**), plus the per-channel privacy hook.

## Sweep table

| Store / path | File (write seam) | Writes user content? | Honored ZDR before? | Action / now |
|---|---|---|---|---|
| Session save | `core/agent/loop.ts` | yes (messages) | ✅ | unchanged (pre-existing) |
| Write-through message persist | `core/sessions/write-through.ts` | yes (messages) | ✅ | unchanged (pre-existing) |
| Consciousness recording (loop) | `core/agent/loop.ts` | yes | ✅ | unchanged (pre-existing) |
| **traces.db raw capture** | `core/learning/trace-store.ts` `record()` | yes (prompt/response/args/result raw) | ❌ | **NEW:** null raw payloads under ZDR; keep hashes + tokens + latency + model + timestamps. `modelParams` (sampling config) is operational, retained. |
| **gateway.db call log** | `llm/logging.ts` `record()` | yes (`ir_request`/`ir_response`) | ❌ | **NEW:** null the two IR columns under ZDR; keep caller/route/tokens/cost/latency/`content_sha256`/outcome so budgets (GW-1) + dedup keep working. |
| **episodic memory** | `core/consciousness/episodic-memory/index.ts` `recordEpisode()` | yes (episode summary) | ❌ | **NEW:** skip `saveEpisode` under ZDR (in-memory cognition still runs; nothing hits consciousness.db). |
| **structured memory** | `core/memory/structured-memory.ts` `saveMemory()` | yes (`content`) | ❌ | **NEW:** return the constructed record WITHOUT the `fs.writeFile` under ZDR; callers still get a usable object. |
| **channel outbox payload** | `core/channels/delivery-queue.ts` | yes (reply text) | ❌ | **NEW (mitigated):** a durable outbox MUST hold the payload until the platform confirms delivery (crash-safety). Under ZDR — global or per-channel — the payload is **tombstoned on ack** (`{text:'', _zdrRedacted:true}`) so the reply text is not retained post-delivery. Row + delivery state preserved. |

### Operational-metadata paths (fine to keep — NOT user content)

`trace_aggregates`, `llm_calls` counters, `deliveries` state machine, content
fingerprints (sha256), token/cost/latency figures, timestamps, model/route
identifiers. These carry no message text and are what keep the system
functional under ZDR.

## Per-channel privacy hook

A channel can declare `privacy: 'zdr'` and get ZDR semantics for its turns even
when the **global** flag is OFF. Seam in `src/core/privacy/zdr-mode.ts`:

- `setChannelPrivacy(channel, 'zdr' | 'standard')` — programmatic registration.
- `SUDO_ZDR_CHANNELS=telegram,email` — env-driven list, loaded at
  `ZDRModeManager.resolve()` via `loadChannelPrivacyFromEnv()` (additive).
- `isChannelZDR(channel)` / `getChannelPrivacy(channel)`.
- `isZDRBlockedForChannel(op, channel)` — blocks when the **global** gate blocks
  `op`, OR when the channel is marked `zdr` **and** `op` is a content-bearing
  operation (`session_persistence` / `memory_write` / `consciousness_recording`).
  A per-channel mark suppresses user content, **not** operational counters
  (telemetry/trace_upload are unaffected by a channel mark).

Wired at the channel-outbox seam (`delivery-queue.ts` uses the channel on the
delivery row), which is where channel context flows into persistence.

## Deliberately EXEMPT by design (do NOT ZDR these)

Per the hard invariant *never weaken the security/audit posture*, the following
are **intentionally not** ZDR-gated. Flagging them explicitly:

- **Security / audit stores** — `audit.db`, `alignment-audit.db`, `trust.db`,
  `calibration.db`, the audit JSONLs (F16/F115 substrate). These are the
  security audit trail; silently dropping their writes under ZDR would blind the
  safety posture. If ZDR must ever cover them, that is a separate, explicit
  security decision — not folded in here.
- **Injection-scan / guard decisions** — the memory injection scanner
  (`guardMemoryWrite`) still runs before the ZDR check on `saveMemory`; ZDR must
  never bypass a security guard.
- **Frozen identity / constitution surfaces** — untouched (invariant 4); ZDR is
  a persistence gate, not an identity mutation.
- **Durable outbox payload at enqueue time** — retained until delivery
  (crash-safety); the ZDR contract for the outbox is *retained only until
  delivered, then tombstoned on ack* rather than *never written*.

## Tests

`tests/privacy/zdr-persistence.test.ts` — for each newly-honored path: ZDR ON =
user content absent/redacted while metadata persists; ZDR OFF = behavior
unchanged. Plus the per-channel hook (set/clear, `isZDRBlockedForChannel`
content-vs-metadata ops, env-list load, global-overrides-channel).
