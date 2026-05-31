# Wave 10E Spec — TaintTracker + ArtifactSigner Wiring

**Architect:** Principal Architect  
**Date:** 2026-04-19  
**Target:** +15–25 integration tests, tsc clean, security APPROVED zero HIGH+

---

## §1 Scope + Decisions

### Scope

Wire two dead modules into live code paths:
1. `TaintTracker.attachHooks()` — subscribe to loop events, clear on session end
2. `ArtifactSigner.sign()` — sign proposals at both approve REST handlers

### D1 — TaintTracker Memory Growth: Option A

**Decision: Singleton + `clear()` on `session:end` hook.**

Rationale: `session:end` is already a first-class `HookEvent` (hooks/index.ts line 32). The singleton pattern is established in the module itself. Per-session instances (B) would require constructor reorder across AgentLoop plus session lifecycle injection — out of scope. Bounded cap (C, Wave 10C pattern) is premature optimisation for a map that naturally clears. Adding `clear()` to the `session:end` handler is a one-liner.

Fallback: also register a module-level idle timer (1 hour) that calls `clear()` on the singleton to handle sessions that never fire `session:end` (e.g., crashed processes). Builder A owns this idle-guard. Use `setInterval` stored in `taint-tracker.ts`, cleared on `attachHooks` re-call.

### D2 — Hook Re-Entry Safety: Early-Return Guard (one-line patch)

**Decision: Add guard `if (ctx.meta?.['taintEvent']) return;` as the first line of the `after:tool-call` handler in `attachHooks`.**

Background: `hooks/index.ts` has zero recursion protection. `emit()` (line 241) is a plain async for-loop; it will infinitely re-enter when the handler calls `hooks.emit('after:tool-call', ...)` at line 111. The 20 existing unit tests use a mock HookManager whose `emit` is a no-op stub — they do not exercise this path.

The re-emit in the handler (lines 111–119) is telemetry-only (sets meta for downstream consumers). The correct fix is the meta-presence guard: when the re-emitted event arrives with `meta.taintEvent` already set, the handler returns immediately. This is a one-line patch to `taint-tracker.ts` only — no change to `hooks/index.ts`. Zero new HookEvent enum entries required.

Builder A must add an explicit integration test that attaches a real (non-mock) HookManager, emits `after:tool-call`, and asserts the handler runs exactly once (regression test for this exact bug).

### D3 — ArtifactSigner Sign Timing: Option A

**Decision: Sign at the approve REST handlers (`proposalStore.approve()` call-site).**

Rationale: Both briefing and federation use-case establish the trust boundary as the external-operator approval action. Sign-on-store (B) would add signing overhead to every proposal write, including rejected ones. Option C (both) adds a subdiscriminator with no current consumer. The approved proposal is the authoritative artifact for federation peer verification.

Both approve handlers are in scope for Wave 10E:
- `learning-routes.ts:158` — `proposalStore.approve(id)` → `artifactType: 'config_proposal'`
- `admin-routes.ts:1719` — `skillOptimizationStore.approve(id)` → `artifactType: 'skill'`

### Kill-switches

| Env var | Default | Meaning when set to `1` |
|---------|---------|------------------------|
| `SUDO_TAINT_DISABLE` | unset (OFF) | Skip `attachHooks` entirely; taintTracker remains inert |
| `SUDO_SIGNING_DISABLE` | unset (OFF) | Skip `sign()` calls; approve responses return `{ proposal }` only |

"Default OFF" means the feature is **enabled** when the var is unset — consistent with `SUDO_SECCOMP_DISABLE`, `SUDO_EXEC_GATE_DISABLE`, `SUDO_VETO_AUTO_TUNE` precedent (setting to `1` disables). Both are fail-open: disabling them never blocks the approval flow.

### checkViolation call-site and `safety` parameter

The `safety` parameter is used at `checkViolation(toolName, safety, taintId)` where:
- `safety` is always passed as `'readonly'` from the loop call-site.
- `TaintTracker.checkViolation` internally calls `isDestructiveTool(toolName)` at line 232 regardless of the `safety` argument.
- Passing `'readonly'` is therefore a safe no-op placeholder. Builder A must NOT change the method signature (tests cover the existing signature). The loop call-site passes `'readonly'` uniformly.

**taintId source**: Loop.ts tracks tool results per iteration. The `before:tool-call` handler receives `tc.name`. The taintId to check must come from the most recent taint for that tool. Builder A adds a `private _lastTaintIds: Map<string, string>` to AgentLoop (toolName → most recent taintId), populated in the `after:tool-call` emission block. The `before:tool-call` handler reads from this map. If no entry exists for the tool, `checkViolation` is skipped (fail-open).

