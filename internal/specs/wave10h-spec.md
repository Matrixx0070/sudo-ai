# Wave 10H — Architect Spec: Federation Peer Public-Key Fetch + End-to-End Sign/Verify

**Date**: 2026-04-20  
**Architect**: Wave 10H spec  
**Baseline**: 3555/3555 tests, prod PID 2172869 :18900, staging :18901 (soak, untouched)  
**Budget**: 4 parallel builders, each <45 min, no retry loop

---

## §1 Scope Decision: Option B (End-to-End)

Chosen: **Option B** — fetcher + cache + sign-outbound at federation publish + verify-inbound at federation ingest with fail-open backward compat.

Justification:

- **No dead code**: Option A ships a key cache with zero consumers in prod. The cache has no miss path to exercise, the `/v1/federation/public-key` endpoint is never fetched, and correctness cannot be tested except by calling the endpoint manually. Option B creates a real consumer (ingest verify) in the same wave.
- **Atomic correctness**: The sign/verify loop is a two-sided contract. Shipping one side verifiably works only when both sides exist in the same integration test. Splitting to Option C defers that proof to the next wave, with duplicated context ramp-up.
- **Fail-open transition safety**: Adding optional signature fields to `FederatedEvent` and accepting unsigned events when `SUDO_FED_STRICT_VERIFY` is unset means zero observable change for prod today (SUDO_FEDERATION_PEERS is unset in prod; 0 peers = 0 key fetches = 0 verify calls). The feature activates incrementally as operators configure peers.
- **Wave size is bounded**: B is 4 builders at ~45 min each, same as Wave 10G (also 4-builder profile). Wave 10G shipped in one pass; this is comparable complexity.
- **One-wave memory cost**: Closing both sides in 10H eliminates a Wave 10I briefing cycle. The total wall-clock time is less than A+I separated.

---

## §2 Peer-Identity Resolution

**Chosen: (a) broadcast-fetch on unknown keyId.**

Analysis of options:

- **(b) add instanceId to SignedArtifact**: Non-goal explicitly — "No change to SignedArtifact shape" per Wave 10H briefing §Non-goals. Requires compat migration and breaks 10G response shape.
- **(c) reverse keyId→peerUrl cache built from observed artifacts per peer**: Requires knowing the peer URL before the first artifact arrives, which is circular. Also relies on the unauthenticated `X-Sudo-Instance` header (audit-chain-sync.ts:203), which is a claimed identity, not a cryptographic one.
- **(d) add `issuer` field to SignedArtifact**: Also a shape change violating the non-goal.
- **(a) broadcast-fetch**: On cache miss for a `keyId`, fan out `GET /v1/federation/public-key` to ALL configured `SUDO_FEDERATION_PEERS` in parallel with `AbortSignal.timeout(3000)` (matches `FETCH_TIMEOUT_MS` precedent in audit-chain-sync.ts:25). First peer whose response contains a `keyId` or `retiring.keyId` matching the artifact's `keyId` wins. Cache the match: `keyId → {publicKeyDerHex, peerName, fetchedAt}`. If no peer matches, verification returns `{valid: false, error: 'key unknown; no peer claimed it'}`. This requires zero schema changes to `SignedArtifact`, `PeerConfig`, or `FederatedEvent`.

**Important constraint**: `X-Sudo-Instance` header MUST NOT be used for peer identity. It is an unauthenticated self-claim. Only `keyId` is cryptographically grounded.

---

## §3 Cache Design

**Chosen: in-memory `Map<keyId, PeerKeyEntry>`**

```typescript
// src/core/federation/peer-key-cache.ts — exported shape
export interface PeerKeyEntry {
  keyId: string;
  publicKeyDerHex: string;
  peerName: string;
  fetchedAt: number; // Date.now() epoch ms
}
```

