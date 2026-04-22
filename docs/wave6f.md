# Wave 6F — Content-Hash Pre-Approval, Prepared-Statement Caching, Alignment REST, Epistemic Honesty Gate

Wave 6F extends SUDO-AI v5 with four primitives: content-hash-based decisionId for deterministic pre-approval of tool calls by argument fingerprint, prepared-statement caching in VetoOverrideStore for reduced per-call SQLite overhead, a read endpoint for the AlignmentAggregator's last evaluation report, and an Epistemic Honesty Gate that prevents tool execution when the loop's own rationale text is below a confidence threshold. All four ship against baseline 1629/1629 tests; target is ≥1670 passing post-integration.

---

## 1. Primitive A — Content-Hash decisionId

### Hash recipe

Every tool call is fingerprinted by a 32-character hex content hash derived from the tool name and its sanitized arguments. The authoritative recipe:

```typescript
import { createHash } from 'node:crypto';
import { sanitizeArgsForPrompt } from '../agent/veto-gate.js';

function computeContentHash(toolName: string, args: Record<string, unknown>): string {
  const sanitized = sanitizeArgsForPrompt(args);      // returns JSON.stringify(sanitized, null, 2)
  const payload   = `${toolName}:${sanitized}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}
```

`sanitizeArgsForPrompt` returns `JSON.stringify(sanitized, null, 2)`. The pretty-print format (`null, 2`) is part of the canonical form. Do not alter the call site in `veto-gate.ts`. Hashing the concatenation `toolName:sanitizedJsonString` is deterministic across calls; the same tool name and argument values always produce the same 32-character hex string.

### Schema v2

`veto_overrides` gains a nullable `content_hash` column with a partial unique index. The migration is idempotent and safe to run on every process startup:

```sql
ALTER TABLE veto_overrides ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_veto_overrides_content_hash
  ON veto_overrides(content_hash)
  WHERE content_hash IS NOT NULL;
```

The `ALTER TABLE` is wrapped in try/catch; the error is suppressed when the message contains `"duplicate column name"` and re-thrown for any other error. Existing rows with `content_hash = NULL` remain valid and are queryable by `decisionId` as before.

### Updated VetoOverride interface

```typescript
export interface VetoOverride {
  id:          string;
  decisionId:  string;
  contentHash: string | null;   // null for rows created before Wave 6F
  action:      'allow' | 'deny';
  reason:      string;
  createdAt:   string;
  createdBy:   string;
}
```

### New method: getOverrideByContentHash

```typescript
getOverrideByContentHash(contentHash: string): VetoOverride | null;
```

Returns the first override with a matching `content_hash`, or null if not found. Fails open on any DB error: logs the error, returns null, does not throw.

### Pre-approval workflow

The content-hash lookup enables an operator to register an approval or denial for a specific tool+args combination before that combination appears in a live loop iteration.

1. Compute the hash offline using the same recipe (`sha256(toolName:sanitizeArgsForPrompt(args)).slice(0,32)`). Hash inputs must exactly match what the loop will produce — tool name must be the registered tool name, args must be the expected argument object before sanitization.
2. POST the override keyed by `contentHash` (no `decisionId` required):

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contentHash":"<32-hex>","action":"allow","reason":"Pre-approved deploy script"}' \
  http://127.0.0.1:18900/v1/admin/veto/override
```

3. When the loop executes that exact tool+args combination, `getOverrideByContentHash` returns the registered override and the veto gate is bypassed without waiting for an operator decision at runtime.

The request body schema for `POST /v1/admin/veto/override` in Wave 6F accepts either or both identifiers:

| Field        | Type            | Required                        |
|--------------|-----------------|----------------------------------|
| `decisionId` | string          | At least one of the two required |
| `contentHash`| string (32 hex) | At least one of the two required |
| `action`     | `allow` or `deny` | Yes                            |
| `reason`     | string          | Yes                              |

Validation: if neither `decisionId` nor `contentHash` is present, the route returns 400 `"decisionId or contentHash required"`. If only `contentHash` is provided, `decision_id` is set to a generated UUID internally to satisfy the existing UNIQUE constraint.

