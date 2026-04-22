# Wave 10H — Scout Briefing

**Target scope (from Wave 10G backlog):** Federation peer public-key auto-fetch. Peer-side discovery so peers can verify signed artifacts from rotated instances. Design hinted at "lazy pull on unknown keyId via `GET <peer>/v1/admin/public-key` with TTL cache."

## Current state (2026-04-20 after Wave 10G deploy)
- prod sudo-ai-v5 online PID 2172869 :18900
- stage sudo-ai-v5-staging online PID 1995730 :18901 (UNTOUCHED — 48h seal soak)
- tests 3555/0/3 (post Wave 10G +15)
- ed25519 keys at data/keys/wave10-signer-v1.{pub,priv}; `key_rotation_log` SQLite table seeded with v1 row
- `GET /v1/admin/public-key` returns `{keyId, keyVersion, algorithm, publicKey, generatedAt, retiring?}` (Bearer GATEWAY_TOKEN gated)
- `POST /v1/admin/key/rotate` Bearer gated, idempotent 60s, kill-switches SUDO_KEY_ROTATION_DISABLE + SUDO_DUAL_VERIFY_DISABLE

## Federation modules (relevant files, no-touch-without-architect)
- `src/core/federation/peer-registry.ts` — PeerConfig + CSV loader from SUDO_FEDERATION_PEERS
- `src/core/federation/audit-chain-sync.ts` — outbound publish + `listPeers()`, FETCH_TIMEOUT_MS=3000 precedent
- `src/core/gateway/federation-routes.ts` — 4 `/v1/federation` endpoints; `:157` is ingest path
- `src/core/security/signer.ts` — `verify(artifact)` method; `getPublicKey()` returns active + optional retiring
- `src/core/security/key-rotation-store.ts` — KeyRotationStore SQLite methods
- `src/core/shared/wave10-types.ts` — SignedArtifact shape (`keyId`, `keyVersion`, plus other fields)
- `src/core/gateway/admin-routes.ts` — handlePublicKeyGet (Bearer auth)

## PeerConfig shape (peer-registry.ts:24)
```typescript
interface PeerConfig {
  name: string;
  url: string;
  token: string;  // outbound federation bearer — NOT GATEWAY_TOKEN admin bearer
}
```

## verify() call site audit (CRITICAL scope-expansion finding)
Grep across src/ for `signer.verify` / `artifactSigner.verify`:
- `src/core/security/signer.ts:343` — test-only self-reference in JSDoc example
- Federation ingest path `src/core/gateway/federation-routes.ts:~157` accepts signed artifacts — but has NO verify call today
- Wave 10E sign sites: `learning-routes.ts` handleApprove (config_proposal) + `admin-routes.ts` handleSkillOptimizationApprove (skill)

**Implication:** Today, `verify()` is called NOWHERE in production code paths. Wave 10E only SIGNS at local REST approvals (for config_proposal + skill), not on federation publish. So the original Wave 10H scope ("auto-fetch peer keys") builds infrastructure for a consumer that doesn't exist yet.

## 8 open questions for architect (do not answer in briefing — decide in spec §1)

1. **Ingest-path wiring**: Does Wave 10H add `verify()` call at federation-routes ingest, or only ship fetcher infrastructure?
2. **Outbound sign wiring**: Does Wave 10H sign at federation publish (audit-chain-sync push), or leave publish unsigned?
3. **Cache storage**: In-memory Map (simple, lost on restart) or new SQLite `peer_public_keys` table (persistent)?
4. **Cache invalidation**: TTL only (simple) vs TTL + on-verify-failure refresh (more moving parts)?
5. **Peer-fetch auth**: New `/v1/federation/public-key` public endpoint, widen `/v1/admin/public-key` to accept federation bearer, or add `adminToken` to PeerConfig?
6. **Peer identity resolution**: SignedArtifact only carries `{keyId, keyVersion}` — NO instanceId/peerName. Options: (a) broadcast-fetch from all peers on unknown keyId, (b) add instanceId to SignedArtifact (BREAKS Wave 10G response shape), (c) reverse `keyId → peerUrl` cache built on observed keyIds per peer.
7. **503/unavailable handling**: If peer returns 503/timeout, fail-open (accept unsigned) or fail-closed (reject artifact)?
8. **TOFU vs pinned-key trust**: Cache whatever peer returns (TOFU), or require config-file pinning of expected keyIds per peer (stricter)?

## Scope decision for architect §1 (enumerate options, don't pre-decide)

- **Option A (infra-only)**: Ship fetcher + cache + `/v1/federation/public-key` endpoint. Defer verify() wiring to Wave 10I. **Pro:** small surface, fast. **Con:** infrastructure for no consumer today; may need rework when real verify wires in.
- **Option B (end-to-end)**: Fetcher + cache + sign-outbound (federation publish) + verify-inbound (federation ingest) with backward-compat (accept unsigned artifacts during transition). **Pro:** complete loop. **Con:** larger spec, 4+ builders minimum, risk of breaking 10G shape.
- **Option C (split)**: Wave 10H = fetcher + cache + endpoint. Wave 10I = sign-outbound + verify-inbound wiring. **Pro:** discrete risk per wave. **Con:** 2 waves of memory churn.

## Kill-switches (existing, for reference — architect should specify NEW ones in spec §7)
- `SUDO_FEDERATION_PEERS` (CSV list) — already active, default unset
- `SUDO_SIGNING_DISABLE=1` — disables ArtifactSigner.sign at REST approve
- `SUDO_DUAL_VERIFY_DISABLE=1` — disables retiring-key verify path
- `SUDO_KEY_ROTATION_DISABLE=1` — disables POST /v1/admin/key/rotate
- `SUDO_SIGNER_KEY_DIR` — override keypair directory
- `SUDO_KEY_ROTATION_DB_PATH` — override key_rotation_log SQLite path

## Test harness precedents (architect: follow these)
- `tests/security/signer-integration.test.ts` — INT-S* pattern for signing roundtrip
- `tests/gateway/admin-public-key.test.ts` — PK-* pattern for endpoint shape/auth
- `tests/security/key-rotation.test.ts` — KR-* pattern with isolated SQLite tmp path via env override
- Fetch mocking via `vi.stubGlobal('fetch', ...)` — audit-chain-sync.test.ts precedent

## Budget constraints
- architect: <15min single-pass spec, <400 lines
- builders: up to 4 parallel, each <45min
- no architect/builder retry loops — if spec is wrong, lead rejects at step 2 and restarts

## Non-goals (explicit)
- **No key-rotation trigger changes** (Wave 10G just shipped, rotation path stable)
- **No change to `SignedArtifact` shape** unless architect chooses Option 6b and explicitly documents the compat migration
- **No staging pm2 reload** — staging soak (clock T+~10h of 48h) must remain undisturbed; deploy target is prod ONLY
- **No new framework deps** — native fetch, existing better-sqlite3, existing vitest