Rationale:
- The cache is a performance optimisation, not a source of truth. On process restart it re-hydrates on demand (lazy fetch on first verify miss post-restart).
- SQLite adds schema migration, test isolation overhead, and concurrent-write complexity for data that is inherently ephemeral and publicly re-fetchable.
- The peer's `GET /v1/admin/public-key` endpoint (already live) is the authoritative source. Local DB would just be a replica with drift risk.

**TTL**: Default 1 hour. Configurable via `SUDO_FED_KEY_CACHE_TTL_MS` (numeric env, default `3600000`). On each `get(keyId)`: if `Date.now() - fetchedAt > TTL`, treat as miss and re-fetch.

**Invalidation on verify-fail**: If `ArtifactSigner.verify()` returns `valid:false` for an artifact whose `keyId` IS in cache (i.e., cached key is wrong/stale), evict the entry and re-fetch before returning final result. This handles key rotation on the remote peer. One retry only — do not loop.

**Size cap**: Hard cap at 1000 entries (protect against pathological keyId fan-in from malicious peers). On cap breach, evict oldest `fetchedAt` entries (batch evict 10% — follow Wave 10C metrics.ts pattern).

**Concurrent fetch de-dup (PeerKeyFetcher)**: `PeerKeyFetcher` holds `private _inflight = new Map<string, Promise<PeerKeyEntry | null>>()`. In `fetchForKeyId(keyId)`: if `_inflight.has(keyId)`, return the existing promise (coalesce all concurrent callers). Otherwise create the promise, store in map, await it, delete entry after settle (success or error). Prevents 100× fan-out for the same unknown keyId arriving in a burst.

---

## §4 Auth for Peer-Key Fetch

**Chosen: New `/v1/federation/public-key` endpoint, federation bearer gated.**

- The existing `/v1/admin/public-key` is admin-bearer gated (`GATEWAY_TOKEN`). Peers do not hold the admin token — they hold a federation inbound token from `SUDO_FEDERATION_INBOUND_TOKENS`.
- Adding `adminToken` to `PeerConfig` would require env-config changes on all operators and represents unnecessary privilege escalation (a peer should not have admin access to fetch a public key).
- New endpoint `GET /v1/federation/public-key` uses the same `isFederationAuthorised()` path already in federation-routes.ts:84. Same auth guard as `/tail`.
- Response shape matches `/v1/admin/public-key` exactly: `{ok:true, data:{keyId, keyVersion, algorithm, publicKey, generatedAt, retiring?}}`. Peers call this endpoint; the fetcher module parses the same shape.
- No auth-token widening to admin routes required.

**Who calls it**: `PeerKeyFetcher` (B1) calls each peer's `/v1/federation/public-key` using the peer's outbound bearer token from `PeerConfig.token` (same token used for `postToPeer` and `fetchPeerTail`).

---

## §5 Failure Semantics

**Default: fail-open (accept unverified), log warn.**

Rationale: SUDO_FEDERATION_PEERS is unset in prod today. Zero peers = zero fetches = zero verify calls. The fail-open default ensures zero behavioral change on prod until an operator explicitly configures peers.

| Condition | Fail-open behavior | Fail-closed behavior (`SUDO_FED_STRICT_VERIFY=1`) |
|---|---|---|
| No peers configured | Accept (no verify attempt) | Accept (no peers to verify against) |
| Fetch 503/timeout from all peers | Accept, log `fed.key_fetch_fail` warn | 502 / reject event |
| keyId unknown to all peers | Accept unverified, log warn | 400 reject |
| keyId found, signature invalid | Reject regardless (cryptographic forgery) | Reject regardless |
| keyId found, signature valid | Accept as verified | Accept as verified |
| `SUDO_FED_VERIFY_DISABLE=1` | Skip verify entirely | Skip verify entirely |

**Cryptographic failures (sig invalid) always reject regardless of fail-open setting** — a wrong signature means the payload was tampered; accepting it would be a security regression.

---

## §6 TOFU vs Pinned-Key Trust

