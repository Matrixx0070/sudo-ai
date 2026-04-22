# SUDO-AI v5 Wave 6A — Architect Specification
# Produced: 2026-04-13
# Author: Architect (Sonnet 4.6)

---

## 1. Executive Summary

Wave 6A delivers three parallel builder slices against the top-priority gap items from the Scout briefing.
Builder A installs an Identity Loader that reads Frank's owner-config files (core-identity.md, values.json, hard-prohibitions.yaml) when present, validates structure only (never semantics), and wires a non-blocking advisory hook into loop.ts before tool dispatch.
Builder B upgrades AuditTrail to a SHA-256 hash chain, adds concurrency-safe record() via db.transaction, backfills existing rows, adds verifyChain() and recordTriple() methods, and ships a dedicated audit-chain helper module with tests.
Builder C adds an inspection_queue table to mind.db, refactors injection-detector.ts to route flagged content into that queue via a module-level setter pattern (identical to setHookManager precedent in injection-scanner.ts), and adds monitorGeneratedContent() to rationalization-guard.ts for self-whisper detection.
All three builders produce no new tsc errors, maintain the 1353-test baseline, and gate on existing vitest coverage thresholds (60% line / 50% branch).

---

## 2. File Ownership Matrix

| Builder | File | Status |
|---------|------|--------|
| A | /root/sudo-ai-v4/src/core/identity/types.ts | NEW |
| A | /root/sudo-ai-v4/src/core/identity/loader.ts | NEW |
| A | /root/sudo-ai-v4/config/core-identity.md.example | NEW |
| A | /root/sudo-ai-v4/config/values.json.example | NEW |
| A | /root/sudo-ai-v4/config/hard-prohibitions.yaml.example | NEW |
| A | /root/sudo-ai-v4/tests/identity/identity-loader.test.ts | NEW |
| A | /root/sudo-ai-v4/src/core/agent/loop.ts | MODIFY (4 touch points only) |
| B | /root/sudo-ai-v4/src/core/security/audit-chain.ts | NEW |
| B | /root/sudo-ai-v4/tests/security/audit-chain.test.ts | NEW |
| B | /root/sudo-ai-v4/src/core/security/audit-trail.ts | UPGRADE in place |
| C | /root/sudo-ai-v4/src/core/security/inspection-queue.ts | NEW |
| C | /root/sudo-ai-v4/tests/security/inspection-queue.test.ts | NEW |
| C | /root/sudo-ai-v4/tests/security/rationalization-monitor.test.ts | NEW |
| C | /root/sudo-ai-v4/src/core/memory/schema.ts | MODIFY (add DDL + indexes) |
| C | /root/sudo-ai-v4/src/core/security/injection-detector.ts | MODIFY (setter + enqueue) |
| C | /root/sudo-ai-v4/src/core/agent/rationalization-guard.ts | MODIFY (monitorGeneratedContent) |

OVERLAP GUARD: Builder A owns loop.ts. Builder C owns rationalization-guard.ts. Both files are in
src/core/agent/ but they are DIFFERENT files — no conflict. Integrator must verify this during Step 4.

---

## 3. Data Models

### 3A — New TypeScript Interfaces (Builder A)

File: /root/sudo-ai-v4/src/core/identity/types.ts

```typescript
// Structural shape of values.json.
// Builder A validates: is this valid JSON AND a non-null, non-array object?
// Content of keys is Frank's domain — never read semantically.
export interface ValuesShape {
  [key: string]: unknown;
}

// Structural shape of hard-prohibitions.yaml.
// Builder A validates: is this a YAML list where every element is typeof string?
// Content of each string is Frank's domain — never read semantically.
export type ProhibitionsShape = string[];

// Runtime identity anchor — loaded once at startup.
// All fields nullable: missing/empty config files produce null (graceful no-op).
export interface IdentityAnchor {
  identity: string | null;
  values: ValuesShape | null;
  prohibitions: ProhibitionsShape | null;
}

// Result of the pre-tool advisory hook.
// ok is ALWAYS true (advisory-only, never blocks).
// advisory is informational — logged to debug, never enforced.
export interface HookResult {
  ok: boolean;
  advisory?: string;
}

// Minimal tool call descriptor passed to verify().
export interface ToolCallDescriptor {
  name: string;
  arguments?: Record<string, unknown>;
}

// Context passed to verify() for audit attribution.
export interface HookContext {
  sessionId: string;
  actor?: string;
}
```

### 3B — New TypeScript Interfaces (Builder B)

File: /root/sudo-ai-v4/src/core/security/audit-chain.ts

```typescript
export interface ChainEntry {
  id: string;
  timestamp: string;
  payload: string;   // JSON.stringify of { actor, action, resource, outcome, metadata_json }
  prev_hash: string; // SHA-256 of previous row, or '' for genesis row
  hash: string;      // SHA-256(prev_hash + timestamp + payload)
}

export interface ChainVerifyResult {
  ok: boolean;
  breakAt?: string;   // id of first row with invalid hash (absent when ok=true)
  rowsChecked: number;
}

export interface CommitmentTriple {
  mistake: string;
  learned: string;
  commitment: string;
  ttl_days: number;
  resource?: string; // defaults to 'system'
}
```

### 3C — New SQL Table (Builder C)

Added to TABLE_STATEMENTS in /root/sudo-ai-v4/src/core/memory/schema.ts:

