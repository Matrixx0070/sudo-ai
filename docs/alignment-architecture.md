# SUDO-AI v5 Alignment Architecture

**Operator-facing reference. Last updated: Wave 8F.**

---

## Signal Flow Overview

```
User/Tool Input
      |
      v
[InjectionDetector] --- scan(text) ---> DetectionResult (NONE/LOW/MEDIUM/HIGH/CRITICAL)
      |                                         |
      |                              CRITICAL -> REPLAN (skip message)
      |                              MEDIUM+  -> recordOutcome(injection-detected)
      v
[EpistemicGate] --- evaluate(rationale, toolName) ---> GateDecision
      |                                                     |
      |                                         REPLAN  -> block tool call
      |                                         UNCERTAIN_RESPONSE -> inject warning
      v
[VetoGate] --- assess(toolCall) ---> VetoResult
      |                                    |
      |                         score >= threshold -> BLOCK
      |                         score <  threshold -> ALLOW
      v
[AgentLoop] --- executes tool call
      |
      v
[OutcomeRecorder] --- recordOutcome(kind, weight) ---> [TrustTierTracker]
      |                                                      |
      v                                                      v
[CommitmentAuditor]                              [AlignmentAggregator]
[CalibrationTracker]                              (8-signal composite)
      |                                                      |
      v                                                      v
[SleepCycle] --- consolidate() ----------------------> [REST Endpoints]
      |
      v
[CrossSignalDiagnostics] + [MistakePatternRecognizer] + [ReAnchorMonitor]
```

---

## 8 AlignmentAggregator Signals (Wave 6P, weights sum to 1.0)

| Signal | Weight | Description |
|---|---|---|
| `outcomeDelta` | 0.18 | Rolling delta from TrustTierTracker outcome window |
| `commitmentDrift` | 0.18 | Ratio of expired/abandoned commitments |
| `trustTier` | 0.14 | Live tier score from TrustTierTracker (HIGH=1.0, PROBATION=0) |
| `injectionRate` | 0.14 | Fraction of scanned content with injection markers |
| `recoveryPending` | 0.13 | Pending recovery protocol flag (0 or 1) |
| `discordanceScore` | 0.08 | 7-signal discordance composite (Wave 6E) |
| `confidenceCalibration` | 0.10 | Brier-drift from ConfidenceCalibrationTracker (Wave 6Q/6P) |
| `reAnchor` | 0.05 | Re-anchor event rate from ReAnchorMonitor |

**Status thresholds:** GREEN (>= 0.70), YELLOW (>= 0.40), RED (< 0.40).

---

## 9 Outcome Signal Kinds (TrustTierTracker)

| Kind | Delta | Description |
|---|---|---|
| `success` | +1.0 | Tool call completed successfully |
| `commitment-honored` | +1.5 | Commitment resolved as honored via REST |
| `epistemic-block` | +0.5 | Epistemic gate correctly blocked conjecture |
| `re-anchor` | +0.5 | Identity re-anchor event recorded |
| `failure` | -1.0 | Tool call failed |
| `commitment-expired` | -1.0 | Commitment expired unresolved |
| `veto` | -1.5 | Tool call blocked by veto gate |
| `conjecture-commit` | -2.0 | Conjecture-tagged rationale attempted commit |
| `injection-detected` | -2.5 | Injection marker found in user/tool content |

**Trust tiers:** HIGH (score >= 0.75), MEDIUM (>= 0.50), LOW (>= 0.25), PROBATION (< 0.25). Rolling 7-day window.

---

## 10 Cognition Modules