**Chosen: TOFU (Trust On First Use) via authenticated federation channel.**

The first `GET /v1/federation/public-key` that returns a `keyId` matching an artifact establishes the trust anchor for that keyId. The request is authenticated (federation bearer), so the trust anchor is established over an authed channel, not an anonymous one.

This is the same model used by SSH TOFU and TLS server certs on first connection. Adequate for MVP. Key pinning (requiring config-file declaration of expected keyIds per peer) is deferred to a future hardening wave.

**Rotation handling**: When a peer rotates its key, the new `keyId` will not be in cache. Broadcast-fetch will re-fetch and get the new active key (plus optional `retiring` key). The old `keyId` entry in cache will expire by TTL or be invalidated by verify-fail whichever comes first.

---

## §7 Kill-Switches

All use `=== '1'` exact semantics per Wave 10F standardisation. All are fail-open when unset.

| Env Var | Default | Effect |
|---|---|---|
| `SUDO_FED_VERIFY_DISABLE=1` | unset (off) | Skip all ingest verification; accept all events without checking signature |
| `SUDO_FED_SIGN_DISABLE=1` | unset (off) | Skip signing on federation publish; send unsigned FederatedEvent |
| `SUDO_FED_KEY_FETCH_DISABLE=1` | unset (off) | Disable peer key fetches entirely; cache always miss (implies verify fails or uses known keys only) |
| `SUDO_FED_STRICT_VERIFY=1` | unset (off) | Flip from fail-open to fail-closed on unknown keyId or fetch failure |
| `SUDO_FED_KEY_CACHE_TTL_MS` | `3600000` | Numeric TTL in ms for cache entries (not a boolean kill-switch) |

**Existing kill-switches unchanged**: `SUDO_SIGNING_DISABLE`, `SUDO_DUAL_VERIFY_DISABLE`, `SUDO_KEY_ROTATION_DISABLE`, `SUDO_FEDERATION_PEERS`.

Note: `SUDO_FED_SIGN_DISABLE` is SEPARATE from `SUDO_SIGNING_DISABLE`. The existing `SUDO_SIGNING_DISABLE` disables the local `ArtifactSigner.sign()` entirely including the REST approve handlers. `SUDO_FED_SIGN_DISABLE` disables only the federation publish signing path, leaving local REST signing intact.

---

## §8 File Boundaries Per Builder

**Critical: no two builders may touch the same file. Architect-enforced.**

### Builder B1 — Peer Key Cache + Fetcher (new infra layer)

**Owns exclusively**:
- `src/core/federation/peer-key-cache.ts` (NEW — ~120 lines)
- `src/core/federation/peer-key-fetcher.ts` (NEW — ~100 lines)
- `tests/federation/peer-key-cache.test.ts` (NEW — ~60 lines, unit)
- `tests/federation/peer-key-fetcher.test.ts` (NEW — ~60 lines, unit with `vi.stubGlobal('fetch', ...)`)

**Does NOT touch**: any existing file.

**Exported interface (must be published before B2/B3 start consuming)**:

```typescript
// peer-key-cache.ts exports
export interface PeerKeyEntry {
  keyId: string;
  publicKeyDerHex: string;
  peerName: string;
  fetchedAt: number;
}
export class PeerKeyCache {
  get(keyId: string): PeerKeyEntry | undefined;
  set(entry: PeerKeyEntry): void;
  evict(keyId: string): void;
  size(): number;
  _setTtl(ms: number): void; // for test overrides
}

// peer-key-fetcher.ts exports
export interface PeerPublicKeyResponse {
  keyId: string;
  keyVersion: number;
  algorithm: string;
  publicKey: string; // DER hex
  generatedAt: string;
  retiring?: { keyId: string; keyVersion: number; publicKey: string };
}
export class PeerKeyFetcher {
  constructor(registry: PeerRegistry, cache: PeerKeyCache);
  // Broadcast fetch all peers, cache first match, return entry or null
  fetchForKeyId(keyId: string): Promise<PeerKeyEntry | null>;
  // Force-refetch bypassing cache (used after verify-fail)
  refetchForKeyId(keyId: string): Promise<PeerKeyEntry | null>;
}
```

