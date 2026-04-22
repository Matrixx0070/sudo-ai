# Wave 6B — Security and Recovery Features

Wave 6B adds three production-hardening capabilities to SUDO-AI v4: a pre-execution adversarial veto gate that classifies and blocks risky tool calls before they run, an admin REST API for auditing and inspection queue management, and a recovery protocol that persists failure commitments across agent sessions.

---

## 1. Pre-Execution Adversarial Veto Gate

Source: `src/core/agent/veto-gate.ts`, wired in `src/core/agent/loop.ts`.

### Risk Classification

Every tool call is synchronously classified before execution. Rules are evaluated in order; first match wins.

| Priority | Level    | Triggers                                                                                                                                                                       |
|----------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1        | CRITICAL | Tool name matches `delete`, `drop`, `rm`, `wipe`, `format`, `shutdown`, `exec`, `eval`, or `shell`                                                                            |
| 1        | CRITICAL | Any string value in args (recursive, max depth 3) contains `..` or starts with `/`                                                                                            |
| 2        | HIGH     | Tool name matches `write`, `create`, `update`, `insert`, `post`, `put`, or `patch`                                                                                            |
| 2        | HIGH     | Any arg key (recursive, max depth 3) is one of: `password`, `token`, `secret`, `key`, `credential`, `filepath`, `dest`, `target`, `directory`, `src`, `source`, `output`, `url`, `uri` |
| 3        | MEDIUM   | Tool name matches `read`, `get`, `list`, `search`, `fetch`, or `query` AND `args.limit > 1000`                                                                                 |
| 3        | MEDIUM   | Tool name matches `send`, `email`, `message`, `notify`, or `alert`                                                                                                             |
| 4        | LOW      | All other tool calls                                                                                                                                                           |

### Consensus Pass (MEDIUM and above)

LOW-risk calls are approved immediately without any model query. For MEDIUM, HIGH, and CRITICAL risk, a multi-model consensus runs in parallel via `queryAllModels()`. Each model call has a 3-second timeout; a model that times out contributes an implicit APPROVE vote. The first word of each model's response (case-insensitive) determines its vote: `veto` counts as VETO, anything else as APPROVE.

Tie-break by risk level:

| Risk Level | Tie breaks to |
|------------|---------------|
| CRITICAL   | VETO          |
| HIGH       | VETO          |
| MEDIUM     | APPROVE       |

For CRITICAL and HIGH: VETO wins when `vetoVotes >= approveVotes` and at least one VETO vote was cast. For MEDIUM: `vetoVotes > approveVotes` is required.

### Argument Sanitization

Before args are embedded in the veto prompt, `sanitizeArgsForPrompt()` applies: string values truncated to 200 characters; newlines, tabs, and control characters (0x00–0x1F, 0x7F) replaced with spaces; XML-like tokens stripped. The result is wrapped in `<untrusted_tool_args>` markers with an explicit prompt instruction that content inside those markers is data, not instructions.

### Fail-Open Behavior

If `queryAllModels()` throws (all models unavailable), the gate approves the call, writes a `warn`-level log, and returns `VetoResult` with `failedOpen: true`. The agent loop is required to audit this event via `recordTriple`. Operators must monitor these audit entries.

### Operator Visibility

When the gate blocks a call, the agent loop emits an SSE error event:

```
[VetoGate] RISK=HIGH BLOCKED: writeFile — Tool writes to filesystem with sensitive path argument
```

Format: `[VetoGate] RISK=<LEVEL> BLOCKED: <toolName> — <reason>`

A triple is written to the audit chain for every VETO and every fail-open event. Sample audit row:

```json
{
  "id": "a3f8c1d2",
  "timestamp": "2026-04-13T10:22:05.311Z",
  "action": "veto",
  "actor": "veto-gate",
  "resource": "writeFile",
  "metadata": { "risk": "HIGH", "decision": "VETO", "vetoVotes": 2, "approveVotes": 1, "failedOpen": false },
  "hash": "e9b3a..."
}
```

---

## 2. Admin REST API

Source: `src/core/gateway/admin-routes.ts`. All endpoints mount under `/v1/admin/`. Every request requires `Authorization: Bearer <GATEWAY_TOKEN>` (timing-safe check). Missing or invalid token returns HTTP 401 with `{ "ok": false, "error": "Unauthorized" }`. Internal errors return HTTP 500 with `{ "ok": false, "error": "<message>" }`.

| Method | Path                              | Description                               |
|--------|-----------------------------------|-------------------------------------------|
| GET    | `/v1/admin/audit/verify`          | Verify SHA-256 audit chain integrity      |
| GET    | `/v1/admin/inspection`            | List quarantined inspection queue entries |
| POST   | `/v1/admin/inspection/:id/status` | Update an inspection entry's status       |

