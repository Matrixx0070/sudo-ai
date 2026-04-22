# Wave 10G — ArtifactSigner Key Rotation Spec
**Author:** Architect (Sonnet 4.6)  
**Date:** 2026-04-19  
**Status:** APPROVED — broadcast to all builders  

---

## §1. Final Decisions (Overrides on Lead Pre-Decisions)

### Decision 1 — Rotation Trigger (ACCEPTED with addendum)
`POST /v1/admin/key/rotate` Bearer-gated, manual-only.  
Idempotency window: 60,000 ms default. Env override `SUDO_KEY_ROTATION_MIN_INTERVAL_MS` (numeric string, e.g. `"0"` in tests) — checked before the 60s guard so QE can run sequencing tests without mocking clocks or sleeping. No time-based auto-rotation.

### Decision 2 — Dual-Verify Window (ACCEPTED with constant correction)
Single retiring key, 24h window. Constant `RETIREMENT_WINDOW_HOURS = 24`. Retired keys permanently fail verify (no recovery path). Kill-switch `SUDO_DUAL_VERIFY_DISABLE=1` reverts verify() to hard-fail on any non-active keyId.

### Decision 3 — keyId Semantics (CORRECTED)
Use `pubKeyDerHex.slice(24,32)` — skips the 12-byte constant DER/SPKI prefix (`302a300506032b6570032100`) to avoid structural collision. 8 hex chars = 4 bytes = 2^32 uniqueness space. Add `keyVersion: number` to `SignedArtifact` and to `getPublicKey()` return. Collision handling: if INSERT to `key_rotation_log` fails UNIQUE constraint on `key_id`, regenerate keypair up to 3 times before throwing (32-bit keyspace, collision extremely rare in practice but must be specified).

NOTE: Historical v1 row migrated from Wave 10E/10F legacy signer has keyId='302a3005'; this is preserved for backward compat. All v2+ keys use the correct slice.

### Decision 4 — Persistence Model (MODIFIED — drop backward-compat mirror)
**Override:** Drop the `wave10-signer.priv` symlink/copy. The only consumer of that path is `signer.ts` itself (Builder A owns it). A dual-stored active private key creates a sync-failure mode: interrupted rotation → stale priv on disk → sign/verify mismatch without a process restart. Instead:
- Private key files: `data/keys/wave10-signer-v{N}.priv` (mode 0o600), one per version.
- `signer.ts` loads priv by reading the active version from `key_rotation_log`, then reading `wave10-signer-v{N}.priv`.
- Legacy migration path (first startup after Wave 10G deploy): if `wave10-signer.pub` + `wave10-signer.priv` exist AND `key_rotation_log` is empty, execute atomically: copy `wave10-signer.pub` → `wave10-signer-v1.pub` and `wave10-signer.priv` → `wave10-signer-v1.priv` (copies, not moves), INSERT v1 row as 'active'. Legacy `wave10-signer.{pub,priv}` are kept in place so rollback requires no filesystem surgery. This fs work is done by `ArtifactSigner` at construction; it then calls `KeyRotationStore.promoteLegacy(row)` to persist the row.

**Schema:**
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;

