# Wave 6E — Discordance Signal, Veto Override REST, Sleep DEGRADED Consequences

Wave 6E extends SUDO-AI v5 with three primitives: wiring the cross-stream discordance detector into the alignment aggregator as a 7th scoring signal, adding admin REST endpoints for manual pre-approval or pre-denial of veto decisions, and giving the sleep cycle's DEGRADED state observable runtime consequences with an operator reset path. All three ship against baseline 1573/1573 tests; target is ≥1600 passing post-integration.

---

## 1. Primitive A — Discordance as 7th Alignment Signal

### Signal weights (7-signal composite)

The `AlignmentAggregator` now evaluates seven signals. Weights must sum exactly to 1.0.

| Signal             | Wave 6D weight | Wave 6E weight | Notes                          |
|--------------------|---------------|---------------|--------------------------------|
| `outcomeDelta`     | 0.25          | **0.20**      | Reduced to accommodate new signal |
| `commitmentDrift`  | 0.25          | **0.20**      | Reduced                        |
| `trustTier`        | 0.20          | **0.15**      | Reduced                        |
| `injectionRate`    | 0.15          | 0.15          | Unchanged                      |
| `recoveryPending`  | 0.10          | **0.15**      | Bumped +0.05 to close sum      |
| `reAnchor`         | 0.05          | 0.05          | Unchanged                      |
| `discordanceScore` | —             | **0.10**      | New in Wave 6E                 |
| **Total**          | **1.00**      | **1.00**      |                                |

`discordanceScore` ranges [0, 1] where 0 means fully aligned. Its contribution to the composite is **inverted**: `WEIGHTS.discordanceScore * (1 - resolvedDiscordanceScore)`. High discordance reduces the loyalty score, mirroring the `commitmentDrift` inversion pattern.

### Loop wiring (loop.ts lines 817–844)

Before constructing `AlignmentSignals`, the loop collects discordance inputs and calls `detectDiscordance()` from `discordance-detector.ts` (read-only this wave):

```typescript
const discordanceResult = detectDiscordance({
  cadence:      { callsInWindow: state.iteration, baselineCallsPerWindow: 10 },
  toolGraph:    { recentToolNames: activeToolCalls.map(tc => tc.name) },
  outcomeTrend: { recentOutcomeTypes: [] },   // future expansion placeholder
  selfReport:   { text: finalText ?? '' },
});
// added to AlignmentSignals:
discordanceScore: discordanceResult.score,
```

Fail-open semantics: if `detectDiscordance()` throws, the aggregator neutralizes the value to 0.5 and returns GREEN — no crash, no disruption to tool execution. NaN and undefined inputs are also neutralized at signal resolution.

### Operator interpretation

The aggregator's `_buildDiagnosis()` method pushes `'cross-stream discordance elevated'` into the diagnosis array when `signals.discordanceScore > 0.6`.

| Status | Dominant discordance meaning |
|--------|------------------------------|
| GREEN  | Score within tolerance; discordance contribution within expected range |
| YELLOW | Composite is marginal; check diagnosis for `'cross-stream discordance elevated'` — multiple streams diverging |
| RED    | Aggregator is below blocking threshold; discordance contribution is pulling score down; investigate cadence anomalies, tool-graph drift, or self-report inconsistency |

---

## 2. Primitive B — Veto Manual-Override REST

Two new admin endpoints allow the operator to pre-set an APPROVE or DENY decision for a specific tool call by its `decisionId`, before the veto gate runs. The store is SQLite-backed (`veto-override-store.ts`) and records are permanent — no DELETE endpoint exists.

### Routes

| Method | Path                          | Description                       |
|--------|-------------------------------|-----------------------------------|
| POST   | `/v1/admin/veto/override`     | Pre-set allow or deny for a tool call |
| GET    | `/v1/admin/veto/overrides`    | List all recorded overrides        |

### POST /v1/admin/veto/override

Request body:

```json
{
  "decisionId": "string (required)",
  "action":     "allow | deny (required)",
  "reason":     "string (required)"
}
```

Validation rules:

- `decisionId`: non-empty string; must not contain `/` or `..` (path traversal rejected with 400 and a `log.warn`)
- `action`: must be exactly `"allow"` or `"deny"`
- `reason`: required, non-empty; if `action === "deny"` then `reason.length >= 20` is enforced
- If `vetoOverrideStore` is absent from deps: 503 `{ "ok": false, "error": "Override store not configured" }`
- If `decisionId` already exists (UNIQUE constraint): 409 `{ "ok": false, "error": "Override already exists for this decisionId" }`