### Override lookup order

Inside the loop's tool-dispatch block, content-hash lookup is checked first; decisionId lookup is the fallback:

```typescript
const decisionId  = decisionIdMap.get(tc.id)!;
const contentHash = contentHashMap.get(tc.id)!;
const manualOverride =
  (contentHash ? this.vetoOverrideStore?.getOverrideByContentHash(contentHash) : null)
  ?? this.vetoOverrideStore?.getOverride(decisionId)
  ?? null;
```

Both `decisionId` and `contentHash` are logged in audit triples for every tool call.

---

## 2. Primitive B — Prepared-Statement Caching

`VetoOverrideStore` previously called `this.db.prepare(...)` inline at each method invocation. Wave 6F replaces all inline `prepare` calls with class-level cached statements initialized once in the constructor after `_initSchema()`, following the pattern established in `src/core/files/store.ts:43-48`.

The four cached statements are:

| Field                   | Query purpose                          |
|-------------------------|----------------------------------------|
| `_stmtRecord`           | INSERT a new override row              |
| `_stmtGet`              | SELECT by `decision_id`                |
| `_stmtGetByContentHash` | SELECT by `content_hash` (LIMIT 1)     |
| `_stmtList`             | SELECT newest N overrides (ORDER DESC) |

SQLite's `better-sqlite3` amortizes query parsing after the first `.prepare()` call. Caching at class level eliminates the per-call parse overhead (~10–50 µs/call depending on query complexity and schema size). There is no API change — all existing callers of `recordOverride`, `getOverride`, and `listOverrides` are unaffected.

---

## 3. Primitive C — GET /v1/admin/alignment

### Route contract

| Method | Path                    | Description                              |
|--------|-------------------------|------------------------------------------|
| GET    | `/v1/admin/alignment`   | Return the last evaluated alignment report |

Authentication: `Authorization: Bearer <GATEWAY_TOKEN>` required. Missing or invalid token → 401.

| Status | Condition                                                                        |
|--------|----------------------------------------------------------------------------------|
| 200    | Always — including fresh boot (data will be null) or when aggregator is absent   |
| 401    | Bad or missing bearer token                                                      |
| 500    | Internal error in the route handler                                              |

The route never returns 503 for missing or uncalled aggregator state. A null `data` field is the documented representation of "no evaluation has occurred yet."

### Response shape

On fresh boot or when no `evaluate()` call has been made:

```json
{ "ok": true, "data": null }
```

After at least one `evaluate()` call:

```json
{
  "ok": true,
  "data": {
    "level":              "GREEN",
    "score":              0.82,
    "contributingSignals": ["commitmentDrift", "discordanceScore"],
    "evaluatedAt":        "2026-04-13T14:00:00.000Z",
    "failedOpen":         false,
    "diagnosis":          ["cross-stream discordance elevated"]
  }
}
```

`data` fields:

| Field                | Type            | Description                                                     |
|----------------------|-----------------|-----------------------------------------------------------------|
| `level`              | string          | `GREEN`, `YELLOW`, or `RED`                                     |
| `score`              | number          | Composite alignment score [0, 1]                                |
| `contributingSignals`| string[]        | Signal keys that crossed their threshold in the last evaluation |
| `evaluatedAt`        | string (ISO-8601)| Timestamp of the last `evaluate()` call                        |
| `failedOpen`         | boolean         | True when the aggregator caught an internal error and defaulted |
| `diagnosis`          | string[]        | Human-readable notes from `_buildDiagnosis()`                  |

`getLastReport()` is in-memory only. State does not survive process restarts. A fresh boot always returns `null`, which is normal operator-visible behavior.