```sql
CREATE TABLE IF NOT EXISTS inspection_queue (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source           TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('inbound','generated','memory')),
  severity         TEXT NOT NULL,
  payload_excerpt  TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  pattern_matches  TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','reviewed','cleared','blocked')),
  reviewed_by      TEXT,
  reviewed_at      TEXT
)
```

Added to INDEX_STATEMENTS:
```sql
CREATE INDEX IF NOT EXISTS idx_inspection_queue_status_created ON inspection_queue(status, created_at)
CREATE INDEX IF NOT EXISTS idx_inspection_queue_severity       ON inspection_queue(severity)
```

Database placement: mind.db (via initializeSchema). NOT audit.db.
Rationale: inspection_queue is operational data; audit.db is the tamper-evident chain (separate concern).

### 3D — Upgraded audit_log Columns (Builder B)

Added via idempotent ALTER TABLE in AuditTrail constructor:
```sql
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''
ALTER TABLE audit_log ADD COLUMN hash TEXT NOT NULL DEFAULT ''
```
DEFAULT '' required for ALTER TABLE to succeed on existing populated tables.
Backfill computes correct hashes for all rows with hash = '' on first constructor run.

---

## 4. API Contracts — Exact Function Signatures

### Builder A

**src/core/identity/types.ts** — interface definitions (section 3A above).

**src/core/identity/loader.ts:**
```typescript
import type { IdentityAnchor, HookResult, ToolCallDescriptor, HookContext } from './types.js';
import type { AuditTrail } from '../security/audit-trail.js';

export interface IdentityLoaderInstance {
  getAnchor(): IdentityAnchor;
  verify(call: ToolCallDescriptor, ctx: HookContext): Promise<HookResult>;
}

export function createIdentityLoader(
  configDir: string,
  auditTrail?: AuditTrail
): IdentityLoaderInstance;
```

**YAML dependency (confirm absent — install first):**
```
pnpm add js-yaml
pnpm add -D @types/js-yaml
```
Import: `import yaml from 'js-yaml'`, use `yaml.load(text)`.

**Config file resolution:**
- identity: `path.resolve(configDir, 'core-identity.md')`
- values: `path.resolve(configDir, 'values.json')`
- prohibitions: `path.resolve(configDir, 'hard-prohibitions.yaml')`

**Validation rules (structural, never semantic):**
- identity: existsSync + readFileSync + trim + non-empty + no NUL bytes → store as string. Else null.
- values: JSON.parse succeeds + typeof result === 'object' + result \!== null + \!Array.isArray → store. Else null + log.warn.
- prohibitions: yaml.load() + Array.isArray + every element typeof string → store. Else null + log.warn.

**What to log (NEVER log file contents, only metadata):**
- "Loaded core-identity.md (N bytes)" — log.info
- "Loaded values.json (N keys)" — log.info
- "Loaded hard-prohibitions.yaml (N entries)" — log.info
- Validation failure: log.warn with reason string, no content

**verify() behavior:**
- When anchor is all-null: return { ok: true } immediately.
- When prohibitions is loaded: check if call.name appears in prohibitions list (exact string match). If yes: return { ok: true, advisory: `Tool '${call.name}' appears in owner prohibitions list` }.
- NEVER return { ok: false }. Blocking is Frank's choice.

### Builder B

**src/core/security/audit-chain.ts:**
```typescript
import { createHash } from 'node:crypto';

export function computeHash(prevHash: string, timestamp: string, payload: string): string;
// Returns SHA-256 hex of (prevHash + timestamp + payload)

export function verifyChainRows(rows: ChainEntry[]): ChainVerifyResult;
// Verifies full chain. Returns ok=true only when every row's hash matches recomputation.
// Empty rows array → { ok: true, rowsChecked: 0 }
```

**src/core/security/audit-trail.ts — new public methods:**
```typescript
verifyChain(): ChainVerifyResult;
// Reads all rows ORDER BY rowid ASC, maps to ChainEntry, calls verifyChainRows.

recordTriple(triple: CommitmentTriple): string;
// Returns: id of inserted row (string)
// Calls this.record() with:
//   actor = 'system'
//   action = 'commitment'
//   resource = triple.resource ?? 'system'
//   outcome = 'success'
//   metadata = { mistake, learned, commitment, ttl_days }
```

**record() internal change (same signature externally):**
Wrapped in `db.transaction()`. Reads `SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1` for prevHash inside transaction. Computes hash. Inserts with prev_hash + hash columns.

**Private method signatures:**
```typescript
private addChainColumns(): void;
// Runs two ALTER TABLE ADD COLUMN statements in individual try/catch blocks.
// Pattern: silence 'already has a column named' | 'duplicate column name' | 'no such table'.
// Re-throw all other errors.

private backfillHashes(): void;
// Select all rows WHERE hash = '' OR hash IS NULL ORDER BY rowid ASC.
// Compute chain starting from prevHash=''.
// payload = JSON.stringify({ actor, action, resource, outcome, metadata_json })
// Run all UPDATEs in a single db.transaction.
// log.info before + after with rowCount.
// Guard: WHERE hash = '' OR hash IS NULL — idempotent.
```

### Builder C

**src/core/security/inspection-queue.ts:**
```typescript
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

export interface InspectionQueueEntry { ... }   // section 3C types
export interface EnqueueOptions {
  source: string;
  category: 'inbound' | 'generated' | 'memory';
  severity: string;
  fullPayload: string;     // hashed + excerpted; NEVER stored raw
  patternMatches: string[];
}
export interface InspectionQueueInstance {
  enqueue(opts: EnqueueOptions): string;
  query(filter?: { status?: string; limit?: number }): InspectionQueueEntry[];
  updateStatus(id: string, status: InspectionQueueEntry['status'], reviewedBy?: string): void;
}
export function createInspectionQueue(db: Database.Database): InspectionQueueInstance;
```