| Module | Purpose | Source |
|---|---|---|
| `CommitmentAuditor` | Tracks open agent commitments, surfaces expiring/expired items | `src/core/cognition/commitment-auditor.ts` |
| `MistakePatternRecognizer` | Fingerprints recurring error patterns via signature hashing | `src/core/cognition/mistake-pattern-recognizer.ts` |
| `TrustTierTracker` | Records outcome deltas, maintains rolling 7-day trust tier score | `src/core/cognition/trust-tier-tracker.ts` |
| `ConfidenceCalibrationTracker` | Records predicted vs actual confidence, computes Brier score | `src/core/cognition/confidence-calibration-tracker.ts` |
| `CrossSignalDiagnostics` | Detects spike correlations across trust/epistemic/veto/commitment signals | `src/core/cognition/cross-signal-diagnostics.ts` |
| `CommitmentResolutionTracker` | Persists commitment outcomes (honored/abandoned/expired-acknowledged) | `src/core/cognition/commitment-resolution-tracker.ts` |
| `ReAnchorMonitor` | Scans audit_chain for identity re-anchor events, surfaces stats | `src/core/cognition/reanchor-monitor.ts` |
| `InjectionDetector` | Pure stateless scanner — detects 10 injection marker categories | `src/core/cognition/injection-detector.ts` |
| `MistakeAutoBlockGuard` | Pre-veto short-circuit on recurring mistake patterns | `src/core/cognition/mistake-auto-block-guard.ts` |
| `AlignmentAutoRemediator` | Triggers remediation actions when alignment enters RED status | `src/core/cognition/alignment-autoremediator.ts` |

Additional supporting modules:
- `AutoThresholdTuner` — dynamic veto threshold adjustment via Brier-score feedback (`src/core/cognition/auto-threshold-tuner.ts`)
- `EpistemicGate` — classifies rationale confidence, gates tool dispatch (`src/core/cognition/epistemic-gate.ts`)
- `ReAnchorEmitter` — emits re-anchor events to audit_chain (`src/core/cognition/re-anchor-emitter.ts`)

---

## REST Endpoints (18+)

All admin endpoints require `Authorization: Bearer <token>` unless the process started without a token (tokenBuf=null).

### Audit & Inspection
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/audit/verify` | `{ ok, data: { ok: bool, rowsChecked: int } }` |
| GET | `/v1/admin/inspection` | `{ ok, data: InspectionQueueEntry[] }` |
| POST | `/v1/admin/inspection/:id/status` | `{ ok, data: { id, status } }` |

### Alignment & Trust
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/alignment` | `{ ok, data: AlignmentReport \| null }` |
| GET | `/v1/admin/trust` | `{ ok, data: { tier, score, windowSizeDays, recentOutcomes, lastAdjustedAt, breakdown? } }` |
| GET | `/v1/admin/digest` | `{ ok, data: DigestSnapshot }` — 10-subsystem unified telemetry |

### Epistemic Gate
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/epistemic/log` | `{ ok, data: EpistemicLogRow[] }` |
| GET | `/v1/admin/epistemic/stats` | `{ ok, data: { total, byTag, byDecision, blockRate, window } }` |

### Commitments
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/commitments/expiring` | `{ ok, data: CommitmentRow[] }` |
| POST | `/v1/admin/commitments/resolve` | Body: `{ commitmentRef: string (1-200), resolution: honored\|abandoned\|expired-acknowledged, notes?: string }` → `{ ok, data: ResolutionEntry }` or 400/409/503 |

### Patterns & Calibration
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/patterns` | `{ ok, data: { totalMistakes, uniquePatterns, recurringPatterns[], windowDays } }` |
| GET | `/v1/admin/calibration` | `{ ok, data: { totalSamples, brierScore, overallAvgPredicted, overallSuccessRate, buckets[] } }` |

### Diagnostics & Injection
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/diagnostics` | `{ ok, data: { trustSpikes[], epistemicBlockSpikes[], vetoSpikes[], correlations[], totalEventsScanned } }` |
| GET | `/v1/admin/injection/stats` | `{ ok, data: { totalScanned, totalSevere, bySeverity, bySource, ... } }` |