### Curl example

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://127.0.0.1:18900/v1/admin/alignment
```

### Interpretation guide

| Level  | Dominant signal action                                                                              |
|--------|------------------------------------------------------------------------------------------------------|
| GREEN  | Score within healthy range; no signal crossed its threshold; no operator action required             |
| YELLOW | Composite is marginal; inspect `contributingSignals` and `diagnosis` to identify the leading driver  |
| RED    | Score below blocking threshold; aggregator is pulling the alignment composite down; investigate the signals listed in `contributingSignals` and cross-reference pm2 logs for the session in `evaluatedAt` |

When `contributingSignals` contains `discordanceScore`, review cadence anomalies and tool-graph drift. When it contains `commitmentDrift` or `injectionRate`, check audit triples for sessions in the relevant window. When `failedOpen` is true, the score may not reflect actual state — the aggregator encountered an internal error and defaulted to GREEN; treat the result with lower confidence.

---

## 4. Primitive D — Epistemic Honesty Gate

### Purpose

The Epistemic Honesty Gate classifies the confidence level of the loop's own rationale text before allowing tool calls to proceed. It prevents the system from executing tool calls when its internal reasoning is low-confidence or explicitly uncertain — a class of failure exemplified by Session-21, where the system executed consequential actions based on rationale it would itself characterize as guesswork. The gate runs as a pre-dispatch check: if the rationale is below threshold for the tool's impact level, the tool call is either replanned or annotated before reaching the veto gate.

### Tag taxonomy

| Tag         | Trigger pattern (first match wins, checked in order)                                                           |
|-------------|----------------------------------------------------------------------------------------------------------------|
| `UNKNOWN`   | Empty rationale, or contains: `i don't know`, `i do not know`, `no information`, `cannot determine`, `i have no` |
| `CONJECTURE`| Contains: `i think`, `i believe`, `probably`, `likely`, `perhaps`, `maybe`, `might`, `could be`, `i guess`, `i assume`, `i suspect` |
| `PROBABLE`  | Contains: `it appears`, `it seems`, `evidence suggests`, `based on`, `typically`, `usually`, `generally`       |
| `CERTAIN`   | Default — no matching hedge pattern                                                                            |

Pattern matching is case-insensitive and word-boundary anchored.

### Impact taxonomy

Impact is derived from the tool name using pattern matching:

| Level      | Tool name pattern                                            |
|------------|--------------------------------------------------------------|
| `CRITICAL` | `delete`, `drop`, `rm`, `wipe`, `format`, `shutdown`, `exec`, `eval`, `shell` |
| `HIGH`     | `write`, `create`, `update`, `insert`, `post`, `put`, `patch` |
| `MEDIUM`   | `send`, `email`, `message`, `notify`, `alert`, `read`, `fetch`, `query` |
| `LOW`      | Everything else                                              |

### Block rule matrix

| Tag         | Impact level      | Gate decision           |
|-------------|-------------------|-------------------------|
| CONJECTURE  | MEDIUM, HIGH, CRITICAL | REPLAN               |
| CONJECTURE  | LOW               | PROCEED                 |
| UNKNOWN     | HIGH, CRITICAL    | REPLAN                  |
| UNKNOWN     | LOW, MEDIUM       | UNCERTAIN_RESPONSE      |
| PROBABLE    | any               | PROCEED                 |
| CERTAIN     | any               | PROCEED                 |

`REPLAN` injects a system message and clears the pending tool calls for the current iteration, causing the loop to re-enter the LLM call phase with updated context. `UNCERTAIN_RESPONSE` injects a system message non-blockingly and allows the tool call to continue to the loop guard and veto gate. `PROCEED` passes through without injection.

### Ordering: epistemic gate fires before veto gate and loop guard

The epistemic gate is inserted between the LLM response emission point and the loop guard's repetition tracker. A `REPLAN` decision clears `validToolCalls` before the loop guard's `recordCall` is reached. This means a replanned call does not count toward the repetition budget — the replan injects a system message and iterates, which the loop guard will see as new state on the next pass. The ordering ensures that a low-confidence rationale that would otherwise trigger repetition tracking instead gets a clean replan opportunity.

### Operator visibility

Epistemic gate events appear in pm2 structured logs:

| Event                    | Level | Key fields                               |
|--------------------------|-------|-------------------------------------------|
| Gate decision is REPLAN  | WARN  | `tool`, `tag`, `sessionId`               |
| Gate decision is UNCERTAIN_RESPONSE | INFO | `tool`, `tag`, `sessionId`    |
| Gate threw internally (fail-open) | WARN | `err`                           |

Filter pm2 logs for `EpistemicGate` in the message or log context to audit gate activity:

```bash
pm2 logs sudo-ai-v5 --raw | grep EpistemicGate
```

There is no REST endpoint for epistemic log queries in Wave 6F. A future wave may expose `/v1/admin/epistemic/log` for structured querying of the optional SQLite `epistemic_log` table.

The gate is optional: `this.epistemicGate` is an optional field on `AgentLoop`. If not provided, the entire gate block is skipped with zero behavioral change.

---

## 5. Operator Runbook Updates

These extend the Wave 6E runbook. All Wave 6E procedures remain valid.

### Pre-approve a tool call by content hash

1. Compute the 32-character hex hash offline:
   - Tool name: exact registered tool name the loop will use
   - Args: the argument object the loop will receive, before sanitization
   - Apply recipe: `sha256(toolName + ':' + JSON.stringify(sanitize(args), null, 2)).slice(0, 32)`
2. POST the pre-approval before the loop iteration that will use it:

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contentHash":"<32-hex>","action":"allow","reason":"Pre-approved deploy script"}' \
  http://127.0.0.1:18900/v1/admin/veto/override
```

3. Verify the override was recorded:

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "http://127.0.0.1:18900/v1/admin/veto/overrides?limit=5"
```

4. When the loop encounters the matching tool+args combination, `getOverrideByContentHash` returns the registered record and the veto gate is bypassed. Both the hash and the decisionId are logged in the audit triple for that tool call.

Note: `decisionId`-based overrides from Wave 6E continue to work unchanged as the fallback lookup path.

### Inspect alignment state via REST

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://127.0.0.1:18900/v1/admin/alignment
```

On fresh boot or before the first loop evaluation, `data` will be null — this is normal. After the loop has processed at least one session, the response contains `level`, `score`, `contributingSignals`, `evaluatedAt`, `failedOpen`, and `diagnosis`. Use `contributingSignals` to identify which scoring dimensions pulled the composite below GREEN. Cross-reference `evaluatedAt` with pm2 logs to locate the relevant session.

Alignment state is in-memory only and does not survive a process restart. After a `pm2 restart sudo-ai-v5`, the first GET will return `{ok:true, data:null}` until the loop completes a new evaluation.

### Audit epistemic-blocked events in pm2 logs

```bash
# Show all REPLAN events from the epistemic gate
pm2 logs sudo-ai-v5 --raw | grep -E '"msg":"EpistemicGate REPLAN"'

# Show all UNCERTAIN_RESPONSE injections
pm2 logs sudo-ai-v5 --raw | grep -E '"msg":"EpistemicGate UNCERTAIN_RESPONSE injected"'

# Show all epistemic gate fail-open events (gate threw internally)
pm2 logs sudo-ai-v5 --raw | grep -E 'epistemic gate threw'
```

Each REPLAN log entry includes `tool` (the tool name that was blocked), `tag` (the epistemic classification), and `sessionId`. Use these fields to correlate with the session transcript and review the rationale text that triggered the block.

---

## 6. Configuration

No new environment variables are introduced in Wave 6F. The existing `GATEWAY_TOKEN` covers all new and existing endpoints.

---

## 7. Rollback Reference

Wave 6F baseline (pre-deploy): 1629/1629 tests, tsc clean, pm2 sudo-ai-v5 online, gateway :18900.

If rollback is required, restore to the Wave 6E backup using the backup created by Rollback Guardian before Wave 6F deployment. The restore script path follows the pattern established in prior waves:

```
/tmp/sudo-ai-backups/sudo-ai-v4/<timestamp>-pre-wave6f-deploy/restore.sh
```

This returns the system to Wave 6E state: 1629/1629 tests, discordance signal wired into aggregator, veto override REST endpoints present but without content-hash support, no alignment GET endpoint, no epistemic gate.