### Response shape for approve endpoints

**When `SUDO_SIGNING_DISABLE` is unset (signing active):**
```
{ "proposal": { ...existing }, "signedArtifact": { "payload": { ...proposal }, "signedAt": "...", "keyId": "...", "signature": "...", "artifactType": "config_proposal" } }
```

**When `SUDO_SIGNING_DISABLE=1`:**
```
{ "proposal": { ...existing } }
```

Backward compatible: existing consumers of `{ proposal }` continue to work. `signedArtifact` is additive.

### GET /v1/admin/public-key

**Deferred to Wave 10F.** No federation peer verification path is live today. Flag in §3 Non-Goals.

---

## §2 File Boundaries (Per Builder)

### Builder A — Taint (exclusively owns)

```
src/core/security/taint-tracker.ts          — patch: D2 early-return guard + idle-timer
src/core/agent/loop.ts                      — setter + _lastTaintIds map + 2 call-sites + session:end wire
src/cli.ts                                  — attachHooks at :288, setTaintTracker at :923
tests/security/taint-tracker-integration.test.ts   — NEW integration test file
```

Builder A does NOT touch:
- `src/core/hooks/index.ts` (no enum changes needed for Option A D2)
- `src/core/gateway/` (Builder B territory)
- `src/core/shared/wave10-types.ts` (no new types)

### Builder B — Signer (exclusively owns)

```
src/core/gateway/learning-routes.ts        — import artifactSigner, sign at approve, update response
src/core/gateway/admin-routes.ts           — sign at skill optimize approve, update response
tests/security/signer-integration.test.ts  — NEW integration test file
```

Builder B does NOT touch:
- `src/core/security/signer.ts` (no code changes needed — singleton already initialises lazily)
- `src/cli.ts` (Builder A territory; singleton auto-initialises, no cli.ts wiring needed for signer)
- `src/core/agent/loop.ts` (Builder A territory)

**Zero file overlap.**

---

## §3 Non-Goals (explicitly out of scope)

- `GET /v1/admin/public-key` endpoint — deferred to Wave 10F
- Key rotation — flagged for future wave (comment in signer.ts already notes this)
- Changing `TaintTracker.checkViolation` signature — keep existing 3-arg form
- Per-session TaintTracker instances — D1 ruled out
- Sign-on-store (proposal creation) — D3 ruled out
- Changes to `src/core/hooks/index.ts` HookEvent union — D2 ruled out
- Staging pm2 reload — forbidden (48h seal soak active through 2026-04-21T14:00 UTC)
- New npm dependencies
- Signing `GET` list responses (`/v1/admin/learning/proposals`) — only approve endpoints change

---

## §4 Implementation Details

### Builder A Task 1 — Patch `taint-tracker.ts` (D2 fix + idle timer)

File: `/root/sudo-ai-v4/src/core/security/taint-tracker.ts`

In `attachHooks()`, replace the body of the `after:tool-call` handler. The very first line of the async callback must be:

```ts
if (ctx.meta?.['taintEvent']) return;
```

This short-circuits the re-emitted event (which carries `meta.taintEvent = 'taint-assigned'`) and prevents infinite recursion.

Add an idle-guard timer at module bottom (after singleton export):

```ts
// Idle-guard: clear taint map hourly to prevent unbounded growth in
// long-running sessions that never fire session:end.
let _idleTimer: ReturnType<typeof setInterval> | undefined;

function _startIdleGuard(tracker: TaintTracker): void {
  if (_idleTimer) clearInterval(_idleTimer);
  _idleTimer = setInterval(() => { tracker.clear(); }, 60 * 60 * 1000);
  if (typeof _idleTimer === 'object' && _idleTimer \!== null && 'unref' in _idleTimer) {
    (_idleTimer as NodeJS.Timeout).unref(); // do not prevent process exit
  }
}
_startIdleGuard(taintTracker);
```

`attachHooks()` should also call `_startIdleGuard(this)` to reset the timer on re-attach.

Also add a warning comment immediately above the re-emit block (lines 111-119 of taint-tracker.ts) to warn future authors:

```ts
// FRAGILITY NOTE: This re-emit fires ALL registered 'after:tool-call' handlers,
// not just this one. The guard at the top of this handler prevents infinite
// recursion from our own re-entry. Any future handler registering on
// 'after:tool-call' MUST add the same guard:
//   if (ctx.meta?.['taintEvent']) return;
// Without it, it will see spurious events with incomplete context (no sessionId/success).
// A follow-on wave should replace this re-emit with a dedicated log.info call to
// eliminate the cross-handler coupling risk entirely.
await hooks.emit('after:tool-call', {  // ← existing emit call
```

### Builder A Task 2 — `loop.ts` setter + call-sites

File: `/root/sudo-ai-v4/src/core/agent/loop.ts`

**Step 1 — Add private field** (after existing `_skillDiscovery` field, line ~204):
```ts
// Wave 10E: TaintTracker — optional, set via setter after construction.
private _taintTracker?: {
  onToolResult(event: { name: string; result: unknown; ancestorTaintIds?: string[] }): { taintId: string };
  checkViolation(toolName: string, safety: 'readonly' | 'destructive', taintId: string): { reason: string } | null;
};
private _lastTaintIds: Map<string, string> = new Map();
```

**Step 2 — Add setter** (after `setSkillDiscovery`, line ~423):
```ts
/** Wire TaintTracker after construction (Wave 10E). Fail-open if duck-type mismatch. */
setTaintTracker(tt: {
  onToolResult(event: { name: string; result: unknown; ancestorTaintIds?: string[] }): { taintId: string };
  checkViolation(toolName: string, safety: 'readonly' | 'destructive', taintId: string): { reason: string } | null;
}): void {
  if (tt && typeof tt.onToolResult === 'function' && typeof tt.checkViolation === 'function') {
    this._taintTracker = tt;
    log.info('AgentLoop: TaintTracker attached');
  } else {
    log.warn('AgentLoop: setTaintTracker: invalid duck-type — ignoring');
  }
}
```

**Step 3 — after:tool-call call-site** (immediately after the existing `after:tool-call` emission at line ~544):
```ts
// Wave 10E: TaintTracker — tag tool result (fail-open).
try {
  if (this._taintTracker && event.type === 'tool-result') {
    const _tr = event as { type: string; name: string; result: unknown };
    const taintResult = this._taintTracker.onToolResult({ name: _tr.name, result: _tr.result });
    this._lastTaintIds.set(_tr.name, taintResult.taintId);
  }
} catch { /* fail-open */ }
```

**Step 4 — Taint violation check — placement is CRITICAL**

The taint check MUST be placed AFTER the veto for-loop closes (after line 1205, the closing `}` of the `for (const tc of validToolCalls)` block) and BEFORE the `activeToolCalls` filter at line 1208. This is the only location where adding to `vetoedIds` still causes the filter to exclude the tool call.

Placement that is WRONG: inside the `for (const tc of activeToolCalls)` loop at ~line 1219. `activeToolCalls` is already computed by then; mutating `vetoedIds` there has no effect.

Correct placement (between lines 1205 and 1207):
```ts
// Wave 10E: TaintTracker — scan all pending tool calls for taint violations before dispatch.
// MUST be placed BEFORE the activeToolCalls filter at line 1208.
// Adding to vetoedIds here causes the existing filter to drop the tainted tool call.
if (this._taintTracker) {
  for (const tc of validToolCalls) {
    if (vetoedIds.has(tc.id)) continue; // already blocked by veto gate
    try {
      const priorTaintId = this._lastTaintIds.get(tc.name);
      if (priorTaintId) {
        const violation = this._taintTracker.checkViolation(tc.name, 'readonly', priorTaintId);
        if (violation) {
          log.warn({ toolName: tc.name, reason: violation.reason, sessionId: state.sessionId }, 'TaintTracker: violation blocked tool call');
          vetoedIds.add(tc.id);
          session.messages.push({ role: 'system', content: `[TaintTracker] Tool \${tc.name} blocked: \${violation.reason}` });
        }
      }
    } catch { /* fail-open — never block tool execution due to taint error */ }
  }
}

// Filter out any vetoed tool calls before dispatch.  ← existing line 1208
```

**Step 5 — `session:end` clear** (within the existing `session:end` emission handler, or register a second `session:end` hook immediately after the session:start emission at line ~585):
```ts
void this.hooks?.emit('session:end', ...) is called elsewhere. Register a session:end handler on the HookManager from cli.ts (see Task 3).
```

### Builder A Task 3 — `cli.ts` wiring

File: `/root/sudo-ai-v4/src/cli.ts`

**Import** at top of file (group with security imports):
```ts
import { taintTracker } from './core/security/taint-tracker.js';
```

