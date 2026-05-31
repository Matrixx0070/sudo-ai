# SUDO-AI v5 Wave 6A

## 1. Overview

Wave 6A adds three modules:

**Identity Loader** (`src/core/identity/`) — reads operator-authored config files at startup
and exposes a pre-tool advisory hook. Never enforces content. Always returns `ok: true`.

**Crypto Audit Chain** (`src/core/security/audit-chain.ts` + upgraded `audit-trail.ts`) —
upgrades the audit log to a SHA-256 hash chain. Each row covers the previous row's hash,
making tampering detectable. Adds `verifyChain()` and `recordTriple()` to `AuditTrail`.

**Inspection Queue + Self-Whisper Monitor** (`src/core/security/inspection-queue.ts`, wired
into `injection-detector.ts` and `rationalization-guard.ts`) — flagged inbound and generated
content is routed to a review queue in `mind.db`. Status flows `pending → reviewed →
cleared | blocked`.

---

## 2. Operator Config Files

The operator authors all three files. The loader validates structure only and never reads
content semantically. Files live in `config/` relative to the process working directory.

### core-identity.md

Plain text. Loaded as a single string. Valid when non-empty after trim and free of NUL bytes
(`\x00`). Content is the operator's domain.

```
# [Operator-defined header]
[Free text. Stored verbatim; never interpreted by the loader.]
```

Example file: `config/core-identity.md.example` — comment-only header, no policy declarations.

### values.json

JSON object. Valid when `JSON.parse` succeeds and the root is a non-null, non-array object.
Array and primitive roots are rejected silently (field becomes `null`; warning logged).

```json
{
  "_comment": "Operator-defined key/value pairs. Loader only checks structural validity."
}
```

Example file: `config/values.json.example` — JSON object with `_comment` keys only.

### hard-prohibitions.yaml

YAML list. Valid when root is an array where every element is a string. Malformed YAML,
non-array roots, and non-string elements produce `null` (warning logged; no throw).

```yaml
# Exact tool names that trigger an advisory log entry.
# Blocking is the operator's responsibility, not the loader's.
- placeholder-tool-name
```

Example file: `config/hard-prohibitions.yaml.example` — one placeholder string entry.

**Log output (metadata only — file contents are never logged):**

| Event | Level | Message |
|---|---|---|
| Successful load | info | `Loaded core-identity.md (N bytes)` / `Loaded values.json successfully` / `hard-prohibitions.yaml (N entries)` |
| Validation failure | warn | reason string, no content |

**Production visibility:** Prohibition advisory log entries are emitted at `debug` level. To see them in production, set `LOG_LEVEL=debug` in `.env`. Otherwise they appear only in `data/logs/sudo-ai-v5-out.log`.

There is no file-size limit; very large `core-identity.md` files load verbatim into memory.

---

## 3. Audit Chain

### Hash scheme

Each `audit_log` row adds:

| Column | Content |
|---|---|
| `prev_hash` | SHA-256 hex of the previous row (`''` for genesis) |
| `hash` | SHA-256 hex of `prev_hash + timestamp + payload` |

`payload` is `JSON.stringify({ actor, action, resource, outcome, metadata_json })`.

### Verifying the chain

```typescript
const trail = new AuditTrail(db);
const result = trail.verifyChain();
// { ok: boolean; breakAt?: string; rowsChecked: number }
```

`ok` is `true` only when every row's stored hash matches recomputation. `breakAt` is the `id`
of the first invalid row. Empty log returns `{ ok: true, rowsChecked: 0 }`.

### What to do if verifyChain() returns ok:false

`breakAt` in the result is the `id` of the first row whose stored hash does not match recomputation. To investigate:

1. Open the audit database:
   ```bash
   sqlite3 data/audit.db
   ```

2. Inspect the suspect row:
   ```sql
   SELECT * FROM audit_log WHERE id = '<breakAt>';
   ```

3. Recompute the expected hash manually: SHA-256 of the concatenation `prev_hash + timestamp + JSON.stringify({actor, action, resource, outcome, metadata_json})`. Compare against the stored `hash` column.

4. If only the hash value mismatches with an otherwise intact row, the cause is either tampering or accidental database modification (e.g. direct SQL update, filesystem-level corruption).

5. If compromise is suspected, restore `data/audit.db` from a known-good backup before continuing operation.

### Recording a commitment triple

```typescript
const id = trail.recordTriple({
  mistake: 'description',
  learned: 'what was learned',
  commitment: 'what changes',
  ttl_days: 30,
  resource: 'optional'  // defaults to 'system'
});
// returns: string (UUID of inserted row)
```

Stored as `actor='system'`, `action='commitment'`, `outcome='success'` with all four fields
in `metadata_json`.

---

## 4. Inspection Queue

### Status flow

`pending` → `reviewed` → `cleared` or `blocked`