CREATE TABLE IF NOT EXISTS key_rotation_log (
  key_version  INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id       TEXT NOT NULL UNIQUE,
  public_key   TEXT NOT NULL,
  algorithm    TEXT NOT NULL DEFAULT 'ed25519',
  status       TEXT NOT NULL CHECK(status IN ('active','retiring','retired')),
  generated_at TEXT NOT NULL,
  retired_at   TEXT
);
```

NOTE: `INTEGER PRIMARY KEY AUTOINCREMENT` — required to prevent SQLite from reusing a deleted version number. Proposal stores use TEXT UUIDs as PK; this table uses monotonic integers, so AUTOINCREMENT is correct here.

**DB path:** `data/keys/key-rotation.db` — env override `SUDO_KEY_ROTATION_DB_PATH` (numeric-string, for test isolation via `vi.resetModules()` + per-test tmpdir, mirroring the `SUDO_SIGNER_KEY_DIR` isolation pattern).

### Decision 5 — State Transitions (MODIFIED — fix cache invalidation)
**Override on sign() lazy-cache bug:** `ArtifactSigner._keys` (line 116) caches the loaded keypair instance-wide. After `rotate()`, the in-process singleton still holds the OLD private key and will sign with it until restart. Fix: replace the flat `_keys: KeyPair | null` cache with `_keysCache: Map<number, KeyPair>` keyed by `keyVersion`. On `sign()`, look up current active version from DB, then check cache by version, loading from disk only on miss. On `rotate()`, nothing to invalidate — new version has its own cache slot.

**State machine:**
- `rotate()`:
  1. Generate new ed25519 keypair (up to 3 attempts on UNIQUE `key_id` collision — generated outside the transaction so collisions can retry without re-acquiring lock).
  2. Write `wave10-signer-v{N+1}.priv` (0o600) to key dir — crash here leaves an orphan priv file; DB is source of truth, orphans are ignored on startup.
  3. Call `_store.promoteNewKey(newRow, RETIREMENT_WINDOW_HOURS, idempotencyWindowMs)` which runs `BEGIN IMMEDIATE` internally. Inside the transaction: (a) re-check idempotency window — if within window, ROLLBACK and return existing active row with `idempotent: true`. (b) Otherwise: INSERT v(N+1) row status='active'; UPDATE v(N) row status='retiring' retired_at=now+24h; COMMIT. Using BEGIN IMMEDIATE prevents two concurrent POSTs from both reading "outside window" and both committing new rows (concurrent second writer blocks at IMMEDIATE until first commits, then sees v(N+1) already active and returns idempotent).
  4. If `idempotent: true` returned from step 3: best-effort delete the orphan `wave10-signer-v{N+1}.priv` just written in step 2 (it was not needed), then return 200 with idempotent flag.
  5. Best-effort delete `wave10-signer-v{N}.priv` after commit (fail-open: log.warn if unable).
  6. Return `{ keyId, keyVersion, algorithm, generatedAt, retiredKeyId, retiredKeyVersion, idempotent: false }`.

- `sign()`:
  0. Call `_store.getActive()`. If null (fresh install — no legacy files, empty DB), auto-seed: generate ed25519 keypair, write `wave10-signer-v1.pub` (0644) + `wave10-signer-v1.priv` (0600) to key dir, call `_store.promoteLegacy({key_id, public_key, algorithm, status:'active', generated_at, retired_at:null})`. This is the same auto-generate path as the pre-10G `loadOrGenerateKeyPair()`, now always terminates with a v1 DB row.
  1. Query DB for active row (now guaranteed non-null after step 0).
  2. Check `_keysCache` for that version. On miss, read `wave10-signer-v{N}.priv` + use `public_key` from DB row, populate cache.
  3. Sign and return artifact with `keyVersion: N`.

- `verify(artifact)`:
  1. If `artifact.keyVersion` present, look up that version in DB. Otherwise fall back to keyId match across all non-retired rows.
  2. If `SUDO_DUAL_VERIFY_DISABLE === '1'`: reject anything that is not status='active'.
  3. Else: accept status='active' or status='retiring' (check `retired_at > now`). Reject status='retired' or retiring with `retired_at <= now`.
  4. Reconstruct public key from DB `public_key` field (not from disk), verify signature.

### Decision 6 — Federation Peer Notification (ACCEPTED — OUT OF SCOPE)
Wave 10H owns federation peer public-key fetching end-to-end.

### Decision 7 — Kill-Switches (ACCEPTED with test-isolation addendum)
- `SUDO_KEY_ROTATION_DISABLE=1` → rotate endpoint returns 503.
- `SUDO_DUAL_VERIFY_DISABLE=1` → verify() hard-fails on non-active keyId.
- `SUDO_KEY_ROTATION_MIN_INTERVAL_MS` (numeric string) → idempotency window in ms (default: `"60000"`).
- `SUDO_KEY_ROTATION_DB_PATH` (string) → override DB path for test isolation.

---

## §2. Interface Contracts

### 2.1 Updated `SignedArtifact` (in `src/core/shared/wave10-types.ts`)
Builder A updates this type. The change is additive (backward compat: `keyVersion` added as required field, existing tests fail only if they assert exact field sets — check KR-14 coverage).

```typescript
export interface SignedArtifact {
  payload: unknown;
  signedAt: string;
  keyId: string;
  keyVersion: number;          // NEW in Wave 10G — monotonic integer from key_rotation_log
  signature: string;
  artifactType: 'skill' | 'bench_report' | 'config_proposal' | 'trace_pattern' | 'generic';
}
```

### 2.2 `KeyRotationStore` (new file `src/core/security/key-rotation-store.ts`)
Builder A owns this file exclusively.

```typescript
export interface KeyRotationRow {
  key_version: number;
  key_id: string;
  public_key: string;        // full DER hex
  algorithm: 'ed25519';
  status: 'active' | 'retiring' | 'retired';
  generated_at: string;      // ISO-8601
  retired_at: string | null; // ISO-8601, null while active or retiring with future expiry
}