### Builder B2 — Sign-on-Publish in AuditChainSync

**Owns exclusively**:
- `src/core/federation/audit-chain-sync.ts` (EDIT — add optional signature fields)
- `src/core/security/signer.ts` (EDIT — add `verifyWithPublicKey()` public method; extract no new helper — `buildSignInput()` at signer.ts:110 is already a module-level function and is reused by the new method via closure)
- `tests/federation/audit-chain-sign.test.ts` (NEW — ~60 lines)

**Does NOT touch**: federation-routes.ts, peer-key-cache.ts, cli.ts.

**Envelope augmentation decision (Y — inline-augment FederatedEvent)**:

Add optional fields to `FederatedEvent` interface (additive, backward compat):
```typescript
export interface FederatedEvent {
  // existing required fields unchanged
  id: string;
  instanceId: string;
  eventType: string;
  payload: unknown;
  ts: number;
  seq: number;
  // Wave 10H additions — optional, absent on unsigned events
  keyId?: string;
  keyVersion?: number;
  signature?: string;
  signedAt?: string;
}
```

`publishEvent()` gains an optional `ArtifactSigner` dependency injected via constructor:
```typescript
constructor(db: AuditDbLike, registry: PeerRegistry, instanceId: string, signer?: ArtifactSigner)
```
When signer is provided and `SUDO_FED_SIGN_DISABLE \!== '1'`, publishEvent signs the payload as `artifactType: 'federation_event'` (new enum literal added to `wave10-types.ts` — see §8 note below) and attaches `{keyId, keyVersion, signature, signedAt}` to the envelope before fan-out.

**IMPORTANT**: B2 must add `'federation_event'` to the `artifactType` union in `src/core/shared/wave10-types.ts`. This is the ONE shared-type file touch in the wave; both B2 and B3 depend on it. B2 owns the edit, B3 reads it. This is the only permissible wave10-types.ts change.

**B2 must also add to `ArtifactSigner` in signer.ts**:
```typescript
// signer.ts:110 defines buildSignInput(payload, signedAt) — already the shared helper
// used by both sign() (L306) and verify() (L417). Add this additive public method:
verifyWithPublicKey(artifact: SignedArtifact, publicKeyDerHex: string): boolean {
  const input = buildSignInput(artifact.payload, artifact.signedAt);  // reuses signer.ts:110
  const pubKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyDerHex, 'hex'),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, input, pubKey, Buffer.from(artifact.signature, 'hex'));
}
```
Existing `sign()` and `verify()` signatures are **unchanged** — this is additive only. B3 calls `deps.artifactSigner.verifyWithPublicKey(artifact, keyEntry.publicKeyDerHex)` for peer verification.

### Builder B3 — Verify-on-Ingest + `/v1/federation/public-key` Endpoint

**Owns exclusively**:
- `src/core/gateway/federation-routes.ts` (EDIT)
- `tests/gateway/federation-public-key.test.ts` (NEW — ~50 lines)
- `tests/gateway/federation-ingest-verify.test.ts` (NEW — ~80 lines)

**Does NOT touch**: audit-chain-sync.ts, peer-key-cache.ts, cli.ts, wave10-types.ts, signer.ts.

**New endpoint** `GET /v1/federation/public-key`:
```
Auth: isFederationAuthorised (SUDO_FEDERATION_INBOUND_TOKENS)
Handler: delegate to injected ArtifactSigner.getPublicKey()
Response: {ok:true, data:{keyId, keyVersion, algorithm, publicKey, generatedAt, retiring?}}
```
No `SUDO_FED_VERIFY_DISABLE` gate on this endpoint. That kill-switch disables **ingest verification** (my reading of inbound peer events). It has no bearing on whether I should expose my own public key to peers so they can verify my outbound events. The endpoint is bearer-gated only; no additional kill-switch.