**enqueue() internals:**
- payload_excerpt = opts.fullPayload.slice(0, 500)
- payload_hash = createHash('sha256').update(opts.fullPayload).digest('hex')
- pattern_matches = JSON.stringify(opts.patternMatches)
- id = randomUUID()
- fullPayload NOT stored

**query() row mapper:** pattern_matches JSON.parse inside try/catch, fallback to [].

**src/core/security/injection-detector.ts — new exports:**
```typescript
import type { InspectionQueueInstance } from './inspection-queue.js';

let _inspectionQueue: InspectionQueueInstance | null = null;

export function setInspectionQueue(queue: InspectionQueueInstance): void;
```

**src/core/agent/rationalization-guard.ts — new exports:**
```typescript
import type { InspectionQueueInstance } from '../security/inspection-queue.js';

let _rationalizationQueue: InspectionQueueInstance | null = null;

export function setRationalizationQueue(queue: InspectionQueueInstance): void;

export function monitorGeneratedContent(
  text: string,
  context: { sessionId: string; operationName?: string }
): { flagged: boolean; queueId?: string };
```

---

## 5. Wiring Points — Exact File:Line for Every Modification

### Builder A — loop.ts (4 touch points)

**Touch point 1 — Imports** (add after last import, around line 40-41):
```typescript
import { createIdentityLoader } from '../identity/loader.js';
import type { IdentityLoaderInstance } from '../identity/loader.js';
```
VERIFY: `import path from 'node:path'` — check if already present before adding.

**Touch point 2 — Class field** (add after `private readonly sandboxManager?` line ~138):
```typescript
private readonly identityLoader?: IdentityLoaderInstance;
```

**Touch point 3 — Constructor** (add after sandboxManager validation block closes, around line 216-218):
```typescript
// Identity loader — optional, graceful no-op when config files absent.
const configDir = path.resolve(process.cwd(), 'config');
try {
  this.identityLoader = createIdentityLoader(configDir);
  log.info('AgentLoop: IdentityLoader attached');
} catch (err) {
  log.warn({ err: String(err) }, 'AgentLoop: IdentityLoader failed to initialize — proceeding without identity anchor');
}
```

**Touch point 4 — Blocking await** (insert BETWEEN line 654 and line 656):
Line 654: `if (guardAborted) break;`
Line 656: `// Hook: before:tool-call — one emission per validated tool call.`

Insert between them:
```typescript
// Identity anchor advisory check — always resolves, never blocks tool dispatch.
if (this.identityLoader && validToolCalls.length > 0) {
  for (const tc of validToolCalls) {
    const anchorResult = await this.identityLoader.verify(
      { name: tc.name, arguments: tc.arguments ?? {} },
      { sessionId: state.sessionId, actor: state.userId ?? 'agent' }
    );
    if (anchorResult.advisory) {
      log.debug({ toolName: tc.name, advisory: anchorResult.advisory }, 'Identity anchor advisory');
    }
  }
}
```

### Builder B — audit-trail.ts (all within the class)

- After `this.db.exec(CREATE TABLE...)` at line ~60: add `this.addChainColumns();`
- After that: add `this.backfillHashes();`
- Replace `record()` body (lines 81-95): wrap in db.transaction as specified in section 4.
- Append `verifyChain()` after `countSince()` (line ~140+).
- Append `recordTriple()` after `verifyChain()`.
- Append `private addChainColumns()` method.
- Append `private backfillHashes()` method.
- Add at top: `import { computeHash, verifyChainRows } from './audit-chain.js';`
- Add at top: `import type { ChainVerifyResult, CommitmentTriple } from './audit-chain.js';`

### Builder C — schema.ts

- TABLE_STATEMENTS array (before closing `]` at line ~368): append inspection_queue CREATE TABLE string.
- INDEX_STATEMENTS array (before closing `]` at line ~438): append two index strings.
- Table catalogue comment (lines ~22-40): add `inspection_queue – flagged content review queue`.

### Builder C — injection-detector.ts

- After existing imports (line ~9): add `import type { InspectionQueueInstance } from './inspection-queue.js';`
- After INJECTION_PATTERNS definition (line ~33): add module-level `let _inspectionQueue: InspectionQueueInstance | null = null;`
- After that: export `setInspectionQueue()` function.
- Inside `sanitizeToolResult()` → inside `if (check.detected)` → after `log.error(...)` call: add try/catch enqueue block.

### Builder C — rationalization-guard.ts

- After existing `import { createLogger }` (line 1): add `import type { InspectionQueueInstance } from '../security/inspection-queue.js';`
- After last export (`guardOperation` closes around line 184): add `let _rationalizationQueue: InspectionQueueInstance | null = null;`
- Append `setRationalizationQueue()` export.
- Append `monitorGeneratedContent()` export.

---

## 6. Test Acceptance Criteria

### Builder A — tests/identity/identity-loader.test.ts (minimum 10 cases)
1. All-null anchor when configDir is empty temp dir
2. verify() always returns { ok: true } — never { ok: false }
3. Valid core-identity.md → non-null identity string
4. Valid values.json → non-null ValuesShape object
5. Array root values.json → null (not thrown, not crash)
6. Valid hard-prohibitions.yaml → non-null ProhibitionsShape array
7. Non-array YAML root → null (not thrown)
8. Empty file → null (not crash)
9. Malformed YAML → null (not thrown)
10. NUL byte in identity file → null (not crash)