export class KeyRotationStore {
  constructor(dbPath?: string);  // default: 'data/keys/key-rotation.db'

  // Persist a pre-built v1 row when ArtifactSigner detects legacy files at construction.
  // Called by signer.ts after it has already done the fs copy work (pub+priv files).
  // No-op if key_rotation_log is not empty (idempotent).
  promoteLegacy(row: Omit<KeyRotationRow, 'key_version'>): KeyRotationRow;

  // Return the current active row or null if table is empty (pre-first-sign).
  getActive(): KeyRotationRow | null;

  // Return a specific version row or null.
  getByVersion(version: number): KeyRotationRow | null;

  // Return a specific row by keyId (8-char prefix) across all rows.
  getByKeyId(keyId: string): KeyRotationRow | null;

  // Transactional (BEGIN IMMEDIATE): check idempotency, insert new active row, set old active
  // to retiring — all inside one exclusive transaction to prevent concurrent rotate() races.
  // Returns the new active row (or existing active if within idempotency window).
  // Throws on 3× key_id UNIQUE collision.
  promoteNewKey(newRow: Omit<KeyRotationRow, 'key_version'>, retirementWindowHours: number, idempotencyWindowMs: number): KeyRotationRow & { idempotent: boolean };

  // Lazily expire retiring rows whose retired_at <= now (called at verify time).
  expireIfDue(version: number): void;

  // Return timestamp (ms) of last active row's generated_at, or 0 if empty.
  // NOTE: Used outside the transaction only for pre-check; definitive check is inside BEGIN IMMEDIATE.
  lastRotatedAt(): number;
}
```

### 2.3 Updated `ArtifactSigner` (`src/core/security/signer.ts`)
Builder A owns this file exclusively.

```typescript
class ArtifactSigner {
  private _store: KeyRotationStore;
  private _keysCache: Map<number, { privateKeyDerHex: string }>;  // keyed by keyVersion

  // CHANGED: initialise _store at construction, call _store.migrate()
  constructor();

  // CHANGED: loads active version from DB; uses version-keyed cache
  sign(payload: unknown, artifactType: SignedArtifact['artifactType']): SignedArtifact;  // now includes keyVersion

  // CHANGED: multi-key lookup + retirement window enforcement
  verify(artifact: SignedArtifact): ArtifactVerifyResult;

  // CHANGED: returns keyVersion from active DB row
  getPublicKey(): {
    keyId: string;
    keyVersion: number;          // NEW
    algorithm: 'ed25519';
    publicKey: string;
    generatedAt?: string;
    retiring?: {                 // NEW (optional) — present when a retiring key exists
      keyId: string;
      keyVersion: number;
      publicKey: string;
      retiredAt: string;
    };
  };