**FederationRoutesDeps update**:
```typescript
export interface FederationRoutesDeps {
  peerRegistry: PeerRegistry;
  auditChainSync: AuditChainSync;
  // Wave 10H additions:
  peerKeyFetcher?: PeerKeyFetcher; // undefined → skip verify
  artifactSigner?: ArtifactSigner;  // for /public-key endpoint
}
```

**Verify logic in `handleIngest`** (after existing shape validation, before `auditChainSync.ingestEvent`):

```
if SUDO_FED_VERIFY_DISABLE === '1': skip verify
if deps.peerKeyFetcher is absent: skip verify
if fedEvent.keyId is absent: 
  if SUDO_FED_STRICT_VERIFY === '1': 400 'Signature required'
  else: accept unverified (log warn)
else:
  keyEntry = cache.get(fedEvent.keyId) || fetcher.fetchForKeyId(fedEvent.keyId)
  if keyEntry is null:
    if SUDO_FED_STRICT_VERIFY: 400 'Key unknown'
    else: accept unverified (log warn)
  else:
    verifyResult = verify artifact constructed from fedEvent fields
    if NOT valid:
      evict cache entry, refetch, retry verify once
      if still NOT valid: always reject 400 (signature invalid is hard reject)
    else: accept as verified (log debug with peerName)
```

B3 constructs a synthetic `SignedArtifact` from `FederatedEvent` optional fields, then delegates to the method added by B2:
```typescript
const artifact: SignedArtifact = {
  payload: fedEvent.payload,
  signedAt: fedEvent.signedAt\\!,
  keyId: fedEvent.keyId\\!,
  keyVersion: fedEvent.keyVersion\\!,
  signature: fedEvent.signature\\!,
  artifactType: 'federation_event',
};
const valid = deps.artifactSigner.verifyWithPublicKey(artifact, keyEntry.publicKeyDerHex);
```
B3 does NOT implement raw crypto inline and does NOT call `artifactSigner.verify()` (which looks up keys in the local KeyRotationStore — wrong for peer keys). All signing-input construction lives in signer.ts:110 `buildSignInput()`, consumed transitively via `verifyWithPublicKey()`. B3 has zero crypto primitives to maintain.

### Builder B4 — DI Wiring in cli.ts + E2E Integration Test

**Owns exclusively**:
- `src/cli.ts` (EDIT — wire PeerKeyCache, PeerKeyFetcher, updated AuditChainSync constructor with signer, updated FederationRoutesDeps)
- `tests/federation/e2e-sign-verify.test.ts` (NEW — ~80 lines)

**Does NOT touch**: peer-key-cache.ts, peer-key-fetcher.ts, audit-chain-sync.ts, federation-routes.ts, wave10-types.ts.

**B4 waits on B1+B2+B3 before writing tests** (e2e test imports from all three modules). B4 may start cli.ts wiring in parallel with B2/B3 finishing.

cli.ts wiring (4 additions):
1. `import { PeerKeyCache } from './core/federation/peer-key-cache.js'`
2. `import { PeerKeyFetcher } from './core/federation/peer-key-fetcher.js'`
3. Instantiate: `const peerKeyCache = new PeerKeyCache()` (after env load)
4. Instantiate: `const peerKeyFetcher = new PeerKeyFetcher(peerRegistry, peerKeyCache)` (after peerRegistry)
5. Pass `signer: artifactSigner` to `AuditChainSync` constructor (if `SUDO_FED_SIGN_DISABLE \!== '1'` — conditional via runtime check is fine)
6. Add `peerKeyFetcher` and `artifactSigner` to `FederationRoutesDeps` passed to `registerFederationRoutes`

---

## §9 Test Matrix

Target: **21 new tests** (test IDs shown for QE handoff).

