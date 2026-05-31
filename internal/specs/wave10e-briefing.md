# Wave 10E Briefing

**Delivered by Scout 2026-04-19.**

## Scope
Two dead-module wirings:
1. TaintTracker.attachHooks (Wave 10 P1 build, 0 callers)
2. ArtifactSigner on approved proposals (Wave 10 P1 build, 0 callers)

---

## Item 1 — TaintTracker

**Module:** `/root/sudo-ai-v4/src/core/security/taint-tracker.ts` (317 lines)
- `export class TaintTracker`:
  - `attachHooks(hooks: HookManager): void`
  - `tag(toolName, source, level?)`
  - `propagate(parentTaintIds[], toolName)`
  - `checkViolation(toolName, safety, taintId)`
  - `onToolResult(event)`
- `export const taintTracker` — singleton at module level
- Subscribes to `'after:tool-call'` events
- Emits `taint-assigned` + `taint-violation` back via `hooks.emit`
- Tracks: tool_output, external_fetch, channel_message, user_input

**Types:** `/root/sudo-ai-v4/src/core/shared/wave10-types.ts` L604-616
- `Taint`, `TaintLevel (clean|low|medium|high|critical)`, `TaintSource`, `TaintViolation`, `TaintSet`

**Tests:** `tests/security/taint-tracker.test.ts` — ~20 cases, covers all methods + attachHooks with mock HookManager

---

## Item 2 — ArtifactSigner

**Module:** `/root/sudo-ai-v4/src/core/security/signer.ts` (222 lines)
- `export class ArtifactSigner`:
  - `sign(payload, artifactType): SignedArtifact`
  - `verify(artifact): ArtifactVerifyResult`
- `export const artifactSigner` — singleton
- Algorithm: **ed25519** (`crypto.generateKeyPairSync`)
- Key files: `data/keys/wave10-signer.{pub,priv}` (DER hex-encoded); env override `SUDO_SIGNER_KEY_DIR`
- Private key `0o600` permissions enforced
- `artifactType`: `'skill' | 'bench_report' | 'config_proposal' | 'trace_pattern' | 'generic'`

**Proposal endpoints:**
- `POST /v1/admin/learning/proposals/:id/approve` → `learning-routes.ts:143` handleApprove (config_proposal)
- `POST /v1/admin/skill-optimizer/:id/approve` → separate route (skill)

**Tests:** `tests/security/signer.test.ts` — 13 cases, all artifactTypes covered

---

## Wiring Targets

### TaintTracker
| File | Change |
|------|--------|
| `src/cli.ts:288` | `taintTracker.attachHooks(hooks)` after HookManager init |
| `src/core/agent/loop.ts:544` | Add `setTaintTracker` duck-typed setter (Wave 6L pattern); call `onToolResult()` at `after:tool-call` fire point |
| `src/core/agent/loop.ts:1221` | Call `checkViolation()` at `before:tool-call` pre-dispatch |
| `src/cli.ts:923` | Wire `taintTracker` into `finalAgentLoop` via setter (after InjectionDetector wiring) |

`hooks` variable available at cli.ts:288; passed as 8th arg to AgentLoop at line 907. Setter pattern avoids constructor reorder.

### ArtifactSigner
| File | Change |
|------|--------|
| `src/core/gateway/learning-routes.ts:143` | Import `artifactSigner`; after `proposalStore.approve(id)`, call `artifactSigner.sign(proposal, 'config_proposal')`; include in 200 response |
| `src/core/skills/skill-optimizer.ts` | In `approveProposal()`, call `artifactSigner.sign(proposal, 'skill')` |
| `src/cli.ts` | No new wiring — singleton auto-initialises |

---

## Dead-Module Confirmation

Grep across `src/`:
- `TaintTracker` / `taintTracker` / `attachHooks`: **0 callers** outside module + test
- `ArtifactSigner` / `artifactSigner`: **0 callers** outside module + test

Both dead-confirmed.

---

## Existing Security Infrastructure (live)

| Module | File | Wired |
|--------|------|-------|
| InjectionDetector | cognition/injection-detector.js | cli.ts:707 + 923 |
| MistakeAutoBlockGuard | cognition/mistake-auto-block-guard.js | cli.ts:520 veto-gate |
| VetoGate | agent/veto-gate.ts | `setAutoBlockGuard` |
| HookManager | hooks/index.ts | cli.ts:288 |
| AlignmentAggregator | (via loop) | 8-signal |
| ProposalStore | learning/proposal-store.ts | cli.ts:1841 |
| SkillOptimizer | skills/skill-optimizer.ts | cli.ts:1863 |

---

## Kill-Switches

**Existing relevant:** `SUDO_SIGNER_KEY_DIR` (path override, NOT disable)

**Missing, to add in Wave 10E:**
- `SUDO_TAINT_DISABLE=1`
- `SUDO_SIGNING_DISABLE=1`

Pattern precedent: `SUDO_SECCOMP_DISABLE`, `SUDO_EXEC_GATE_DISABLE`, `SUDO_INJECTION_STRICT`, `SUDO_VETO_AUTO_TUNE`, `SUDO_SEAL_REQUIRED`.

---

## Open Architect Questions

**TaintTracker:**
1. **Memory growth** — `_taints` Map unbounded. `clear()` exists. Use `session:end` hook calling `clear()` OR per-session instances instead of singleton?
2. **Hook re-entry risk** — `attachHooks()` line 111 emits `'after:tool-call'` from inside `'after:tool-call'` handler. `checkViolation()` line 249 emits `'before:tool-call'`. HookManager guard against recursive emission? Architect verify.
3. **checkViolation call-site** — Where in loop.ts? `safety: 'readonly' | 'destructive'` sourced from ToolDefinition metadata or existing `isDestructiveTool()` heuristic?
4. Kill-switch `SUDO_TAINT_DISABLE=1`, fail-open always.

**ArtifactSigner:**
5. **Sign timing** — at `proposalStore.approve(id)` (REST-side, external operator only) vs at `AgentConfigEvolver.propose()` creation (system-side, tamper-resistance from storage)? Spec says "approved proposals".
6. **Response shape** — `signedArtifact` wraps `{proposal}` or alongside? `GET /v1/admin/learning/proposals` return signed/unsigned?
7. **Public key exposure** — no `/v1/admin/public-key` endpoint. Federation peers need it. Scope in 10E or follow-on?
8. **Both proposal types** — `config_proposal` + `skill` both in scope? Confirm.
9. **Key rotation** — auto-generate only, no rotation. Out of scope; flag future wave.
10. Kill-switch `SUDO_SIGNING_DISABLE=1`.

---

## TL;DR

- Both modules fully built with unit tests. Zero callers.
- TaintTracker wires via `attachHooks(hooks)` at cli.ts:288 + setter in loop.ts for `onToolResult`/`checkViolation`.
- ArtifactSigner wires into 2 approve handlers (learning-routes + skill-optimizer) using `sign(proposal, artifactType)`.
- Need kill-switches `SUDO_TAINT_DISABLE` + `SUDO_SIGNING_DISABLE`.
- 3 architect decisions block builders: memory-growth strategy, hook re-entry safety, sign-timing location.