**Attach at HookManager init (line ~288)** — immediately after `log.info('HookManager initialized')`:
```ts
// Wave 10E: Wire TaintTracker into HookManager (fail-open).
if (\!process.env['SUDO_TAINT_DISABLE']) {
  try {
    taintTracker.attachHooks(hooks);
    // Register session:end hook to clear taint map and prevent memory growth.
    hooks.register('session:end', async () => { taintTracker.clear(); }, 'TaintTracker: clear on session end');
    log.info('TaintTracker attached to HookManager');
  } catch (err) {
    log.warn({ err: String(err) }, 'TaintTracker.attachHooks failed — taint tracking disabled');
  }
}
```

**Wire into finalAgentLoop (after InjectionDetector wiring at line ~923)**:
```ts
// Wave 10E: Wire TaintTracker into agent loop (fail-open).
if (\!process.env['SUDO_TAINT_DISABLE']) {
  try {
    finalAgentLoop.setTaintTracker(taintTracker);
  } catch (err) {
    log.warn({ err: String(err) }, 'TaintTracker wiring into loop failed — taint violation checks disabled');
  }
}
```

### Builder B Task 1 — `learning-routes.ts` (config_proposal signing)

File: `/root/sudo-ai-v4/src/core/gateway/learning-routes.ts`

**Add import** (after existing imports):
```ts
import { artifactSigner } from '../security/signer.js';
```

**Extend `LearningRoutesDeps`** — no change needed; artifactSigner is a module-level singleton, not injected.

**Patch `handleApprove`** — replace the `sendJson(res, 200, { proposal })` at line 159 with:
```ts
// Wave 10E: sign approved proposal (fail-open).
let signedArtifact: ReturnType<typeof artifactSigner.sign> | undefined;
if (\!process.env['SUDO_SIGNING_DISABLE']) {
  try {
    signedArtifact = artifactSigner.sign(proposal, 'config_proposal');
    log.info({ id, keyId: signedArtifact.keyId }, 'learning-routes: proposal signed');
  } catch (signErr) {
    log.warn({ err: String(signErr), id }, 'learning-routes: signing failed — returning unsigned proposal');
  }
}
const approveResponse = signedArtifact ? { proposal, signedArtifact } : { proposal };
sendJson(res, 200, approveResponse);
```

### Builder B Task 2 — `admin-routes.ts` (skill optimization signing)

File: `/root/sudo-ai-v4/src/core/gateway/admin-routes.ts`

**Add import** at top (group with security/crypto imports):
```ts
import { artifactSigner } from '../security/signer.js';
```

**Patch `handleSkillOptimizationApprove`** — replace `sendJson(res, 200, { ok: true, data: updated })` at line 1720 with:
```ts
// Wave 10E: sign approved skill proposal (fail-open).
let signedArtifact: ReturnType<typeof artifactSigner.sign> | undefined;
if (\!process.env['SUDO_SIGNING_DISABLE']) {
  try {
    signedArtifact = artifactSigner.sign(updated, 'skill');
    log.info({ id, keyId: signedArtifact.keyId }, 'Admin: skill proposal signed');
  } catch (signErr) {
    log.warn({ err: String(signErr), id }, 'Admin: signing failed — returning unsigned proposal');
  }
}
const skillApproveResponse = signedArtifact ? { ok: true, data: updated, signedArtifact } : { ok: true, data: updated };
sendJson(res, 200, skillApproveResponse);
```

---

## §5 Test Plan

### Builder A — `tests/security/taint-tracker-integration.test.ts` (NEW)

Target: **12 new tests**

| # | Name | What it proves |
|---|------|---------------|
| INT-T1 | `attachHooks with real HookManager — no infinite loop` | Real HookManager, emit `after:tool-call`, assert handler fires exactly once (D2 regression) |
| INT-T2 | `emit count is exactly 1 on after:tool-call` | Count handler invocations using a spy registered before and after taintTracker |
| INT-T3 | `taint assigned after emit` | After emitting `after:tool-call`, `taintTracker.size === 1` |
| INT-T4 | `session:end clear via hook` | Register session:end handler, emit session:end, assert `size === 0` |
| INT-T5 | `clear() resets map` | tag() three taints, clear(), size === 0 |
| INT-T6 | `setTaintTracker duck-type validation — accepts valid` | Pass mock with both methods, no log warn |
| INT-T7 | `setTaintTracker duck-type validation — rejects invalid` | Pass null / missing method, setter logs warn |
| INT-T8 | `checkViolation blocks high-taint destructive tool — tool excluded from execution` | Attach a real TaintTracker to a mock loop; emit a high-taint after:tool-call; then verify the tool call is excluded from activeToolCalls (not just that violation object is returned). Asserts the placement in loop.ts actually prevents execution. |
| INT-T9 | `checkViolation allows high-taint readonly tool` | Tag with level='high', non-destructive toolName → null |
| INT-T10 | `SUDO_TAINT_DISABLE=1 — attachHooks not called` | Mock process.env, verify taintTracker remains size 0 after emit |
| INT-T11 | `_lastTaintIds populated after onToolResult` | AgentLoop mock calls onToolResult, confirms taintId stored per toolName |
| INT-T12 | `idle-timer does not block process exit` | Call _startIdleGuard, assert returned Timeout has been unref'd (check `_idleTimer` via inspection or mock) |