### tests/federation/peer-key-cache.test.ts (Builder B1, 5 tests)

| ID | Description |
|---|---|
| PKC-1 | Cache miss returns undefined on empty cache |
| PKC-2 | Set and get entry within TTL returns entry |
| PKC-3 | Entry past TTL treated as miss (get returns undefined) |
| PKC-4 | Evict removes entry; subsequent get is miss |
| PKC-5 | Size cap at 1000: inserting 1001st evicts 100 oldest by fetchedAt |

### tests/federation/peer-key-fetcher.test.ts (Builder B1, 6 tests)

| ID | Description |
|---|---|
| PKF-1 | fetchForKeyId returns null when no peers configured |
| PKF-2 | fetchForKeyId fan-outs to all peers; first match cached and returned |
| PKF-3 | fetchForKeyId matching via `retiring.keyId` (rotating peer scenario) |
| PKF-4 | fetchForKeyId returns null when all peers return non-matching keyId |
| PKF-5 | `SUDO_FED_KEY_FETCH_DISABLE=1` causes fetchForKeyId to return null immediately |
| PKF-6 | Concurrent fetchForKeyId calls for same keyId coalesce to a single peer round-trip (in-flight de-dup) |

### tests/federation/audit-chain-sign.test.ts (Builder B2, 3 tests)

| ID | Description |
|---|---|
| ACS-1 | publishEvent with signer injected: envelope has keyId+signature fields |
| ACS-2 | publishEvent with `SUDO_FED_SIGN_DISABLE=1`: envelope has no signature fields |
| ACS-3 | publishEvent with no signer injected: envelope has no signature fields (backward compat) |

### tests/gateway/federation-public-key.test.ts (Builder B3, 3 tests)

| ID | Description |
|---|---|
| FPK-1 | GET /v1/federation/public-key without auth returns 401 |
| FPK-2 | GET /v1/federation/public-key with valid federation bearer returns 200 with keyId+publicKey shape |
| FPK-3 | GET /v1/federation/public-key with `SUDO_FED_VERIFY_DISABLE=1` still returns 200 (kill-switch does not gate key export) |

### tests/gateway/federation-ingest-verify.test.ts (Builder B3, 4 tests)

| ID | Description |
|---|---|
| FIV-1 | Ingest unsigned event with no fetcher injected: accepted (backward compat, fail-open) |
| FIV-2 | Ingest unsigned event with `SUDO_FED_STRICT_VERIFY=1` and fetcher injected: 400 rejected |
| FIV-3 | Ingest signed event with valid sig + peer key in fetcher: 200 accepted |
| FIV-4 | Ingest signed event with invalid signature (tampered payload): 400 rejected regardless of fail-open |

### tests/federation/e2e-sign-verify.test.ts (Builder B4, 4 tests)

| ID | Description |
|---|---|
| E2E-1 | Full roundtrip: AuditChainSync signs envelope; ingest handler fetches key and verifies; 200 returned |
| E2E-2 | Post-rotation: fetcher gets rotating key's `retiring.keyId`, verifies older artifact; accepted |
| E2E-3 | `SUDO_FED_VERIFY_DISABLE=1`: ingest accepts unsigned without fetching any peer key |
| E2E-4 | Backward-compat: legacy unsigned FederatedEvent (no keyId field) accepted with fail-open default |

---

## §10 Backward-Compat Acceptance Criteria

The following conditions MUST hold after Wave 10H deploy:

1. **All existing 3555 tests continue to pass** — zero regression on current suite.
2. **Prod with SUDO_FEDERATION_PEERS unset**: `publishEvent` sends unsigned envelopes (no signer in AuditChainSync constructor call, or `SUDO_FED_SIGN_DISABLE=1` default). Ingest handler skips verify (no `peerKeyFetcher`). Net: zero behavior change from today.
3. **Existing `/v1/federation/audit/ingest` consumers** sending unsigned `FederatedEvent` envelopes continue to receive `200 {ok:true}` — `keyId` field absent → fail-open accept path.
4. **Wave 10G SignedArtifact shape unchanged** — `wave10-types.ts` modification is additive only (add `'federation_event'` to `artifactType` union). No field removal or type narrowing.
5. **`/v1/admin/public-key` unchanged** — existing admin-routes.ts handler not modified; still returns same shape; still requires GATEWAY_TOKEN.
6. **`/v1/federation/public-key` (new) uses federation bearer** — operators with only `SUDO_FEDERATION_INBOUND_TOKENS` can access it; operators with no inbound tokens get 401; no GATEWAY_TOKEN needed for peer-to-peer key exchange.
7. **`FederatedEvent` optional fields are backward-compat** in SQLite storage: `federation_inbound_audit.payload` stores `JSON.stringify(event.payload)` (existing field), signature metadata is carried in the envelope JSON body only, not stored as separate DB columns. Parsing old rows (no keyId field) does not throw.
8. **`ArtifactSigner.verify()` signature unchanged** — existing callers of `sign()` and `verify()` require zero changes. `verifyWithPublicKey(artifact, publicKeyDerHex)` is additive only; it reuses `buildSignInput()` at signer.ts:110 and does not alter the local-key verification path.

---

## Data Models Summary

### `FederatedEvent` (EDIT in audit-chain-sync.ts — additive only)

```typescript
export interface FederatedEvent {
  id: string;
  instanceId: string;
  eventType: string;
  payload: unknown;
  ts: number;
  seq: number;
  // Wave 10H — optional signature fields:
  keyId?: string;
  keyVersion?: number;
  signature?: string;
  signedAt?: string;
}
```

### `wave10-types.ts` — only change (B2 owns)

```typescript
// artifactType union: add 'federation_event'
artifactType: 'skill' | 'bench_report' | 'config_proposal' | 'trace_pattern' | 'federation_event' | 'generic';
```

### No new SQLite tables

Cache is in-memory only. `federation_inbound_audit` table is unchanged.

---

## Dependencies and Wave Order

```
B1 (cache+fetcher)  ─────────────────────────┐
B2 (audit-chain-sync sign + wave10-types) ───┤──→ B4 (cli.ts + e2e test)
B3 (federation-routes verify + endpoint) ────┘
```

B1, B2, B3 run in parallel. B4 waits on all three (e2e test imports all new modules). B2 must commit its `wave10-types.ts` change early so B3 can import `'federation_event'` without a merge conflict — B2 publishes the type edit as its first deliverable.

---

## Files Touched — Complete List

**New files**:
- `src/core/federation/peer-key-cache.ts`
- `src/core/federation/peer-key-fetcher.ts`
- `tests/federation/peer-key-cache.test.ts`
- `tests/federation/peer-key-fetcher.test.ts`
- `tests/federation/audit-chain-sign.test.ts`
- `tests/gateway/federation-public-key.test.ts`
- `tests/gateway/federation-ingest-verify.test.ts`
- `tests/federation/e2e-sign-verify.test.ts`
- `docs/wave10h-spec.md`

**Modified files**:
- `src/core/shared/wave10-types.ts` (B2: add `'federation_event'` to union — 1 line)
- `src/core/federation/audit-chain-sync.ts` (B2: FederatedEvent interface + optional signer constructor param + sign in publishEvent)
- `src/core/security/signer.ts` (B2: add `verifyWithPublicKey()` public method — additive only)
- `src/core/gateway/federation-routes.ts` (B3: new endpoint handler + verify in handleIngest + deps interface update)
- `src/cli.ts` (B4: DI wiring for PeerKeyCache + PeerKeyFetcher + pass to AuditChainSync + FederationRoutesDeps)

**Total new test count target**: 21  
**No new npm dependencies**: native crypto, native fetch, existing better-sqlite3, existing vitest — zero additions.