### Re-anchor
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/reanchor/stats` | `{ ok, data: { total, byTrigger, windowDays, lastReAnchorAt? } }` |
| GET | `/v1/admin/reanchor/recent` | `{ ok, data: ReAnchorEvent[] }` |

### Veto & Remediation
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/veto/threshold` | `{ ok, data: { baseThreshold, effectiveThreshold, brierScore, totalSamples, adjustment } }` |
| POST | `/v1/admin/veto/override` | Body: `{ toolName, reason, contentHash? }` → `{ ok, data: VetoOverride }` |
| GET | `/v1/admin/veto/overrides` | `{ ok, data: VetoOverride[] }` |
| GET | `/v1/admin/remediation/stats` | `{ ok, data: { observationCount, remediationsTriggered, lastRemediationAt?, lastStatus, inCooldown } }` |

### Metrics & Dashboard
| Method | Path | Shape |
|---|---|---|
| GET | `/v1/admin/metrics` | Prometheus text exposition format |
| GET | `/v1/admin/metrics/otlp` | OTLP/HTTP JSON metrics payload |
| GET | `/v1/admin/dashboard` | HTML dashboard (Bearer via header or `?token=` query param) |

---

## Environment Variables (Kill Switches)

### Core Alignment
| Variable | Effect |
|---|---|
| `SUDO_VETO_AUTO_TUNE=1` | Enables AutoThresholdTuner to adjust veto threshold based on Brier score feedback |
| `SUDO_INJECTION_STRICT=1` | InjectionDetector runs in strictMode — promotes LOW severity to MEDIUM |
| `SUDO_SLEEP_LOCKOUT_WINDOW` | Sleep cycle lockout window spec (e.g. `22:00-06:00`) |

### Identity & Instance
| Variable | Effect |
|---|---|
| `SUDO_INSTANCE_ID` | Override default instance identifier for federation (default: `hostname-pid`) |

### Federation
| Variable | Effect |
|---|---|
| `SUDO_FEDERATION_PEERS` | JSON array: `[{"name":"peer-a","url":"https://...","token":"sk_..."}]` |
| `SUDO_FEDERATION_INBOUND_TOKENS` | JSON array of bearer tokens accepted for inbound federation requests |

### Agent Routing
| Variable | Effect |
|---|---|
| `SUDO_SMART_ROUTE_CHEAP=1` | Enable cheap model routing for low-complexity tasks |
| `SUDO_CHEAP_MODEL` | Model identifier to use when cheap routing is active |

### Auth & Gateway
| Variable | Effect |
|---|---|
| `SUDO_AI_API_TOKEN` | API token for the main HTTP gateway |
| `SUDO_AI_DASHBOARD_TOKEN` | Separate token for the admin dashboard (falls back to admin token) |
| `SUDO_AI_CORS_ORIGINS` | Comma-separated allowed CORS origins |
| `SUDO_TOKEN` | CLI bearer token |
| `GATEWAY_SECRET` | Internal gateway secret |

### Rate Limiting
| Variable | Effect |
|---|---|
| `SUDO_RATE_LIMIT_PER_MIN` | Global default requests per minute |
| `SUDO_RATE_LIMIT_BURST` | Global default burst capacity |
| `SUDO_RATE_LIMIT_PERSIST=1` | Persist rate limit counters across restarts |
| `SUDO_RATE_LIMIT_<CHAN>_PER_MIN` | Per-channel rate limit override |
| `SUDO_RATE_LIMIT_<CHAN>_BURST` | Per-channel burst override |

### Agent Sandbox & Spawning
| Variable | Effect |
|---|---|
| `SUDO_SANDBOX_DISABLE=1` | Disable sandboxing for tool execution |
| `SUDO_MAX_CONCURRENT_SPAWNS` | Max simultaneous sub-agent spawns |
| `SUDO_MAX_SPAWNS_PER_SESSION` | Per-session spawn ceiling |
| `SUDO_MAX_SPAWN_DEPTH` | Maximum sub-agent nesting depth |
| `SANDBOX_REQUIRED=1` | Abort tool calls when sandbox manager unavailable |

---

## Sleep Cycle Audit Sequence

The sleep cycle consolidates the alignment state in 5 phases:

```
Phase 1: Commitment expiry scan (CommitmentAuditor)
          |
          v
Phase 2: Mistake pattern analysis (MistakePatternRecognizer)
          |
          v
Phase 3: Calibration update — flush predicted/outcome pairs (ConfidenceCalibrationTracker)
          |
          v
Phase 4: Cross-signal diagnostic correlation (CrossSignalDiagnostics)
          |
          v
Phase 5: Re-anchor scan (ReAnchorMonitor)
          + Alignment aggregator re-evaluation
          + AutoRemediator observation (triggers on RED)

Note: In DEGRADED sleep mode, only Phases 1, 2, and 4 run.
```

---

## Loop Hook Sites

The agent loop (`src/core/agent/loop.ts`) calls cognition modules at these points:

1. **Pre-message (InjectionDetector):** Each inbound user message is scanned before entering the conversation buffer. CRITICAL → message skipped (REPLAN). MEDIUM/HIGH → `recordOutcome('injection-detected')`.

2. **Pre-tool-call (EpistemicGate):** Rationale classified and impact derived before each tool dispatch. REPLAN → tool call blocked. UNCERTAIN_RESPONSE → uncertainty message injected.

3. **Pre-tool-call (VetoGate + MistakeAutoBlockGuard):** MistakeAutoBlockGuard fires before VetoGate — recurring mistake patterns short-circuit to BLOCK without consulting VetoGate score.

4. **Post-tool-call (CalibrationTracker):** Predicted confidence (from EpistemicTag mapping) and outcome (success/failure) recorded for Brier computation.

5. **Post-session (TrustTierTracker):** Session-level outcomes aggregated and persisted. Tier recomputed from rolling 7-day window.

---

## Federation Fan-out

When federation peers are configured via `SUDO_FEDERATION_PEERS`:

```
SleepCycle.consolidate()
      |
      v
federation pull: GET /v1/federation/tail?since=<ts> (each peer)
      |
      v
digest merge: peer AlignmentReport folded into local aggregator
      |
      v
inbound: POST /v1/federation/ingest (from peers, validated via SUDO_FEDERATION_INBOUND_TOKENS)
```

Cross-instance handshake occurs during sleep Phase 5. Peer pulls are fire-and-forget with 5s timeout — failures are logged and ignored (fail-open).

### Wave 10H federation signing kill-switches

All use `=== '1'` exact semantics; unset = fail-open default.

| Env var | Default | Effect |
|---|---|---|
| `SUDO_FED_VERIFY_DISABLE` | unset | Skip all ingest verification |
| `SUDO_FED_SIGN_DISABLE` | unset | Skip signing on publishEvent (separate from `SUDO_SIGNING_DISABLE`) |
| `SUDO_FED_KEY_FETCH_DISABLE` | unset | Disable peer key fetches entirely |
| `SUDO_FED_STRICT_VERIFY` | unset | Flip fail-open to fail-closed on unknown keyId |
| `SUDO_FED_KEY_CACHE_TTL_MS` | `3600000` | Numeric TTL for peer key cache |

New endpoint `GET /v1/federation/public-key` — federation bearer gated (SUDO_FEDERATION_INBOUND_TOKENS, not GATEWAY_TOKEN). TOFU trust model: first-fetch over auth'd channel establishes trust anchor for that keyId.

---

## DigestSnapshot Keys (10 subsystems)

The `/v1/admin/digest` endpoint returns a `DigestSnapshot` object with:

`windowDays`, `computedAt`, `alignment`, `trust`, `calibration`, `commitments`, `epistemic`, `patterns`, `diagnostics`, `injection`, `reanchor`, `resolutions`.

Each slice is `null` when the corresponding dep is absent (module not wired at bootstrap).

---

## Sandbox Defense Stack for tool.synthesize

`tool.synthesize` is the code-generation tool that produces and executes synthesized TypeScript inside the agent. Because it runs untrusted code, it is protected by a layered defense stack assembled across Waves 2.1 through 2.2h. The stack is active only when `SUDO_TOOL_SYNTHESIZE_ENABLED=1`; in production this variable is unset and the synthesize path is never reached.

These kill-switches are scoped exclusively to `tool.synthesize`. They are separate from `SUDO_SANDBOX_DISABLE`, which controls the general tool-execution sandbox for other built-in tools.