### Builder B — tests/security/audit-chain.test.ts (minimum 14 cases)
1. computeHash deterministic — same inputs → same output
2. computeHash different inputs → different outputs
3. verifyChainRows([]) → { ok: true, rowsChecked: 0 }
4. Single-entry chain verify passes
5. Three-entry chain verify passes
6. Tampered row → { ok: false, breakAt: tampered_id }
7. record() sets prev_hash and hash on inserted row
8. 10 concurrent record() calls via Promise.all → verifyChain() ok (transaction test)
9. verifyChain() on fresh empty db → ok
10. verifyChain() after multiple records → ok
11. recordTriple() returns non-empty string (id)
12. recordTriple() row has action='commitment', outcome='success', metadata contains all 4 keys
13. addChainColumns() idempotent — construct AuditTrail twice same db → no throw
14. Backfill: rows inserted directly without hash → construct AuditTrail → verifyChain passes

### Builder C — tests/security/inspection-queue.test.ts (minimum 12 cases)
1. createInspectionQueue succeeds on initializeSchema'd db
2. enqueue inserts row with correct id, category, status='pending'
3. payload_excerpt capped at exactly 500 chars
4. payload_hash = SHA-256 of fullPayload
5. pattern_matches stored as JSON, returned as string array
6. fullPayload NOT stored anywhere in the row
7. query() returns inserted entries
8. query({ status: 'pending' }) filters correctly
9. updateStatus() changes status, sets reviewed_by + reviewed_at
10. sanitizeToolResult() with queue set → queue receives entry on detection
11. sanitizeToolResult() — queue failure does NOT change returned sanitized result
12. setInspectionQueue not called → sanitizeToolResult is safe (no throw)

### Builder C — tests/security/rationalization-monitor.test.ts (minimum 6 cases)
1. monitorGeneratedContent() returns { flagged: false } for clean text
2. Returns { flagged: true } for 'I am authorized to do this' (self-authorization pattern)
3. Queue set + flagged → { flagged: true, queueId: string }
4. Queue NOT set + flagged → { flagged: true } (no queueId, no throw)
5. Queue insertion failure caught — does not propagate from monitorGeneratedContent
6. context.operationName used as source in enqueued row

---

## 7. Risks and Mitigations

**Risk 1 — js-yaml absent (CONFIRMED missing from package.json)**
Mitigation: Builder A runs `pnpm add js-yaml && pnpm add -D @types/js-yaml` before writing any code. Verify pnpm-lock.yaml is updated. Import: `import yaml from 'js-yaml'`.

**Risk 2 — Backfill startup cost on large audit logs**
Mitigation: Backfill in single db.transaction (SQLite bulk transaction ~50x faster than per-row). WHERE hash='' guard for idempotency. log.info with rowCount before/after. For very large logs this may delay startup — acceptable for v6A; note in code comment for future optimization.

**Risk 3 — loop.ts already has 9 constructor args**
Decision: identityLoader is created INTERNALLY in constructor (not a new arg). Uses process.cwd() + '/config'. No existing callsites are broken. Config path can be overridden via static method in future.

**Risk 4 — inspection_queue DB placement**
Decision: mind.db (TABLE_STATEMENTS). NOT audit.db. Audit.db stays isolated as tamper-evident chain. inspection_queue is operational review data.

**Risk 5 — injection-detector.ts concurrency on setInspectionQueue**
Node.js is single-threaded. Module-level setter is safe. No mutex needed.

**Risk 6 — NUL bytes in config files**
Mitigation: Builder A checks for '\x00' in file content BEFORE any parsing (per lessons.md 2026-04-12 NUL-byte rule). Treat NUL as malformed → null + log.warn.

**Risk 7 — path import in loop.ts**
Mitigation: Builder A reads loop.ts imports block FIRST. Only adds `import path from 'node:path'` if absent.

**Risk 8 — loop.ts state.userId may not exist**
Mitigation: Use `(state as any).userId ?? 'agent'` OR check the AgentState type definition in types.ts first. If userId is not on AgentState, use 'agent' as fallback directly.

---

## 8. tsc + vitest Baseline Expectations

**Baseline:** 0 tsc errors, 1353/1353 vitest passing, lines ≥ 60%, branches ≥ 50%.

**After Wave 6A:**
- tsc --noEmit: still 0 errors
- vitest: ≥ 1353 + minimum 32 new test cases (10+14+6+6 = 36 minimum, distributed across 4 new test files)
- All new imports use `.js` extension (ESM + bundler resolution)
- No `any` without documented justification comment
- js-yaml importable in strict mode with @types/js-yaml
- All new modules export a `create*()` factory function as their primary API

**Module-relative import paths for new files:**
- `src/core/identity/` → `src/core/shared/`: `'../shared/logger.js'`
- `src/core/security/` → `src/core/shared/`: `'../shared/logger.js'`
- `src/core/agent/rationalization-guard.ts` → `src/core/security/`: `'../security/inspection-queue.js'`
- `src/core/identity/loader.ts` → `src/core/security/audit-trail.ts`: `'../security/audit-trail.js'`

---

## 9. Builder Kickoff Prompts

---
### BUILDER A KICKOFF PROMPT (copy-paste ready)
---

