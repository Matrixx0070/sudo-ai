# Drive/NotebookLM deep security audit — 2026-07-28 (Fable, two parallel read-only audits)

Scope: full `src/core/gdrive/` + `src/core/notebooklm/` egress and ingress paths, audited against the
prime directives (zones, quarantine-always, hot-path ban, frozen surfaces, memory-API-only, F19/F67).
Method: independent egress + ingress explorers, file:line evidence throughout. No code changed.

## Headline

The setup is **two systems wearing one name**. The *brain* lanes (checkpoint push/restore, NotebookLM
export lane, inbox ingestion) are built to the invariant bar and test-pinned. The *ops* lanes
(comments, second-opinion, reports, blackboard, deep-freeze recall, ~15 upload surfaces) were built to
a visibly lower bar and are now the real attack surface: **an adversary with write access to the Drive
folder owns the ops lanes** — they can inject a directive-weight memory via a Doc comment, plant a
dissent memo that reaches the decider uninspected, or serve a tampered deep-freeze blob.

## Findings (prioritized)

### P0 — fix before the next prod enablement review
1. **F6 comments ingestion is an injection front door** (`comments.ts:122-149`): comment text becomes a
   HIGH-PRIORITY corrective memory with only the deterministic scorer — no `inspectContent`, no LLM
   reader, **no hold path** (flagged content is stored anyway with a "guard note"), no canary check.
   Compounded by principal spoofing: an **empty author email is accepted as the principal**
   (`comments.ts:113-114`). Repair: full `quarantineAndInspect` + hold + canary + reject empty-email
   principal match.
2. **Second-opinion dissent round-trip** (`second-opinion.ts:121`, seam at `cli.ts:3406-3425`): the
   raw memo downloaded from `ops/review-queue/` reaches the deciding agent's context with no
   inspection and no canary check. Repair: inspectContent + canary before return; hold → surface to
   human like inbox holds.

### P1 — egress screening + integrity
3. **~15 unscreened plaintext upload paths** (worst: `second-opinion.ts:60,86,160` decision packets,
   `report.ts:116-120` nightly Doc; also blackboard, case-law, forks, heartbeat, skill-registry,
   dream agenda, dead-ends, releases, curiosity). None run `classifyZone` or the secrets regex. The
   NotebookLM lane screens exactly this class of content (`assertZone2`); the ops lane should reuse it.
   Repair: one shared `screenOpsUpload(text)` (assertZone2 or redactSecrets) at the upload helper.
4. **F43 incident timeline/config docs are unredacted** (`packs.ts:76-91`): transcript doc is
   redacted+audited, but timeline/config docs built from the same events (`safeStr(e).slice(0,200)`)
   skip redaction, and the leak test only covers the transcript. Repair: redact all three + extend
   `n1.test.ts` seeded-secret test.
5. **Deep-freeze recall serves unverified bytes** (`deep-freeze.ts:174-201`): no sha256 re-check
   against the stub id, no inspection, no canary. Repair: re-hash against `stub.id` (content-addressed
   names make this one line) + inspectContent on recall.
6. **Zone enforcement is label-based and fail-open** (`zones.ts:76-81`, `blob-store.ts:119-157`):
   default zone for unmatched content is 2 (plaintext); classification runs at snapshot time and the
   push layer trusts the label — no re-classification at the egress point; `classifyZone(text, 2)`
   explicit override wins unconditionally; sidecars/skills hardcoded zone-2. Repair: re-run
   `classifyZone` in `prepareBlobs` as belt-and-suspenders (take the more restrictive of label vs
   fresh classification), and add the LLM second reader on borderline zone-2 exports (fail to zone-1
   treatment on hold).

### P2 — coverage + provability
7. **F19 canary/pause coverage is partial**: `checkCanaryPayload` runs only in inbox + the F67 NLM
   route; absent from mirror, comments, F5 reads, curiosity, deep-freeze, second-opinion, NLM default
   route. `isGdrivePaused` doesn't halt mirror/comments/checkpoint/changes/blackboard — a tripped
   canary pauses ingestion but other Drive I/O continues. Repair: canary check in the shared download
   helper; pause check in every job entry.