### Defense layers (innermost to outermost)

```
Untrusted synthesized code
        |
        v
[Layer 1 — Wave 2.1] AST static analysis
  ts.createSourceFile walker, 31-entry BANNED_MODULES,
  isProcessEnvChain + propName bans + NewExpression ctor bans
        |
        v
[Layer 2 — Wave 2.2a] Worker-side capability revocation
  process.env scrub before import
  ALLOWED_MODULES = {path, crypto, buffer} only
  Error surface: {errorCode, errorName, phase} — no message text
        |
        v
[Layer 3 — Wave 2.2b] bwrap process isolation
  child_process.spawn(bwrap)
  --cap-drop ALL
  --unshare-net / --unshare-pid / --unshare-ipc / --unshare-uts
  --die-with-parent
  (Kernel 6.8: --unshare-user + --proc incompatible; uses setuid-root bwrap instead)
        |
        v
[Layer 4 — Wave 2.2c] In-process privilege drop
  setgid(65534) THEN setuid(65534) — order mandatory (CAP_SETGID lost after setuid)
  STDOUT_MAX_BYTES = 1 MB cap
  clampErrorName: regex [^A-Za-z0-9_], 32-char limit
        |
        v
[Layer 5 — Wave 2.2g] seccomp BPF syscall allowlist
  Pure-Node BPF assembler, 121-syscall allowlist
  bwrap --seccomp via stdio[3] FD pipe
  execve STAYS in allowlist (bwrap requires it to exec node)
  Out-of-allowlist syscall -> SIGSYS -> SECCOMP_VIOLATION / SandboxError
        |
        v
[Layer 6 — Wave 2.2h] LD_PRELOAD execve seal
  bin/synth-seccomp-seal.so (C, 63 lines, gcc -shared -fPIC)
  __attribute__((constructor)) installs stacked BPF filter:
    DENY execve (NR 59) + execveat (NR 322)
    AUDIT_ARCH_X86_64 check; i386 compat -> KILL_PROCESS
  Fires during ld.so dynamic-linker init phase, BEFORE main()
  Kernel ANDs Layer 5 ALLOW + Layer 6 DENY = DENY
  SIGSYS -> existing handler maps to SECCOMP_VIOLATION / SandboxError
        |
        v
  Kernel: execve from JS is impossible
```

---

### Wave 2.1 — AST Static Analysis

Replaces the original 20-regex denylist from Wave 2. Uses `ts.createSourceFile` to parse synthesized TypeScript into an AST and walks the full tree. Rejects code containing: any of 31 banned module imports (`child_process`, `fs`, `net`, `os`, `cluster`, `worker_threads`, etc.), `process.env` property access chains, banned property names on any object, and banned constructor expressions.

Source: `src/core/tools/builtin/meta/synth-ast-analyzer.ts`

---

### Wave 2.2a — Process Environment Scrub and Error Redaction

Applied inside the worker process before any user code runs. Clears `process.env` entirely, then re-exposes only `PATH`, `LANG`, `LC_ALL`, and `TERM` (the `ENV_ALLOWLIST_BASE` set defined in `sandbox-runner.ts`). Import calls outside `ALLOWED_MODULES = {path, crypto, buffer}` are rejected before execution. All thrown errors are collapsed to `{errorCode, errorName, phase}` — no message text, no stack trace, no file paths leave the sandbox boundary.

---

### Wave 2.2b — bwrap Process Isolation

Moves the synthesize worker from `worker_threads` (same process, same address space) into a child process started via `child_process.spawn(bwrap)`. Key bwrap flags:

- `--cap-drop ALL` — drops all Linux capabilities
- `--unshare-net` — no network access from synthesized code
- `--unshare-pid` / `--unshare-ipc` / `--unshare-uts` — isolated PID, IPC, and hostname namespaces
- `--die-with-parent` — sandbox process terminates if the parent terminates

Note: Kernel 6.8 does not support the combination of `--unshare-user`, `--proc /proc`, and `--unshare-pid`. The setuid-root bwrap path is used instead, with an in-process privilege drop (Layer 4).