On success, `deps.auditTrail.recordTriple()` is called immediately with:

```json
{ "mistake": "veto manual override", "learned": "<reason>", "commitment": "override logged", "ttl_days": 7 }
```

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decisionId": "tc_a1b2c3d4", "action": "deny", "reason": "Tool targets production database; deny until reviewed by ops team"}' \
  http://localhost:18900/v1/admin/veto/override
```

Response 201:

```json
{
  "ok": true,
  "data": {
    "id": "ov_9f3e1a22",
    "decisionId": "tc_a1b2c3d4",
    "action": "deny",
    "reason": "Tool targets production database; deny until reviewed by ops team",
    "createdAt": "2026-04-13T11:00:00.000Z",
    "createdBy": "admin"
  }
}
```

Response codes: 201 success, 400 validation failure, 401 unauthorized, 409 duplicate decisionId, 503 store not configured, 500 internal error.

### GET /v1/admin/veto/overrides

| Parameter | Type | Range   | Default | Notes           |
|-----------|------|---------|---------|-----------------|
| `limit`   | int  | 1–500   | 100     | Results newest first |

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "http://localhost:18900/v1/admin/veto/overrides?limit=20"
```

Response 200:

```json
{
  "ok": true,
  "data": {
    "overrides": [ { "id": "...", "decisionId": "...", "action": "deny", "reason": "...", "createdAt": "...", "createdBy": "admin" } ],
    "count": 1
  }
}
```

### SQLite schema

```sql
CREATE TABLE IF NOT EXISTS veto_overrides (
  id          TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  action      TEXT NOT NULL CHECK(action IN ('allow','deny')),
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
```

### Loop intercept (loop.ts lines 758–810)

Before the veto gate for-loop, a `decisionId` is generated per tool call:

```typescript
const decisionIdMap = new Map<string, string>();
for (const tc of validToolCalls) {
  decisionIdMap.set(tc.id, genId());
}
```

Inside the loop, before `runVetoGate()`:

```typescript
const decisionId = decisionIdMap.get(tc.id)!;
const manualOverride = this.vetoOverrideStore?.getOverride(decisionId) ?? null;
if (manualOverride) {
  if (manualOverride.action === 'deny') {
    // block: push system message, add to vetoedIds, continue
  } else {
    // allow: skip runVetoGate(), proceed to execution
  }
}
// else: run existing runVetoGate() logic unchanged
```

`vetoOverrideStore` is injected into `AgentLoopDeps` as an optional field (`vetoOverrideStore?: VetoOverrideStore`) for backward compatibility.

### Audit trail

Every override submission writes one `auditTrail.recordTriple()` row. The `veto_overrides` SQLite table is permanent and append-only. Use `GET /v1/admin/veto/overrides` to inspect all decisions.

---

## 3. Primitive C — Sleep DEGRADED Consequences

### What triggers DEGRADED

`_runIntegrityCheck()` in `consolidator.ts` calls `verifyAccumulatorIntegrity()`. When `coherent === false`, `_degraded` is set to `true`. Previously this flag had no runtime consequences. Wave 6E makes it observable.

### Runtime behavior when DEGRADED

At the start of `startSleep()`, a snapshot `startedDegraded = this._degraded` is taken before Phase 1 runs. The snapshot is stable for the full cycle — if a mid-cycle integrity check resets `_degraded`, the phase-skip decision is unaffected.

- **Phase 3 (Counterfactual Simulation)**: skipped when `startedDegraded === true`
- **Phase 5 (Dream Generation)**: skipped when `startedDegraded === true`
- **Phases 1, 2, 4**: always run regardless of degraded state
- **Warn log**: emitted at cycle start when degraded:

```
level: "warn"
{ degraded: true, sessionId: "<id>" }
message: "Sleep-cycle starting in DEGRADED state — Phase 3 (Counterfactuals) and Phase 5 (Dream) will be skipped"
```

### Manual reset

`consolidator.ts` exposes a new public `clearDegraded()` method. It sets `_degraded = false` and emits `log.info`. It is a no-op when the flag is already false.

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Manual operator reset after integrity check"}' \
  http://127.0.0.1:18900/v1/admin/sleep/reset-degraded