8. **Egress provability is partial**: per-blob zone not recorded in audit rows (only inferable from
   `.enc` suffix); the ops-surface uploads mostly bypass the tamper-evident AuditTrail (log.info
   only); audit emit is fail-open. Repair: zone field on every audited upload + route ops uploads
   through `auditedJob`.
9. **F5 user-file reads use the weakest scanner on the most direct channel** (`user-files.ts:129` —
   repo `detectInjection` only, straight into model context; flagged content still returned in full).
   Documented exception, but the asymmetry is backwards. Repair: upgrade to inspectContent
   (deterministic layer at minimum), keep returning held verdicts as refusals with the report path.

### P3 — hygiene
10. Hot-path ban doesn't cover `src/core/tools`/`src/core/channels` (the F5 tool import is deliberate
    but unratcheted), and the `/gdrive\//` regex misses barrel imports without a trailing slash.
11. `index-snapshot.ts:64` direct sqlite write (embedding cache; mitigated by HMAC+keys; low).
12. No cross-fire circuit breaker on permanently failing sync jobs (noisy, bounded, non-blocking).
13. `keys.ts` minor: `subarray(0,32)` silently truncates long keys; perms check fail-open on exotic fs.

## What is genuinely SOLID (verified, not assumed)
- Crypto: hardcoded AES-256-GCM, random 12-byte IV per message, tag verified, versioned wire format,
  0600 key file outside the repo, missing key fails fast (`zones.ts:30-51`, `keys.ts:38-80`; pinned in
  `tests/gdrive/zones.test.ts`, `keys.test.ts`).
- Brain push/restore: zone-0 filtered + zone-1 `.enc` + HMAC-signed manifest; forged manifests refused
  on hydrate (`blob-store.test.ts:117-213`).
- NotebookLM export lane: `assertZone2` as the final gate on every doc + per-shape pre-screens + the
  no-zone1-export test pin.
- Quarantine core design: det+LLM `max()` scoring so the LLM can only raise risk; inspector output
  itself re-scored; holds quarantined-stored and human-surfaced; LLM reader wired in prod
  (`cli.ts:4252`).
- Flags: default OFF, no plaintext-override env lever exists.
- Frozen surfaces: read-only via manifest; Sheet cannot write frozen keys; canary unpause is
  operator-only.
- Hot-path core: agent/llm/memory/brain ban enforced twice (dedicated + architecture test), dynamic
  imports included; sync failures never block the loop.

## Repair status (2026-07-28, follow-up PRs)

- P0 (items 1-2): PR #962 (merged).
- P1 (items 3-6): PR #964 — shared `screenOpsUpload` at all ops upload lanes (signed
  manifest bodies exempt from mutation, documented in `ops-screen.ts`), F43 timeline/config
  redaction, deep-freeze re-hash + canary + inspection on recall, `prepareBlobs` zone
  re-classification (more restrictive wins).
- P2 (items 7-9): PR #966 — canary in mirror/curiosity/NLM-default-return lanes, pause gates
  at mirror/comments/changes/blackboard/checkpoint entries, per-blob zone in checkpoint audit
  rows + ops-screen audit seam, F5 reads upgraded to full deterministic `inspectContent`
  with a refusal on hold.
- P3 (items 10, 13): PR (this one) — import-ban regexes catch barrel imports (tools/channels
  exemption documented, F5 import is deliberate); `keys.ts` rejects >32-byte keys instead of
  silently truncating.
- Item 11 (index-snapshot direct sqlite write): accepted as-is per the audit's own "low"
  rating (mitigated by HMAC+keys); no change.
- Item 12 (consecutive-failure circuit breaker on sync jobs): **DEFERRED** — a cross-job
  failure counter needs shared state + alert routing that doesn't exist yet; the failure mode
  is noisy-but-bounded (per-call backoff in `backoff.ts` already caps retry pressure, and
  failures land in audit rows + the daily report's "What failed" section). Revisit if a sync
  job is ever observed hot-looping.

## Decision (as reviewed by Fable, delegated authority — assessment only, no code changed)
Architecture: APPROVED. Implementation: **conditional** — the P0 pair should land before the next
deliberate re-enable ceremony of `SUDO_GDRIVE` on a box whose Drive folder is shared or reachable by
any third party. Repairs belong Drive-side per the gap-repair protocol (never reimplemented in annex
code). Ownership note: the gdrive-owning session should review this doc; findings are evidence-cited
and reproducible.