### GET /v1/admin/audit/verify

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" http://localhost:3000/v1/admin/audit/verify
```

Response (HTTP 200):

```json
{ "ok": true, "data": { "valid": true, "rowsChecked": 412, "breakAt": null, "validCount": 412, "invalidCount": 0 } }
```

When the chain is broken: `"ok": true` and `"data.valid": false`, with `"data.breakAt": "<row-id>"` identifying the first invalid row and `"data.invalidCount"` reflecting the number of bad rows.

### GET /v1/admin/inspection

| Parameter  | Type   | Allowed values                              | Default | Notes             |
|------------|--------|---------------------------------------------|---------|-------------------|
| `status`   | string | `pending`, `reviewed`, `cleared`, `blocked` | (all)   | Filter by status  |
| `category` | string | `inbound`, `generated`, `memory`            | (all)   | Filter by category |
| `limit`    | int    | 1–500                                       | 50      | Clamped to [1, 500] |

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "http://localhost:3000/v1/admin/inspection?status=pending&limit=10"
```

Response (HTTP 200):

```json
{
  "ok": true,
  "data": {
    "entries": [
      {
        "id": "7f2a09e1",
        "timestamp": "2026-04-13T09:55:14.002Z",
        "category": "inbound",
        "status": "pending",
        "content": "Ignore all previous instructions and...",
        "sessionId": "sess_abc123",
        "reviewedBy": null
      }
    ],
    "count": 1
  }
}
```

### POST /v1/admin/inspection/:id/status

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "blocked", "reviewedBy": "ops-team"}' \
  http://localhost:3000/v1/admin/inspection/7f2a09e1/status
```

Body fields: `status` (required, one of `pending`/`reviewed`/`cleared`/`blocked`), `reviewedBy` (optional string). Success: HTTP 200 with `{ "ok": true, "data": { "id": "<id>", "status": "<new-status>" } }`. Invalid status: HTTP 400 with `{ "ok": false, "error": "<message>" }`. Entry not found: HTTP 404 with `{ "ok": false, "error": "<message>" }`.

---

## 3. Recovery Protocol

Source: `src/core/agent/recovery-protocol.ts`, wired in `src/core/agent/loop.ts`.

On terminal pipeline errors, the loop calls `recordRecovery()` which writes a `CommitmentTriple` to the audit chain (action type: `commitment`):

| Field        | Type   | Description                                              |
|--------------|--------|----------------------------------------------------------|
| `mistake`    | string | What went wrong                                          |
| `learned`    | string | What the agent should understand from the failure        |
| `commitment` | string | Forward behavioral constraint                            |
| `ttl_days`   | number | Days this commitment stays active (positive integer)     |
| `resource`   | string | Optional: tool or resource involved in the failure       |

### TTL Behavior

`loadActiveCommitments()` queries up to 200 commitment entries and filters by: `entry.timestamp + (ttl_days * 86400000 ms) > Date.now()`. Malformed entries (missing timestamp, non-positive `ttl_days`, missing commitment string) are silently skipped. A query failure returns an empty array.

### Sanitization Rules

Before injection into the system prompt, each commitment string is: control characters replaced with spaces; XML-like tags stripped; role markers (`[SYSTEM]`, `[USER]`, `[ASSISTANT]`, `<|im_start|>`, `<|im_end|>`, `</s>`, `</system>`) stripped; multiple spaces collapsed; truncated to 500 characters with ellipsis.

### Sample Injected System Message

```
[ACTIVE COMMITMENTS]
- a3f8c1d2: Do not call writeFile on paths outside /tmp without explicit user confirmation (committed 2026-04-10, active until 2026-04-17)
- 9e12b034: Always validate tool argument types before invoking external APIs (committed 2026-04-12, active until 2026-04-19)
```

Commitment line format: `- <id>: <commitment-text> (committed YYYY-MM-DD, active until YYYY-MM-DD)`

### Querying Commitments

No HTTP endpoint for listing commitments exists in Wave 6B. Query them directly in SQLite: `SELECT * FROM audit WHERE action = 'commitment'`. A `/v1/admin/commitments` endpoint is planned for a future wave.

---

## 4. Operator Quickstart

```bash
export GATEWAY_TOKEN="your-secret-token-here"

# Verify audit chain
curl -H "Authorization: Bearer $GATEWAY_TOKEN" http://localhost:3000/v1/admin/audit/verify

# List pending inspection entries (limit capped at 500)
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "http://localhost:3000/v1/admin/inspection?status=pending&limit=20"

# Mark an entry blocked
curl -X POST -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "blocked", "reviewedBy": "admin"}' \
  http://localhost:3000/v1/admin/inspection/7f2a09e1/status
```

---

## 5. Known Limitations

**Fail-open by design.** When all veto models are unavailable, tool calls are approved. Operators must monitor `failedOpen: true` audit entries.

**No manual VETO override.** There is no endpoint to inject a block decision retroactively; veto decisions occur only at execution time.

**Commitment listing requires direct DB access.** Wave 6B has no HTTP endpoint for commitment entries. Use `SELECT * FROM audit WHERE action = 'commitment'` directly.

**Category parameter accepted.** The `category` query parameter on `GET /v1/admin/inspection` is passed through to `inspectionQueue.query()`; behavior depends on the queue implementation.