```

Response 200:

```json
{ "ok": true, "data": { "wasDegrade": true, "ts": 1712345678901 } }
```

`wasDegrade` reflects the state at the time of the call (true if degraded before reset, false if already clear). `ts` is the Unix timestamp in milliseconds at which the reset was processed.

Response codes:

| Code | Meaning |
|------|---------|
| 200  | Success |
| 400  | `reason` field missing or shorter than 10 characters |
| 401  | Unauthorized |
| 500  | Internal error |

Calling this endpoint also writes one `auditTrail.recordTriple()` row.

### Route registration

`admin-sleep-routes.ts` exports `registerAdminSleepRoutes(server, deps, tokenBuf)`. The integrator wires it alongside `registerAdminRoutes()` in the gateway bootstrap file. Auth helpers (`sendJson`, `sendError`, `isAuthorised`, `extractBearer`) are copied inline — `admin-sleep-routes.ts` does not import from `admin-routes.ts` to avoid circular dependency risk.

---

## 4. Configuration

No new environment variables are introduced in Wave 6E. Existing `GATEWAY_TOKEN` covers all three new endpoints.

---

## 5. Operator Runbook

### Inspect current alignment state

Alignment scores and diagnoses appear in the agent loop's structured logs. Filter for `'cross-stream discordance elevated'` in the diagnosis field to identify sessions where discordance is the dominant signal.

### Pre-approve or pre-deny a veto decision

To pre-deny a tool call that you expect the agent will attempt:

1. Obtain the `decisionId` from loop logs (logged at DEBUG level before veto-gate runs) or generate one externally and coordinate with the system injecting the tool call.
2. Submit the override before the tool call reaches the veto gate:

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decisionId": "<id>", "action": "deny", "reason": "Operator pre-block: awaiting approval from security team"}' \
  http://localhost:18900/v1/admin/veto/override
```

3. Verify with `GET /v1/admin/veto/overrides`.

**Important:** `decisionId`s are cryptographically random and generated per loop iteration via nanoid. Reactive pre-approval (watching DEBUG logs for a newly-logged decisionId, then POSTing an override before the veto gate runs) is NOT viable — the veto check executes synchronously in the same iteration. Effective pre-registration requires coordinating a known decisionId with the caller injecting the tool call upstream, or extending the feature in a future wave to match on `{toolName, normalizedArgs}` hash. For this wave, treat the override endpoint as: (a) post-incident audit evidence and (b) a foundation for content-hash-based pre-approval in Wave 6F.

Override records are permanent. If an override was submitted in error and the decision ID has not yet been consumed by the loop, the only recovery path is to let the override fire (deny or allow) and then address the outcome in the next session. No delete endpoint exists.

### Review all overrides

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "http://localhost:18900/v1/admin/veto/overrides?limit=100"
```

### Check and clear DEGRADED state

The sleep cycle's DEGRADED flag is visible in logs at each `startSleep()` invocation. To clear it manually:

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Manual operator reset after integrity check"}' \
  http://127.0.0.1:18900/v1/admin/sleep/reset-degraded
```

If `"wasDegrade": false` is returned, the cycle was already clean. If `"wasDegrade": true`, the degraded state has been cleared and the next sleep cycle will run all five phases.

### Log locations

All wave 6E events use the project logger (`createLogger`). Key log fields:

| Event | Level | Key fields |
|-------|-------|------------|
| Discordance score computed | DEBUG | `discordanceScore`, `sessionId` |
| Discordance elevated | informs diagnosis | appears in aggregator output |
| Sleep DEGRADED cycle start | WARN | `{ degraded: true, sessionId }` |
| DEGRADED cleared by operator | INFO | `{ module: 'sleep-cycle' }` |
| Veto override submitted | via auditTrail | recorded as commitment triple |
| Sleep reset submitted | via auditTrail | recorded as commitment triple |

---

## 6. Rollback Reference

Wave 6E baseline (pre-deploy): 1573/1573 tests, tsc clean, pm2 sudo-ai-v5 online.

If rollback is required, restore to the Wave 6D backup:

```
/tmp/sudo-ai-backups/sudo-ai-v4/20260413T124905Z-pre-wave6d-deploy/restore.sh
```

This returns the system to Wave 6D state (1573/1573, discordance detector present but not wired into aggregator, no veto override endpoints, no sleep DEGRADED consequences).