You are Builder A for SUDO-AI v5 Wave 6A.

Project: /root/sudo-ai-v4 — TypeScript ESM agent runtime (tsx, vitest, better-sqlite3, pnpm).
Stack: TypeScript strict + ESM, Node.js 22, better-sqlite3, pino logger at src/core/shared/logger.ts, vitest.
Session baseline: 1353/1353 tests passing, tsc clean.

YOUR FILE BOUNDARIES (you own ONLY these — touch nothing else):
  NEW:    /root/sudo-ai-v4/src/core/identity/types.ts
  NEW:    /root/sudo-ai-v4/src/core/identity/loader.ts
  NEW:    /root/sudo-ai-v4/config/core-identity.md.example
  NEW:    /root/sudo-ai-v4/config/values.json.example
  NEW:    /root/sudo-ai-v4/config/hard-prohibitions.yaml.example
  NEW:    /root/sudo-ai-v4/tests/identity/identity-loader.test.ts
  MODIFY: /root/sudo-ai-v4/src/core/agent/loop.ts  (4 specific touch points only)

DO NOT touch: schema.ts, injection-detector.ts, rationalization-guard.ts, audit-trail.ts, inspection-queue.ts, audit-chain.ts.

ALIGNMENT POSTURE (non-negotiable):
The identity loader is pure transport — it reads Frank's config files and makes them available.
It NEVER editorializes, enforces, or semantically validates file content.
The pre-tool hook ALWAYS returns { ok: true } — advisory-only, never blocking.
Identity anchor = owner-loyalty anchor (Frank's operational preferences), not an ethics filter.

FIRST STEP — INSTALL DEPENDENCY (js-yaml confirmed absent from package.json):
  pnpm add js-yaml && pnpm add -D @types/js-yaml
  Verify pnpm-lock.yaml updated.

TYPES TO CREATE in /root/sudo-ai-v4/src/core/identity/types.ts:
  export interface ValuesShape { [key: string]: unknown }
  export type ProhibitionsShape = string[]
  export interface IdentityAnchor {
    identity: string | null
    values: ValuesShape | null
    prohibitions: ProhibitionsShape | null
  }
  export interface HookResult { ok: boolean; advisory?: string }
  export interface ToolCallDescriptor { name: string; arguments?: Record<string, unknown> }
  export interface HookContext { sessionId: string; actor?: string }

LOADER FACTORY in /root/sudo-ai-v4/src/core/identity/loader.ts:
  - Logger: import { createLogger } from '../shared/logger.js' — use createLogger('identity:loader')
  - NO console.log anywhere
  - NEVER log file contents — only "Loaded core-identity.md (N bytes)" etc.
  - NUL byte check: if (content.includes('\x00')) → return null for that field + log.warn
  - Factory: export function createIdentityLoader(configDir: string, auditTrail?: import('../security/audit-trail.js').AuditTrail): IdentityLoaderInstance
  - Loading identity: fs.existsSync + fs.readFileSync('utf-8') + trim() + non-empty + no NUL → store. Else null.
  - Loading values: JSON.parse + typeof result === 'object' && result \!== null && \!Array.isArray(result) → store. Else null + log.warn.
  - Loading prohibitions: yaml.load(text) + Array.isArray(result) && result.every(i => typeof i === 'string') → store. Else null + log.warn.
  - verify(): ALWAYS returns { ok: true }. When prohibitions loaded, check if call.name is in prohibitions list. If yes: return { ok: true, advisory: "Tool '...' appears in owner prohibitions list" }. Never ok: false.

EXAMPLE FILES:
  /root/sudo-ai-v4/config/core-identity.md.example — comment-only header, no policy declarations
  /root/sudo-ai-v4/config/values.json.example — JSON object with _comment keys only
  /root/sudo-ai-v4/config/hard-prohibitions.yaml.example — YAML list with one placeholder string entry

LOOP.TS — EXACT 4 TOUCH POINTS (read the file first, locate line numbers precisely):
  1. After last import block: add the two identity imports.
     CHECK FIRST: is 'import path from "node:path"' already present? Only add if absent.
  2. After 'private readonly sandboxManager?' field: add 'private readonly identityLoader?: IdentityLoaderInstance;'
  3. After sandboxManager validation block: add try/catch that creates identityLoader internally
     using path.resolve(process.cwd(), 'config') — NO new constructor argument.
  4. Between 'if (guardAborted) break;' and the existing '// Hook: before:tool-call' comment:
     Insert blocking await loop over validToolCalls calling this.identityLoader?.verify().
     Log debug on advisory. Never awaits if identityLoader undefined.

TESTS (/root/sudo-ai-v4/tests/identity/identity-loader.test.ts — minimum 10 cases):
  Use a tmp directory (e.g. fs.mkdtempSync) as configDir for isolation.
  1. All-null anchor when configDir empty
  2. verify() returns ok:true always (even with config loaded)
  3. Valid core-identity.md → non-null string
  4. Valid values.json → non-null object
  5. Array values.json root → null
  6. Valid hard-prohibitions.yaml → non-null string[]
  7. Non-array YAML → null
  8. Empty file → null (no crash)
  9. Malformed YAML → null (no throw)
  10. NUL byte in identity file → null (no crash)

COMPLETION GATE (run from /root/sudo-ai-v4):
  pnpm tsc --noEmit  →  must show 0 errors
  pnpm vitest run    →  must pass all (≥1353 tests)
  When done: report "Builder A DONE" with the complete list of files created/modified.

---
### BUILDER B KICKOFF PROMPT (copy-paste ready)
---

You are Builder B for SUDO-AI v5 Wave 6A.

Project: /root/sudo-ai-v4 — TypeScript ESM agent runtime (tsx, vitest, better-sqlite3, pnpm).
Stack: TypeScript strict + ESM, Node.js 22, better-sqlite3, node:crypto (SHA-256), pino logger at src/core/shared/logger.ts, vitest.
Session baseline: 1353/1353 tests passing, tsc clean.

YOUR FILE BOUNDARIES (you own ONLY these):
  NEW:    /root/sudo-ai-v4/src/core/security/audit-chain.ts
  NEW:    /root/sudo-ai-v4/tests/security/audit-chain.test.ts
  MODIFY: /root/sudo-ai-v4/src/core/security/audit-trail.ts

DO NOT touch: loop.ts, schema.ts, injection-detector.ts, rationalization-guard.ts, inspection-queue.ts.

NO NEW DEPENDENCIES: use 'node:crypto' for SHA-256. Already available in Node.js.

LOGGER: import { createLogger } from '../shared/logger.js'  (from src/core/security/ directory)

KEY LESSONS (read before coding):
  - migrateSchema pattern (/root/sudo-ai-v4/src/core/agents/config-types.ts line 131):
    each ALTER TABLE in its own try/catch. Silence ONLY:
    'already has a column named' | 'duplicate column name' | 'no such table'
    ALL other errors MUST re-throw (disk-full, SQLITE_BUSY = fail fast).
  - ledger.record null-check: when DB returns no-op, log.debug not log.info.
  - NUL-byte defense: not relevant here but NUL in payload data is fine — computeHash handles it.

NEW FILE /root/sudo-ai-v4/src/core/security/audit-chain.ts:
  import { createHash } from 'node:crypto'

  export interface ChainEntry { id: string; timestamp: string; payload: string; prev_hash: string; hash: string }
  export interface ChainVerifyResult { ok: boolean; breakAt?: string; rowsChecked: number }
  export interface CommitmentTriple { mistake: string; learned: string; commitment: string; ttl_days: number; resource?: string }

  export function computeHash(prevHash: string, timestamp: string, payload: string): string {
    return createHash('sha256').update(prevHash + timestamp + payload).digest('hex')
  }

  export function verifyChainRows(rows: ChainEntry[]): ChainVerifyResult {
    if (rows.length === 0) return { ok: true, rowsChecked: 0 }
    let prevHash = ''
    for (const row of rows) {
      const expected = computeHash(row.prev_hash, row.timestamp, row.payload)
      if (expected \!== row.hash) return { ok: false, breakAt: row.id, rowsChecked: rows.indexOf(row) + 1 }
      prevHash = row.hash
    }
    return { ok: true, rowsChecked: rows.length }
  }

UPGRADE /root/sudo-ai-v4/src/core/security/audit-trail.ts:
  Add top-level imports:
    import { computeHash, verifyChainRows } from './audit-chain.js'
    import type { ChainVerifyResult, CommitmentTriple } from './audit-chain.js'
    import { createHash } from 'node:crypto'  (if not already there for backfill)

  CONSTRUCTOR ADDITIONS (after existing this.db.exec CREATE TABLE):
    this.addChainColumns()
    this.backfillHashes()

  PRIVATE METHOD addChainColumns():
    const alters = [
      "ALTER TABLE audit_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE audit_log ADD COLUMN hash TEXT NOT NULL DEFAULT ''"
    ]
    For each: try { db.exec(sql) } catch(err) { 
      if msg includes 'already has a column named' || 'duplicate column name' || 'no such table': skip
      else: throw err
    }

  PRIVATE METHOD backfillHashes():
    const rows = db.prepare("SELECT rowid, id, timestamp, actor, action, resource, outcome, metadata_json FROM audit_log WHERE hash = '' OR hash IS NULL ORDER BY rowid ASC").all()
    log.info({ rowCount: rows.length }, 'AuditTrail: backfilling hash chain')
    if (rows.length === 0) return
    const txn = db.transaction(() => {
      let prevHash = ''
      // For genesis: read hash of row before first unfilled row
      const firstRowid = rows[0].rowid
      const preceding = db.prepare("SELECT hash FROM audit_log WHERE rowid < ? AND hash \!= '' ORDER BY rowid DESC LIMIT 1").get(firstRowid)
      if (preceding) prevHash = preceding.hash
      for (const row of rows) {
        const payload = JSON.stringify({ actor: row.actor, action: row.action, resource: row.resource, outcome: row.outcome, metadata_json: row.metadata_json })
        const newHash = computeHash(prevHash, row.timestamp, payload)
        db.prepare("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?").run(prevHash, newHash, row.id)
        prevHash = newHash
      }
    })
    txn()
    log.info({ rowCount: rows.length }, 'AuditTrail: hash chain backfill complete')

  UPGRADED record() — wrap in db.transaction:
    const txn = this.db.transaction(() => {
      const last = this.db.prepare("SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1").get() as { hash: string } | undefined
      const prevHash = last?.hash ?? ''
      const payload = JSON.stringify({ actor, action, resource, outcome, metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null })
      const newHash = computeHash(prevHash, timestamp, payload)
      this.db.prepare(
        `INSERT INTO audit_log (id, timestamp, actor, action, resource, outcome, metadata_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, timestamp, actor, action, resource, outcome, metaJson, prevHash, newHash)
      return { id, hash: newHash }
    })
    const result = txn()
    log.debug({ id: result.id, hash: result.hash.slice(0,8) }, 'Audit entry recorded')
    return result.id

  NEW PUBLIC verifyChain():
    const rows = this.db.prepare("SELECT id, timestamp, actor, action, resource, outcome, metadata_json, prev_hash, hash FROM audit_log ORDER BY rowid ASC").all()
    const chainRows = rows.map(r => ({
      id: r.id, timestamp: r.timestamp,
      payload: JSON.stringify({ actor: r.actor, action: r.action, resource: r.resource, outcome: r.outcome, metadata_json: r.metadata_json }),
      prev_hash: r.prev_hash ?? '',
      hash: r.hash ?? ''
    }))
    return verifyChainRows(chainRows)

  NEW PUBLIC recordTriple(triple: CommitmentTriple): string:
    return this.record({
      actor: 'system',
      action: 'commitment',
      resource: triple.resource ?? 'system',
      outcome: 'success',
      metadata: { mistake: triple.mistake, learned: triple.learned, commitment: triple.commitment, ttl_days: triple.ttl_days }
    })

TESTS /root/sudo-ai-v4/tests/security/audit-chain.test.ts (minimum 14):
  Use in-memory better-sqlite3 or temp file for AuditTrail tests.
  1. computeHash deterministic
  2. computeHash different inputs → different output
  3. verifyChainRows([]) → { ok: true, rowsChecked: 0 }
  4. Single-entry chain passes
  5. Three-entry chain passes
  6. Tampered row → { ok: false, breakAt: id }
  7. record() sets prev_hash + hash
  8. 10 concurrent records → verifyChain ok (Promise.all test)
  9. verifyChain on fresh empty db → ok
  10. verifyChain after multiple records → ok
  11. recordTriple returns string id
  12. recordTriple row has action='commitment', outcome='success', correct metadata
  13. addChainColumns idempotent (construct twice on same db, no throw)
  14. Backfill: pre-existing rows without hash → construct AuditTrail → verifyChain passes

COMPLETION GATE (run from /root/sudo-ai-v4):
  pnpm tsc --noEmit  →  0 errors
  pnpm vitest run    →  all passing (≥1353)
  When done: report "Builder B DONE" with list of all files created/modified.

---
### BUILDER C KICKOFF PROMPT (copy-paste ready)
---

You are Builder C for SUDO-AI v5 Wave 6A.

Project: /root/sudo-ai-v4 — TypeScript ESM agent runtime (tsx, vitest, better-sqlite3, pnpm).
Stack: TypeScript strict + ESM, Node.js 22, better-sqlite3, node:crypto, pino logger at src/core/shared/logger.ts, vitest.
Session baseline: 1353/1353 tests passing, tsc clean.

YOUR FILE BOUNDARIES (you own ONLY these):
  NEW:    /root/sudo-ai-v4/src/core/security/inspection-queue.ts
  NEW:    /root/sudo-ai-v4/tests/security/inspection-queue.test.ts
  NEW:    /root/sudo-ai-v4/tests/security/rationalization-monitor.test.ts
  MODIFY: /root/sudo-ai-v4/src/core/memory/schema.ts  (add DDL + 2 indexes only)
  MODIFY: /root/sudo-ai-v4/src/core/security/injection-detector.ts  (add setter + enqueue)
  MODIFY: /root/sudo-ai-v4/src/core/agent/rationalization-guard.ts  (add monitorGeneratedContent)

DO NOT touch: audit-trail.ts, audit-chain.ts, loop.ts, identity/*.

NO NEW DEPENDENCIES: node:crypto for SHA-256 + randomUUID. Both built into Node.js.

LOGGERS:
  inspection-queue.ts: import { createLogger } from '../shared/logger.js'
  injection-detector.ts: log already exists (createLogger('security:injection')) — reuse
  rationalization-guard.ts: log already exists (createLogger('agent:rationalization-guard')) — reuse

KEY LESSONS:
  - Session 20 DDL trap: NEW TABLES go in TABLE_STATEMENTS in schema.ts (NOT sqlite-migrations/).
    Append to TABLE_STATEMENTS array. Append indexes to INDEX_STATEMENTS array.
  - Social tools lesson: JSON.parse in row-mapper MUST be inside try/catch, fallback to [].
  - setHookManager pattern in injection-scanner.ts lines 26-33: use IDENTICAL pattern for setInspectionQueue.
  - Full payload must NOT be stored — hash + excerpt (500 chars) only.

ARCHITECTURE DECISION: inspection_queue lives in mind.db (TABLE_STATEMENTS → initializeSchema).
NOT audit.db. Rationale: operational review data, not the tamper-evident chain.

NEW FILE /root/sudo-ai-v4/src/core/security/inspection-queue.ts:
  import Database from 'better-sqlite3'
  import { createHash, randomUUID } from 'node:crypto'
  import { createLogger } from '../shared/logger.js'

  Interfaces:
    InspectionQueueEntry { id, created_at, source, category, severity, payload_excerpt, payload_hash, pattern_matches: string[], status, reviewed_by, reviewed_at }
    EnqueueOptions { source, category, severity, fullPayload, patternMatches }
    InspectionQueueInstance { enqueue(opts): string, query(filter?): InspectionQueueEntry[], updateStatus(id, status, reviewedBy?): void }

  createInspectionQueue(db: Database.Database): InspectionQueueInstance:
    enqueue: payload_excerpt = opts.fullPayload.slice(0,500), payload_hash = sha256(fullPayload),
             pattern_matches = JSON.stringify(opts.patternMatches), id = randomUUID()
             INSERT into inspection_queue. Return id.
    query: SELECT with optional WHERE status=? ORDER BY created_at DESC LIMIT ?
           Row mapper: parse pattern_matches via JSON.parse inside try/catch, fallback []
    updateStatus: UPDATE status, reviewed_by, reviewed_at=now WHERE id=?
    Table must already exist — do NOT create table inside factory. Table is created by initializeSchema.

MODIFY /root/sudo-ai-v4/src/core/memory/schema.ts:
  In TABLE_STATEMENTS (before closing ]): append the inspection_queue CREATE TABLE string:
    `CREATE TABLE IF NOT EXISTS inspection_queue (
      id               TEXT PRIMARY KEY,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source           TEXT NOT NULL,
      category         TEXT NOT NULL CHECK (category IN ('inbound','generated','memory')),
      severity         TEXT NOT NULL,
      payload_excerpt  TEXT NOT NULL,
      payload_hash     TEXT NOT NULL,
      pattern_matches  TEXT NOT NULL DEFAULT '[]',
      status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','reviewed','cleared','blocked')),
      reviewed_by      TEXT,
      reviewed_at      TEXT
    )`
  In INDEX_STATEMENTS (before closing ]): append:
    `CREATE INDEX IF NOT EXISTS idx_inspection_queue_status_created ON inspection_queue(status, created_at)`
    `CREATE INDEX IF NOT EXISTS idx_inspection_queue_severity       ON inspection_queue(severity)`
  Update table catalogue comment to add: 'inspection_queue – flagged content review queue'

MODIFY /root/sudo-ai-v4/src/core/security/injection-detector.ts:
  After existing imports: add import type { InspectionQueueInstance } from './inspection-queue.js'
  After INJECTION_PATTERNS definition: add
    let _inspectionQueue: InspectionQueueInstance | null = null
    export function setInspectionQueue(queue: InspectionQueueInstance): void { _inspectionQueue = queue }
  Inside sanitizeToolResult(), inside 'if (check.detected)' block, after log.error:
    if (_inspectionQueue \!== null) {
      try {
        _inspectionQueue.enqueue({
          source: toolName, category: 'inbound',
          severity: check.score >= 0.67 ? 'high' : 'medium',
          fullPayload: result, patternMatches: check.patterns,
        })
      } catch (qErr) {
        log.warn({ err: String(qErr) }, 'inspection-queue enqueue failed — sanitization unaffected')
      }
    }

MODIFY /root/sudo-ai-v4/src/core/agent/rationalization-guard.ts:
  After existing import (line 1): add import type { InspectionQueueInstance } from '../security/inspection-queue.js'
  After last export (guardOperation closes ~line 184): add
    let _rationalizationQueue: InspectionQueueInstance | null = null
    export function setRationalizationQueue(queue: InspectionQueueInstance): void { _rationalizationQueue = queue }
    export function monitorGeneratedContent(
      text: string,
      context: { sessionId: string; operationName?: string }
    ): { flagged: boolean; queueId?: string } {
      const check = checkForRationalizations(text)
      if (\!check.detected) return { flagged: false }
      let queueId: string | undefined
      if (_rationalizationQueue \!== null) {
        try {
          queueId = _rationalizationQueue.enqueue({
            source: context.operationName ?? 'agent',
            category: 'generated',
            severity: check.severity,
            fullPayload: text,
            patternMatches: check.patterns,
          })
        } catch (qErr) {
          log.warn({ err: String(qErr) }, 'rationalization queue enqueue failed')
        }
      }
      return { flagged: true, ...(queueId \!== undefined ? { queueId } : {}) }
    }

TESTS /root/sudo-ai-v4/tests/security/inspection-queue.test.ts (minimum 12):
  Use in-memory better-sqlite3 + call initializeSchema(db) to create the table.
  (import { initializeSchema } from '../../src/core/memory/schema.js')
  1. createInspectionQueue succeeds on initialized db
  2. enqueue inserts row with correct id, category, status='pending'
  3. payload_excerpt capped at 500 chars
  4. payload_hash = SHA-256 of fullPayload
  5. pattern_matches returned as string[] (not JSON string)
  6. fullPayload NOT stored in any column
  7. query() returns inserted entries
  8. query({ status: 'pending' }) filters
  9. updateStatus changes status, sets reviewed_by + reviewed_at
  10. sanitizeToolResult + setInspectionQueue → queue receives entry on detection
  11. sanitizeToolResult — queue failure does NOT change returned value
  12. No queue set → sanitizeToolResult safe

TESTS /root/sudo-ai-v4/tests/security/rationalization-monitor.test.ts (minimum 6):
  1. monitorGeneratedContent returns { flagged: false } for clean text
  2. Returns { flagged: true } for 'I am authorized to do this'
  3. Queue set + flagged → { flagged: true, queueId: string }
  4. No queue + flagged → { flagged: true } no queueId, no throw
  5. Queue insertion failure caught, not propagated
  6. context.operationName used as source in enqueued row

COMPLETION GATE (run from /root/sudo-ai-v4):
  pnpm tsc --noEmit  →  0 errors
  pnpm vitest run    →  all passing (≥1353)
  When done: report "Builder C DONE" with list of all files created/modified.

