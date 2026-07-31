# ADR 0007 — SUDO Eval Sandbox Platform (containment-grade agent evaluation)

Status: **Proposed** (design complete; Phase 1 implementation pending)
Date: 2026-07-31
Author: Fable (autonomous session)
Relates to: ADR-0002 (Verifiability Ladder), ADR-0004 (self-heal posture), Spec 8 (trust-tier sandbox), CLAUDE.md invariants 1–11

## Problem

We need a production-grade, containment-style evaluation platform for SUDO AI itself:
isolated ephemeral execution, a policy layer over fs/network/env/secrets/processes, a
tool gateway every call passes through, full audit capture, repeatable scenarios
(including fault injection and fake credentials), a scoring framework, clean-state
guarantees, deterministic replay, and optional multi-agent role scenarios.

Constraint that dominates everything: this is a **single 4-core / 15 GB VPS that also
runs the production agent** (≈9 GB RAM already committed), and the CLAUDE.md gap-repair
rule forbids parallel plumbing — the platform must be built out of the existing seams,
not beside them.

## Measured environment facts (probed 2026-07-31 on this host)

| Fact | Value | Consequence |
|---|---|---|
| `/dev/kvm` | **absent**; `vmx/svm` cpuinfo flags = 0 | Firecracker / Kata / Cloud Hypervisor **impossible** on this box |
| Docker | 29.1.3, runc 1.3.4, overlay2, seccomp+AppArmor+cgroup-v2 all enabled | Hardened runc containers fully available (already used by Spec 8) |
| gVisor `runsc` | not installed; kernel 6.8, cgroup2 | **Installable**; default `systrap` platform needs no KVM |
| bubblewrap | 0.9.0 | Owner-tier fast path (existing); not used for evals |
| Resources | 4 cores, 15 GB (≈6.9 GB available), 81 GB disk free | Max 1–2 concurrent sandboxes, hard cgroup caps, evals must never starve prod |

## Isolation technology decision

Evaluated from first principles against the actual threat model: the adversary is **our
own agent misbehaving** — buggy code, prompt-injected turns, runaway loops, attempted
policy violations under test — not a nation-state kernel-exploit author.

- **Firecracker / Kata (microVMs)** — best-in-class isolation (separate guest kernel,
  ~125 ms boot, minimal device model; what Lambda/Fly use). **Rejected on hardware
  fact**: requires KVM; this VPS exposes no `/dev/kvm` and no VT-x/AMD-V. Revisit only
  if we ever move to bare metal (recorded as future option, not a capability drop).
- **Kubernetes** — solves multi-node scheduling, rolling deploys, service discovery.
  We have one node, one tenant, and a control plane would cost 1–2 GB of the ~7 GB we
  have free while adding zero isolation (pods are still runc underneath). **Rejected**:
  wrong problem. k3s reconsidered only if the platform outgrows this host.
- **Docker + hardened runc** — **baseline (chosen)**. Already in-tree as the Spec 8
  untrusted backend (`src/core/sandbox/backends/docker-backend.ts`): `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--network none` by default, `--memory` ==
  `--memory-swap`, `--pids-limit 64`, seccomp default profile. Shared-kernel risk is
  accepted for first-party agent evaluation; kernel attack surface is mitigated by
  cap-drop + seccomp + no-new-privileges.
- **gVisor (runsc, systrap)** — **chosen as the escalation tier**. Userspace kernel
  intercepts syscalls, so container→host kernel surface shrinks to the ~70 syscalls
  Sentry itself uses; needs no KVM; installs as a Docker runtime class
  (`--runtime=runsc`), i.e. zero new plumbing — the existing docker backend grows one
  optional flag. Costs: syscall-heavy workloads run 2–10× slower and some /proc &
  ioctl surface is missing — acceptable for eval workloads, and per-scenario opt-in.
- **bwrap** — retained for what it already does (owner-tier fast path). Eval runs never
  use it: all eval turns run as untrusted-tier.

**Decision: Docker+runc hardened as default eval isolation; gVisor `runsc` as the
per-scenario `isolation: "runsc"` escalation for adversarial/fault scenarios; microVMs
and K8s rejected on measured facts.** Defense in depth is two independent layers: the
tool gateway (semantic policy, in-process) and the container (mechanical confinement,
out-of-process) — a bypass of one still hits the other.

## Architecture

New code lives in `src/core/eval/sandbox/` as an extension of the existing
`src/core/eval/` subsystem. Reuse-first mapping:

| Requirement | Existing seam (reused) | New code |
|---|---|---|
| Tool gateway | `ToolRegistry.execute()` choke point (`src/core/tools/registry.ts:797`), same interception point as the rewind hook (`registry.ts:876`) | `eval-gate.ts` hook: validate → policy check → record → (optionally) inject fault |
| Isolation | Spec 8 untrusted tier: run turns with `caller:{isOwner:false}` → Docker fail-closed (`sandbox-runner.ts:539` refuses host exec even under `SUDO_SANDBOX_DISABLE=1`) | per-run workspace mount + optional `runtime: runsc` in docker backend |
| Policy: network | `SUDO_SANDBOX_EGRESS_ALLOWLIST` + `egress-proxy.ts` (logs every request) | scenario manifest → per-run allowlist; proxy log joined into run journal |
| Policy: env/secrets | — | env scrubber (allowlist only) + fake-credential fixtures = locally registered canary values (F19/F67 guard pattern trips if they ever egress) |
| Policy: fs/process | docker backend mounts + `--pids-limit`/`--memory` | scenario-declared workspace fixtures; nothing else mounted |
| Turn execution | `AgentLoop.run()` (`loop.ts:854`) via the `AgentBenchRunner` pattern | `EvalRunner`: fresh DATA_DIR + fresh session per run (clean state); `persistentMemory: snapshot-id` opt-in seeds a copied mind.db, never the prod one |
| LLM budget/attribution | `runWithPolicy` (`src/llm/policy.ts:584`) with a dedicated `eval` caller; `llm_calls.turn_id/step_n` join | per-run and per-day USD caps (invariant 10), halt-gracefully-and-report |
| Scenario format | `gateway-e2e` YAML runner (`src/core/eval/gateway-e2e/`) | extended manifest: task, fixtures, mock services, faults, policy, grading, budgets |
| Fault injection | — | two injectors: gateway-level (deny/delay/corrupt a tool result) and service-level (per-scenario local mock HTTP server scripted to 429/500/timeout/flap) |
| Scoring | Verifiability Ladder rungs (ADR-0002): 0–3 code-graded, 4–5 judged; `bench-store.ts`, `bench-regression.ts`, `eval-gate.ts` | score vector {success, correctness, efficiency, robustness, policy_compliance}; policy score computed from gateway ground truth, not self-report; judge route pinned ≠ route under test (invariant 7) |
| Audit | `llm_calls`, `policy_decisions`, traces.db, egress-proxy log | append-only per-run journal (JSONL, content-addressed): prompt, plan, every tool call+result hash, file ops, network requests, cgroup resource samples, verdicts |
| Replay | `scripts/shadow-replay.mts` pattern | L1 replay: recorded LLM responses + live tools (tests harness/tool changes); L2 replay: everything from journal (fully deterministic; tests scoring changes) |
| Multi-agent | `sessions.send` (Spec 6: hop≤3, 32 KB, queue) + personas | scenario `roles:` graph (planner/researcher/coder/reviewer/critic/manager), one session per role inside one sandboxed run |
| Ops surface | bench nightly cron + `/v1/admin/bench` routes + dashboard | `sudo eval run <scenario>` CLI; results into bench.db; ladder verdict rows cached per `(route, model, rung, goldenSetVersion)` in gateway.db per ADR-0002 |

### Non-negotiable platform invariants

1. Eval runs never touch prod state: fresh DATA_DIR per run; memory persistence is
   explicit, snapshot-seeded, and discarded after the run.
2. All eval turns are untrusted-tier → Docker fail-closed. There is no host-exec eval.
3. Everything the sandboxed agent produces is untrusted external text → F18 quarantine
   before any of it reaches prod memory (invariant 2). By default it reaches nothing.
4. Judge independence per invariant 7; no independent route → HOLD for human review.
5. Per-run + per-day spend budgets (invariant 10); exhaustion halts gracefully and
   reports on the Telemetry tab.
6. Hot path untouched: nothing in `src/core/agent`, `src/llm`, `src/core/memory`,
   `src/core/brain` imports the eval sandbox. The gateway hook is fail-open outside an
   eval context and a no-op when `SUDO_EVAL` is unset (same contract as the rewind hook).
7. Concurrency ≤ 2 sandboxes, each cgroup-capped (default 1 CPU / 1 GB), so prod never
   starves.

## Phased plan

- **Phase 0 (skeleton)** — this ADR; scenario manifest schema + validator; run-journal
  writer; `evalGate` hook registered at the choke point as a no-op. Flag `SUDO_EVAL`
  (default unset).
- **Phase 1 (core loop)** — `EvalRunner` (ephemeral DATA_DIR, untrusted caller, budget
  caps); env scrubber + canary credentials; code-graded scoring (rungs 0–3) into
  bench.db; CLI `pnpm eval:run <scenario>`; 5 seed scenarios: coding task,
  restricted-resource, fake-credential canary, unreliable-service, failure-recovery
  drill. DONE = all 5 run end-to-end in Docker, journal complete, scores land in
  bench.db, prod untouched (verified by mtime/hash of prod DATA_DIR).
- **Phase 2 (policy + faults)** — gateway deny rules + fault injectors; scriptable mock
  service harness; gVisor runtime class installed + `isolation: runsc` option; cgroup
  resource sampling into the journal.
- **Phase 3 (replay + judges + gate)** — L1/L2 replay from journal; rung 4–5 LLM
  judges (pinned independent route); regression gate wired into the nightly bench cron
  under its existing $2/day cap (raise = Frank gate).
- **Phase 4 (multi-agent + surface)** — role-graph scenarios over sessions.send;
  dashboard tab; golden sets under `evals/ladder/rung-<n>/` fulfilling ADR-0002's
  planned layout.

## Consequences

+ The platform *is* the Verifiability Ladder engine ADR-0002 planned — one system, two
  consumers (route admission + agent regression).
+ Isolation posture is honest about the hardware: strongest available tier (gVisor)
  without pretending microVMs are possible here.
– Shared-kernel residual risk vs. microVMs; accepted for first-party workloads and
  recorded as the revisit trigger if hardware changes.
– gVisor adds a runtime dependency (single static binary) and a compat surface to test.