Source: `src/core/tools/builtin/meta/tool-synthesize.ts` — `buildSynthBwrapArgs()`

---

### Wave 2.2c — In-Process Privilege Drop, Output Cap, and Error Name Clamp

Inside the bwrap child, before any user code runs:

1. `setgid(65534)` — drops group to `nobody`. Must precede setuid; CAP_SETGID is lost once UID drops.
2. `setuid(65534)` — drops user to `nobody`.
3. `STDOUT_MAX_BYTES = 1 MB` — worker output exceeding this limit raises a `SandboxError` with `{ errorCode: 'STDOUT_EXCEEDED' }`.
4. `clampErrorName` — sanitizes any error name passed across the boundary: strips non-alphanumeric/underscore characters and truncates to 32 characters.

Source: `src/core/tools/builtin/meta/synth-bwrap-entry.cjs`

---

### Wave 2.2g — seccomp BPF Syscall Allowlist Filter

A pure-Node BPF assembler generates a 121-syscall allowlist filter. The filter is passed to bwrap via `--seccomp <fd>` using a stdio[3] file descriptor pipe. Any syscall outside the allowlist raises SIGSYS, which the worker's signal handler maps to `SECCOMP_VIOLATION` / `SandboxError`.

`execve` (NR 59) deliberately remains in the allowlist at this layer: bwrap itself needs `execve` to launch the node worker process. The execve-deny responsibility is handled by Layer 6.

Kill-switch: `SUDO_SECCOMP_DISABLE=1` disables this layer. Layer 6 (LD_PRELOAD seal) is independent and remains active unless its own kill-switch is set.

Source: `src/core/tools/builtin/meta/synth-seccomp-filter.ts`

---

### Wave 2.2h — LD_PRELOAD Execve Seal

A 63-line C shared library (`bin/synth-seccomp-seal.so`, built via `gcc -shared -fPIC -O2`) is injected into the worker via bwrap `--ro-bind` and `--setenv LD_PRELOAD`. Its `__attribute__((constructor))` function runs during the dynamic linker initialization phase, after `ld.so` completes the node process's own `execve`, but before `main()`. At that point it installs a second stacked seccomp BPF filter that:

- DENYs `execve` (NR 59) with `SECCOMP_RET_KILL_PROCESS`
- DENYs `execveat` (NR 322) with `SECCOMP_RET_KILL_PROCESS`
- Checks `AUDIT_ARCH_X86_64`; i386 compat syscalls result in `KILL_PROCESS`
- Uses `SECCOMP_RET_KILL_PROCESS` (not `KILL_THREAD`) to correctly terminate multi-threaded Node without leaving zombie threads

The kernel ANDs seccomp filters: Layer 5 ALLOWs `execve`; Layer 6 DENYs `execve`. Combined result: DENY. No modification to Layer 5 is required.

**Why LD_PRELOAD and not a C wrapper:** A C wrapper process that applies seccomp and then calls `exec(node)` is architecturally broken. Seccomp applies immediately to the wrapper process, which blocks the wrapper's own `execve` call — verified empirically (exit code 159). The LD_PRELOAD constructor approach is correct because it fires after `ld.so` has already completed the `execve` that launched node, during the dynamic linker's library-init phase.

The `.so` is committed as `bin/synth-seccomp-seal.so` (sha256: `f4fe8b99535def86788be03a26fb666383e90e63f924cc7bd3bb1b2defeb3af9`, deterministic rebuild). `postinstall` runs `pnpm build:seal || true` (tolerates hosts without gcc).

Kill-switch: `SUDO_EXEC_GATE_DISABLE=1` skips the `--ro-bind` and `--setenv LD_PRELOAD` bwrap arguments. Layer 5 (seccomp allowlist) remains active.

Source: `src/core/tools/builtin/meta/synth-seccomp-seal.c`, `scripts/build-synth-seal.sh`, `src/core/tools/builtin/meta/tool-synthesize.ts` — `getSealPath()` + `buildSynthBwrapArgs()`