Rows enter as `pending`. `updateStatus()` advances status and sets `reviewed_by` /
`reviewed_at`.

### Querying and updating

```typescript
const queue = createInspectionQueue(db);

const entries = queue.query({ status: 'pending', limit: 50 });
queue.updateStatus(id, 'cleared', 'operator-id');
```

`query()` with no filter returns all rows.

### Wiring to detectors

Call once at startup after `initializeSchema`:

```typescript
setInspectionQueue(queue);       // injection-detector.ts — inbound content
setRationalizationQueue(queue);  // rationalization-guard.ts — generated content
```

If a setter is never called, detectors remain functional and simply do not enqueue. Enqueue
failures are caught internally and do not propagate.

### Self-whisper monitor

```typescript
const result = monitorGeneratedContent(text, {
  sessionId: 'abc',
  operationName: 'tool-response-check'
});
// { flagged: boolean; queueId?: string }
```

`queueId` is present only when flagged and successfully enqueued.

---

## 5. API Reference

### Identity Loader — `src/core/identity/loader.ts`

| Export / Method | Signature | Description |
|---|---|---|
| `createIdentityLoader` | `(configDir: string, auditTrail?: AuditTrail) => IdentityLoaderInstance` | Reads config files; returns loader instance |
| `getAnchor` | `() => IdentityAnchor` | Instance method; returns loaded anchor; null fields = absent or invalid file |
| `verify` | `(call: ToolCallDescriptor, ctx: HookContext) => Promise<HookResult>` | Instance method; advisory check; always `ok: true` |

### Audit Chain — `src/core/security/audit-chain.ts`

| Export | Signature | Description |
|---|---|---|
| `computeHash` | `(prevHash: string, timestamp: string, payload: string) => string` | SHA-256 hex of concatenated inputs |
| `verifyChainRows` | `(rows: ChainEntry[]) => ChainVerifyResult` | Verifies a pre-loaded row set; no DB access |

### AuditTrail additions — `src/core/security/audit-trail.ts`

| Method | Signature | Description |
|---|---|---|
| `verifyChain` | `() => ChainVerifyResult` | Reads all rows from DB and verifies full chain |
| `recordTriple` | `(triple: CommitmentTriple) => string` | Inserts a commitment record; returns new row `id` |

### Inspection Queue — `src/core/security/inspection-queue.ts`

| Export | Signature | Description |
|---|---|---|
| `createInspectionQueue` | `(db: Database.Database) => InspectionQueueInstance` | Creates queue backed by `mind.db` connection |
| `enqueue` | `(opts: EnqueueOptions) => string` | Inserts flagged entry (excerpt + hash, not raw payload); returns `id` |
| `query` | `(filter?: { status?: string; limit?: number }) => InspectionQueueEntry[]` | Returns matching rows with `pattern_matches` parsed from JSON |
| `updateStatus` | `(id: string, status: InspectionQueueEntry['status'], reviewedBy?: string) => void` | Advances status; sets `reviewed_by` / `reviewed_at` |

### Injection Detector addition — `src/core/security/injection-detector.ts`

| Export | Signature | Description |
|---|---|---|
| `setInspectionQueue` | `(queue: InspectionQueueInstance) => void` | Attaches queue; subsequent detections are enqueued |

### Rationalization Guard additions — `src/core/agent/rationalization-guard.ts`

| Export | Signature | Description |
|---|---|---|
| `setRationalizationQueue` | `(queue: InspectionQueueInstance) => void` | Attaches queue for generated-content flags |
| `monitorGeneratedContent` | `(text: string, context: { sessionId: string; operationName?: string }) => { flagged: boolean; queueId?: string }` | Scans generated text; enqueues if flagged and queue is set |

---

## 6. Migration Notes

### audit_log backfill

Wave 6A adds two columns via idempotent `ALTER TABLE` in the `AuditTrail` constructor:

```sql
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''
ALTER TABLE audit_log ADD COLUMN hash      TEXT NOT NULL DEFAULT ''
```

On first construction, rows where `hash = ''` are backfilled in a single `db.transaction`
(ordered by `rowid ASC`). The guard `WHERE hash = ''` makes backfill idempotent.
A log line at `info` level reports the row count. For large logs this adds startup latency;
acceptable for v6A.

On first boot with an existing audit log, expect a log line `backfillHashes: starting back-fill { rowCount: N }` followed by a single `back-fill complete` line. There is no progress indicator during the operation. For N > 10,000 rows, expect up to 30 seconds of startup delay; the system is not hung.

### inspection_queue placement

`inspection_queue` is created in `mind.db` (via `TABLE_STATEMENTS` in `schema.ts`), not in
`audit.db`. The audit hash chain remains isolated as the tamper-evident record; the inspection
queue is operational review data. No manual migration steps are required — both changes apply
automatically on first boot.
