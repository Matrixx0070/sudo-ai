# OpenClaw — deliberate non-adoption record (GW-14)

**Date:** 2026-07-18. Companion to `docs/OPENCLAW_GATEWAY_IMPROVEMENTS_PLAN.md`
(items GW-1…GW-15, the things we *are* borrowing). This file records the
things we looked at in the OpenClaw monorepo (commit `faf3dbd`, v2026.7.2) and
**deliberately chose NOT to copy**, with the rationale for each — so a future
session does not re-propose them as "obvious wins." Linked from
`docs/CORE_ROADMAP.md`.

Each entry is a settled decision. Reopen one only with new evidence that the
rationale below no longer holds.

---

## 1. Sandbox-off by default

OpenClaw ships with tool execution unsandboxed unless the operator opts in.
SUDO's Spec-8 trust-tiered sandbox is **fail-closed**: untrusted turns always
land in a Docker tier that outranks `SUDO_SANDBOX_DISABLE`, owner turns get
bwrap confinement. Our whole security posture (quarantine, zones, canary
discipline) assumes code from an untrusted turn cannot touch the host. A
sandbox-off default would silently void that assumption on every fresh deploy.
The blast radius is total; the convenience saved is trivial. **No.**

## 2. Agent holds operator authority (`security="full"`)

OpenClaw lets a configured agent run with the operator's full authority — the
model can authorize its own privileged actions. SUDO's invariant #4/#8 is the
opposite: gates are harness-enforced even when human-mediated, frozen surfaces
(identity/constitution/PROTECTED_PATHS) are read-only to the agent, and no
agent message is ever consent. Handing operator authority to the model
collapses the successor gate, the constitution guard, and every approval flow
into "the model said yes." That is precisely the failure mode our architecture
exists to prevent. **No.**

## 3. Cross-agent OAuth token read-through

OpenClaw's multi-agent hosting lets one agent read another agent's live OAuth
tokens (shared credential store, read-through by design). SUDO keeps
credentials behind the SecretRef seam (`{env|file|exec}`) and the vault, with
per-surface scopes; a token is resolved at point of use, never handed laterally
to another run. Read-through turns one compromised or prompt-injected run into
a credential-exfiltration pivot across every connected account. **No** — the
SecretRef/vault indirection stays the only path to a secret.

## 4. 45-channel / 157-extension surface sprawl

OpenClaw supports ~45 chat channels and ~157 extensions. Every channel is an
inbound-untrusted-text surface and an outbound-delivery surface; every
extension is supply-chain risk (invariant #11 canary discipline, OSV audit).
SUDO deliberately runs a small, hardened channel set (Telegram, email, web
chat, webhooks) each fully wired through the MessageRouter, quarantine, and the
outbox. Breadth here is not a feature — it is 45× the injection surface and
157× the supply-chain surface for a single-operator system. We add a channel
only when it earns its hardening cost. **No** to sprawl-as-a-goal.

## 5. Multi-tenant-in-one-process hosting

OpenClaw hosts many tenants in one process with in-process isolation. SUDO's
tenancy model (`tenant-manager.ts`) launches tenants with OS-level isolation
and refuses to co-host without it unless `SUDO_TENANCY_ALLOW_UNSAFE` is set
(posture-registered). A single-process multi-tenant model shares a heap, a
SQLite handle space, and a crash domain across trust boundaries — one tenant's
OOM or native-module fault takes down all of them, and memory-safety bugs
become cross-tenant data leaks. We are a single-operator system anyway; the
in-process multi-tenant complexity buys us nothing and weakens isolation.
**No.**

## 6. ACP pluggable agent runtimes

OpenClaw exposes an Agent Client Protocol so third-party agent runtimes can be
swapped in behind the same surface. SUDO is a **single-brain** architecture:
one identity, one constitution, one successor gate, one memory. A pluggable
runtime layer is orthogonal to — and in tension with — the identity pulse and
succession machinery that assume a single continuous agent. This is not a
security veto; it is an architectural mismatch. Adopting ACP would mean
maintaining an abstraction that nothing in our design wants. **No, orthogonal.**

## 7. Device-node pairing (companion apps)

OpenClaw pairs companion apps / device nodes (phone/desktop clients) into the
mesh. SUDO ships no companion apps today; the pairing surface we *do* want is
the human-recoverability case for unknown chat senders (GW-6 pairing codes),
which is a much narrower thing. Building device-node pairing now would be
speculative surface for a client population of zero. Revisit only if/when a
first-party companion app actually exists. **No, premature.**

---

*If you are a future session about to propose one of the above: the answer was
considered and is no. Bring new evidence or leave it closed.*