### Builder B — `tests/security/signer-integration.test.ts` (NEW)

Target: **10 new tests**

| # | Name | What it proves |
|---|------|---------------|
| INT-S1 | `sign config_proposal returns valid SignedArtifact` | Real artifactSigner, sign a proposal, check all fields present |
| INT-S2 | `verify config_proposal succeeds` | Sign then verify, result.valid === true |
| INT-S3 | `sign skill returns artifactType=skill` | Correct type field on output |
| INT-S4 | `POST /approve learning route — signedArtifact in response when signing enabled` | Mock proposalStore, call handleApprove, parse response, check signedArtifact field |
| INT-S5 | `POST /approve learning route — only proposal returned when SUDO_SIGNING_DISABLE=1` | Set env, call handleApprove, assert no signedArtifact key |
| INT-S6 | `POST /approve admin skill route — signedArtifact in response when signing enabled` | Mock skillOptimizationStore, call handleSkillOptimizationApprove, check signedArtifact |
| INT-S7 | `POST /approve admin skill route — only data returned when SUDO_SIGNING_DISABLE=1` | Set env, assert response has no signedArtifact |
| INT-S8 | `signing failure is fail-open — proposal still returned` | Mock artifactSigner.sign to throw, response is { proposal } with no 500 |
| INT-S9 | `signedArtifact.payload equals proposal` | Verify payload round-trips correctly |
| INT-S10 | `keyId is 8 hex chars of public key` | Assert keyId matches first 8 chars of known key DER hex |

**Total new tests: 22** — within the +15–25 target.

---

## §6 Risks + Rollback

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| D2 infinite loop if guard missing | HIGH pre-fix | INT-T1/T2 are explicit regression tests; Builder A must verify test passes before cli.ts wiring |
| `vetoedIds` scope miss in loop.ts | MEDIUM | Builder A must grep for `vetoedIds` declaration line and ensure taint violation block is within same block scope |
| Key file not found on fresh staging | LOW | Signer is lazy-init; auto-generates keys on first call. No code change needed. |
| signedArtifact breaks existing approve consumers | LOW | Response is additive (`signedArtifact` is a new key); existing consumers reading `proposal` are unaffected |
| session:end never fires (crash) | LOW | Idle-timer fallback (D1 addendum) provides 1-hour GC safety net |

**Rollback:**
- `SUDO_TAINT_DISABLE=1` — disables all taint wiring at boot; no code rollback needed
- `SUDO_SIGNING_DISABLE=1` — disables signing; approve endpoints revert to current behaviour
- Both kill-switches take effect on next `pm2 reload sudo-ai-v5` (prod only; staging soak must not be reloaded until 2026-04-21T14:00 UTC)

---

## §7 Kill-Switches

| Variable | Default | Description |
|----------|---------|-------------|
| `SUDO_TAINT_DISABLE` | unset (feature ON) | Set `=1` to skip `taintTracker.attachHooks()` and `setTaintTracker()`. Taint map stays empty; no violations fired. |
| `SUDO_SIGNING_DISABLE` | unset (feature ON) | Set `=1` to skip `artifactSigner.sign()` at both approve handlers. Response shape reverts to pre-10E `{ proposal }` / `{ ok, data }`. |

Both vars are checked with `process.env['VAR_NAME']` (truthy check — any non-empty string disables). Both are fail-open: disabling the variable never causes a 500 or breaks the core approval flow.

Neither kill-switch is committed to `pm2 ecosystem.config.cjs` by default. Operator sets ad-hoc via `pm2 restart sudo-ai-v5 --update-env`.

---

*End of Wave 10E Spec.*