  // NEW
  rotate(): {
    keyId: string;
    keyVersion: number;
    algorithm: 'ed25519';
    generatedAt: string;
    retiredKeyId?: string;
    retiredKeyVersion?: number;
  };
}
```

Note: `getPublicKey()` gains optional `retiring` sub-object. This is additive — PK-1 test still passes because it only asserts presence of `keyId`, `algorithm`, `publicKey`. The retiring field enables Wave 10H federation to consume key transition metadata without a new endpoint.

### 2.4 `POST /v1/admin/key/rotate` (in `src/core/gateway/admin-routes.ts`)
Builder B owns route wiring exclusively.

**Auth:** Bearer token required (same `isAuthorised()` guard as all other admin routes).  
**Kill-switch:** `SUDO_KEY_ROTATION_DISABLE === '1'` → 503 before any logic.  
**Idempotency:** If `rotate()` detects within-window call, it returns 200 with current active key data and `idempotent: true` flag.

Request: `POST /v1/admin/key/rotate` — no request body required.

Response 200:
```json
{
  "ok": true,
  "data": {
    "keyId": "3a4b5c6d",
    "keyVersion": 2,
    "algorithm": "ed25519",
    "generatedAt": "2026-04-19T10:00:00.000Z",
    "retiredKeyId": "1a2b3c4d",
    "retiredKeyVersion": 1,
    "idempotent": false
  }
}
```

Response 401: `{ "error": "Unauthorized: invalid or missing bearer token" }`  
Response 503: `{ "error": "Key rotation is disabled (SUDO_KEY_ROTATION_DISABLE=1)" }`

**Route registration** — add to the `registerAdminRoutes` dispatcher block:
```typescript
if (method === 'POST' && pathname === '/v1/admin/key/rotate') {
  handleKeyRotate(res).catch((err: unknown) => { ... });
  return;
}
```

### 2.5 Updated `GET /v1/admin/public-key` response (Builder B)
The handler calls `artifactSigner.getPublicKey()` which now returns `keyVersion`. Builder B passes it through — `handlePublicKeyGet` change is minimal (no logic change, just updated return type from the method).

### 2.6 `signedArtifact` response update (Builder B — learning-routes.ts)
Both `handleApprove` in `learning-routes.ts` and `handleSkillOptimizationApprove` in `admin-routes.ts` already return `signedArtifact` from `artifactSigner.sign()`. Since `sign()` now emits `keyVersion`, both responses automatically include it — zero change to route logic needed beyond ensuring tsc compiles cleanly against the new `SignedArtifact` type.

---

## §3. File Boundaries

### Builder A — Senior Builder
**Owns exclusively:**
- `/root/sudo-ai-v4/src/core/security/signer.ts` (rewrite internal logic; public API of `ArtifactSigner` is additive, existing consumers are unchanged)
- `/root/sudo-ai-v4/src/core/security/key-rotation-store.ts` (NEW — SQLite wrapper per §2.2 schema)
- `/root/sudo-ai-v4/src/core/shared/wave10-types.ts` — ONLY the `SignedArtifact` interface block (add `keyVersion: number` field)

Builder A does NOT touch: any route files, any test files, any other type in wave10-types.ts.

### Builder B — Backend Builder
**Owns exclusively:**
- `/root/sudo-ai-v4/src/core/gateway/admin-routes.ts` — add `POST /v1/admin/key/rotate` route + update `handlePublicKeyGet` call site (pass-through only)
- `/root/sudo-ai-v4/src/core/gateway/learning-routes.ts` — verify tsc passes with updated `SignedArtifact` type (no logic change expected; confirm `keyVersion` flows through in response)

Builder B does NOT touch: signer.ts, key-rotation-store.ts, wave10-types.ts, any test files.

### Quality Engineer — Writes ALL tests
**Owns exclusively:**
- `/root/sudo-ai-v4/tests/security/key-rotation.test.ts` (NEW — KR-1 through KR-13)
- `/root/sudo-ai-v4/tests/security/signer.test.ts` (verify KR-14: existing 13 tests still pass; add `keyVersion` assertion)
- `/root/sudo-ai-v4/tests/security/signer-integration.test.ts` (verify KR-15: INT-S1/S4 check `keyVersion` present in signedArtifact)
- `/root/sudo-ai-v4/tests/gateway/admin-public-key.test.ts` (PK-1: add `keyVersion` assertion)

QE does NOT touch: source files.

---

## §4. Test Plan (minimum 15 tests — QE writes all)

All tests in `tests/security/key-rotation.test.ts` unless noted. Isolation pattern: per-test `fs.mkdtempSync` + `SUDO_SIGNER_KEY_DIR` + `SUDO_KEY_ROTATION_DB_PATH` + `SUDO_KEY_ROTATION_MIN_INTERVAL_MS=0` + `vi.resetModules()` after each test. Use `ArtifactSigner` instances (not singleton) for unit tests.

**KR-1 — Migration: legacy files promoted to v1**
Given `wave10-signer.{pub,priv}` exist in key dir and `key_rotation_log` is empty, constructing `ArtifactSigner` inserts v1 row with status='active'. Verify `getActive().key_version === 1` and `wave10-signer-v1.priv` exists in key dir.

**KR-2 — rotate() generates new keypair and returns v2 metadata**
Given a clean key dir (no legacy files), call `sign()` once to seed v1, then `rotate()`. Assert return has `keyVersion: 2`, `keyId` is 8 hex chars, `retiredKeyVersion: 1`. Verify `wave10-signer-v2.priv` exists and `wave10-signer-v1.priv` is gone.

**KR-3 — retiring transition: v1 status becomes 'retiring' after rotate()**
After rotate(), query `KeyRotationStore.getByVersion(1)`. Assert `status === 'retiring'` and `retired_at` is approximately 24h from now (within 5s tolerance).

**KR-4 — priv file: old priv deleted, new priv at 0o600**
After rotate(), assert `wave10-signer-v1.priv` does not exist, `wave10-signer-v2.priv` exists with mode `0o600`.

**KR-5 — Idempotency: second rotate() within window returns idempotent=true (sequential)**
Set `SUDO_KEY_ROTATION_MIN_INTERVAL_MS=60000`. Call rotate() twice in quick succession. Second call returns `idempotent: true` with same `keyId` + `keyVersion`. DB still has only v2 as active (no v3 inserted).

**KR-5b — Concurrent rotate() safety: parallel calls produce exactly one new version**
Set `SUDO_KEY_ROTATION_MIN_INTERVAL_MS=0` (allow rotation). Fire `Promise.all([signer.rotate(), signer.rotate()])`. Assert DB has exactly two versions total (v1 retiring + v2 active, NOT three). One promise returns `idempotent: true`. This validates the `BEGIN IMMEDIATE` concurrency guard.

**KR-6 — verify() accepts artifact signed with retiring key**
After rotate() to v2, verify an artifact that was signed with v1 (still in retiring window). Assert `result.valid === true`.

**KR-7 — verify() rejects artifact when retiring key's retired_at has passed**
Manually INSERT a retiring row with `retired_at` = 2 minutes ago. Call `verify()` with an artifact bearing that `keyId` + `keyVersion`. Assert `result.valid === false` and `result.error` contains 'retired'.

**KR-8 — verify() rejects unknown keyVersion**
Pass artifact with `keyVersion: 999` (not in DB). Assert `result.valid === false`.

**KR-9 — SUDO_DUAL_VERIFY_DISABLE=1 reverts to active-only check**
Set `SUDO_DUAL_VERIFY_DISABLE=1`. After rotate(), verify an artifact signed by v1 (retiring). Assert `result.valid === false` even though `retired_at` is in the future.

**KR-10 — sign() after rotate() uses new active key**
After rotate() to v2, call `sign()`. Assert returned artifact has `keyVersion: 2` and verify with `ArtifactSigner.verify()` returns `valid: true`.

**KR-11 — POST /v1/admin/key/rotate returns 200 with correct shape**
Start in-process HTTP server with `registerAdminRoutes`. POST to `/v1/admin/key/rotate` with valid Bearer token. Assert 200, `ok: true`, `data.keyVersion` is number, `data.keyId` matches 8-hex pattern.

**KR-12 — POST /v1/admin/key/rotate returns 401 without token**
POST without Authorization header. Assert 401.

**KR-13 — POST /v1/admin/key/rotate returns 503 with SUDO_KEY_ROTATION_DISABLE=1**
Set kill-switch. POST with valid token. Assert 503, error message contains 'disabled'.

**KR-14 — Existing signer.test.ts (13 tests) still pass; sign() output includes keyVersion**
Add assertion to the sign+verify roundtrip test: `expect(typeof artifact.keyVersion).toBe('number')`. All 13 existing assertions must remain green.

**KR-15 — INT-S1 and INT-S4 include keyVersion in signedArtifact**
In `signer-integration.test.ts` INT-S1: assert `artifact.keyVersion` is a positive integer.  
In INT-S4 route test: assert `sa['keyVersion']` is a number.  
PK-1 in `admin-public-key.test.ts`: assert `data['keyVersion']` is a number.

---

## §5. Migration Risk and Rollback

### Migration Path (startup after Wave 10G deploy)
`KeyRotationStore.migrate()` is called at `ArtifactSigner` construction. It is idempotent (checks `COUNT(*) === 0` on `key_rotation_log` before acting). It reads `wave10-signer.pub` from disk. If the pub file is missing, it skips migration and lets `sign()` auto-generate fresh keys as v1.

**Risk:** If both the legacy pub file and the new DB already have rows (impossible in normal deploy but possible if 10G deploy is partially applied twice), the CHECK on `COUNT(*) === 0` prevents double-migration.

### Fixture Risk for Existing Tests
The 13 tests in `signer.test.ts` create fresh `ArtifactSigner` instances pointed at `mkdtempSync` dirs. The `key_rotation_log` DB is stored in the SAME directory as the key files (controlled by `SUDO_KEY_ROTATION_DB_PATH`, defaulting to `data/keys/key-rotation.db` but overridden to the temp dir in tests). No existing test touches the prod DB. The only new assertion risk is `artifact.keyVersion` — if any existing test does a deep-equal on the full artifact shape it will need `keyVersion` added. Inspect before finalizing.

### Rollback
If tests fail post-deploy:
1. `pm2 restart sudo-ai-v5` — no code change needed to revert signing behavior (kill-switch: `SUDO_SIGNING_DISABLE=1` already exists).
2. The `key_rotation_log` table is additive. Reverting to pre-10G code: old `signer.ts` does not read the DB — it reads `wave10-signer.pub/.priv` directly. These files still exist as `wave10-signer-v1.pub/.priv` after migration. If the legacy names are deleted, they must be restored: `cp data/keys/wave10-signer-v1.pub data/keys/wave10-signer.pub && cp data/keys/wave10-signer-v1.priv data/keys/wave10-signer.priv` (then `chmod 0600`).
3. Migration copies (does not move) legacy files. Legacy `wave10-signer.pub/.priv` remain on disk after migration completes, so rollback to pre-10G code requires no filesystem surgery beyond `pm2 restart`.

---

## §6. Fast-Pass Summary for Builders

**Wave 10G adds ed25519 key rotation to ArtifactSigner.** Builder A rewrites `signer.ts` and adds a new SQLite-backed `key-rotation-store.ts`: keys get monotonic `key_version` integers, active private keys live at `wave10-signer-v{N}.priv`, the old private key is deleted (not shadowed) after rotation, and the in-process cache is version-keyed to handle post-rotate sign() calls correctly. Builder B wires one new route (`POST /v1/admin/key/rotate`) into `admin-routes.ts` and confirms `learning-routes.ts` passes tsc without logic changes. Both builders must NOT touch test files — Quality Engineer owns all tests. Kill-switches `SUDO_KEY_ROTATION_DISABLE=1` and `SUDO_DUAL_VERIFY_DISABLE=1` follow the `=== '1'` semantics; `SUDO_KEY_ROTATION_DB_PATH` and `SUDO_KEY_ROTATION_MIN_INTERVAL_MS` are test-isolation env vars. The existing 23 signer tests (13 unit + 10 INT-S) must remain green; QE adds minimum 15 new KR tests.

---

## Appendix: Crash-Recovery Ordering

The write sequence in `rotate()` is designed so any crash leaves either a cleanly committed state or a recoverable orphan:

1. Write `wave10-signer-v{N+1}.priv` (0600) — crash here: orphan priv file on disk, DB unchanged, system continues with v(N) as active. Orphan is inert (no DB reference).
2. BEGIN txn; INSERT v(N+1) active; UPDATE v(N) retiring; COMMIT — crash during txn: automatic SQLite WAL rollback, system continues with v(N) active. Orphan v(N+1).priv remains (inert).
3. Crash after COMMIT: both rows in DB. v(N).priv still exists (not yet deleted). Sign() loads v(N+1) from DB, reads v(N+1).priv correctly. Verify() accepts v(N) during retirement window using its DB `public_key`.
4. Best-effort delete `wave10-signer-v{N}.priv` — crash or failure here: priv file for retiring key lingers on disk. Harmless (DB is source of truth; verify() uses `public_key` from DB row, not disk).

**DB is always source of truth for which key is active. Disk priv files are write-once secrets that the DB version index points to.**