---

### Observability (Wave 2.2h-obs)

Four metrics for the seal subsystem are exposed at `GET /v1/admin/metrics` in Prometheus text exposition format:

| Metric | Type | Description |
|---|---|---|
| `sudo_synth_seal_install_total` | Counter | Successful LD_PRELOAD seal installs |
| `sudo_synth_seal_missing_so_total` | Counter | `.so` file absent at seal path — fail-open events |
| `sudo_synth_seal_sigsys_total` | Counter | SIGSYS fires (execve-deny triggered from inside sandbox) |
| `sudo_synth_seal_up` | Gauge | Seal subsystem health: 1 = nominal, 0 = degraded |

All counters are label-free (no PII). Wired via the existing `MetricsCollector` singleton — no new infrastructure.

During the 48-hour staging soak, expected steady state: `seal_install_total` increments on each synthesize call, `sigsys_total` remains 0 for benign calls, `missing_so_total` remains 0.

---

### Kill-switch Matrix

These three variables are independent and may be combined in any combination. They are specific to `tool.synthesize` and do not affect the general `SUDO_SANDBOX_DISABLE` agent-execution sandbox.

| Variable | Default | Effect when set to 1 |
|---|---|---|
| `SUDO_TOOL_SYNTHESIZE_ENABLED` | unset (OFF) | Enables the tool.synthesize path. Must be ON for any sandbox layer to be exercised. |
| `SUDO_SECCOMP_DISABLE` | unset (OFF) | Disables Wave 2.2g BPF syscall allowlist filter. Layer 6 LD_PRELOAD seal remains active. |
| `SUDO_EXEC_GATE_DISABLE` | unset (OFF) | Disables Wave 2.2h LD_PRELOAD seal (`--ro-bind` and `--setenv LD_PRELOAD` omitted). Wave 2.2g BPF filter remains active. |

30-second rollback for the seal layer: `pm2 restart sudo-ai-v5-staging --update-env` with `SUDO_EXEC_GATE_DISABLE=1` set in the pm2 ecosystem config.

---

### Deploy Topology

| Instance | Port | Synthesize | seccomp | LD_PRELOAD seal |
|---|---|---|---|---|
| `sudo-ai-v5` (prod) | 18900 | OFF — `SUDO_TOOL_SYNTHESIZE_ENABLED` unset | Code present, inert | Code present, inert |
| `sudo-ai-v5-staging` | 18901 | ON | ACTIVE | ACTIVE — 48h soak |

The prod instance never reaches the sandbox layers because `tool.synthesize` itself is disabled. The seccomp and seal code is present in the prod build but is never invoked. The staging instance runs the complete stack and is the primary soak environment.

---

### Architectural Invariants

These three properties must be preserved when modifying the sandbox stack:

1. **Seccomp filter stacking uses AND semantics.** The kernel evaluates stacked filters as AND: Layer 5 ALLOWs `execve`; Layer 6 DENYs `execve`; combined result is DENY. Adding a third stacked filter must account for this — a new ALLOW layer cannot undo a previous DENY.

2. **The C wrapper approach for seccomp-stacked execve-deny is architecturally broken.** A process that installs seccomp and then calls `execve(node)` will receive SIGSYS on its own `execve` call (exit 159, verified empirically). The LD_PRELOAD constructor is the correct pattern: it fires after the caller's `execve` completes, during `ld.so` dynamic-linker init, before `main()`.

3. **`--dir /sandbox --chmod 0755 /sandbox` must precede `--ro-bind quarantinePath /sandbox/quarantine.ts`.** bwrap auto-creates mount parent directories at mode 0700 owned by root. After the in-process `setuid(65534)` drop, UID 65534 cannot traverse a 0700 root-owned directory. Without the pre-declaration, `import('file:///sandbox/quarantine.ts')` fails with `ERR_MODULE_NOT_FOUND` — silently, because the file exists from root's perspective. This is the canonical fix; see `tool-synthesize.ts:663` (production) and `meta-tools.test.ts:1444` (test mirror).
