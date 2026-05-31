# Wave 12 Spec — agentskills.io Publish-Registry

**Status:** BINDING — approved for implementation
**Date:** 2026-04-17
**Baseline tests:** 3049 (Wave 11 close)
**Target tests:** 3057+ (3049 + 8 new)
**npm dep changes:** ZERO
**Time target:** 1–2 days, single-pass, 2 parallel builders

---

## A. Executive Summary

Wave 12 makes SUDO-AI a first-class **producer** in the agentskills.io ecosystem — the missing leg of the standard-compliance play started in Wave 10. Three deliverables: (1) migrate the 5 bundled SKILL.md files from proprietary bold-header format to canonical agentskills.io YAML frontmatter, (2) add `sudo:` to `SCHEME_BASE_URLS` in `importer.ts` so any agent can pull SUDO-AI skills via URI, and (3) expose a public no-auth GET `/v1/registry/skills` endpoint family backed by the existing `SkillRegistry`.

Gate chain: B1 (SKILL.md migration + importer.ts) PARALLEL B2 (registry-routes.ts + cli.ts wiring) → Integrator (tsc --noEmit) → Security (APPROVED required) → Quality (8 new tests, 3057+ total) → Perf → Advocate → Rollback → DevOps.

The `sudo:` scheme requires `SUDO_PUBLIC_REGISTRY_BASE` env var; if unset the scheme is silently absent (no localhost fallback — production safety). npm deps: none added.

---

## B. Item Inventory Table

| # | Item | Builder | Files Owned |
|---|------|---------|-------------|
| B1-1 | Migrate 5 bundled SKILL.md to canonical YAML frontmatter | B1 | `/root/sudo-ai-v4/src/core/skills/research/web-summary/SKILL.md` |
| B1-2 | same | B1 | `/root/sudo-ai-v4/src/core/skills/automation/cron-health/SKILL.md` |
| B1-3 | same | B1 | `/root/sudo-ai-v4/src/core/skills/system/self-diagnostic/SKILL.md` |
| B1-4 | same | B1 | `/root/sudo-ai-v4/src/core/skills/intelligence/daily-brief/SKILL.md` |
| B1-5 | same | B1 | `/root/sudo-ai-v4/src/core/skills/content/viral-hook/SKILL.md` |
| B1-6 | Add `sudo:` entry to SCHEME_BASE_URLS | B1 | `/root/sudo-ai-v4/src/core/skills/importer.ts` |
| B2-1 | Public registry routes | B2 | `/root/sudo-ai-v4/src/core/skills/registry-routes.ts` (NEW) |
| B2-2 | Wire into bootstrap | B2 | `/root/sudo-ai-v4/src/cli.ts` (single 3-line block only — see §E) |
| B2-3 | Wave 12 types extension | B2 | `/root/sudo-ai-v4/src/core/skills/registry-route-types.ts` (NEW) |
| QE | 8 new tests | QE | `/root/sudo-ai-v4/tests/skills/wave12-registry.test.ts` (NEW) |

**READ-ONLY in Wave 12 (no modifications):**
- `/root/sudo-ai-v4/src/core/skills/registry.ts`
- `/root/sudo-ai-v4/src/core/skills/registry-types.ts`
- `/root/sudo-ai-v4/src/core/skills/markdown-loader.ts`

Note: `wave10-types.ts` is owned by B1 for a single-line union extension (`'sudo'` added to `SkillSourceScheme`). It is read-only for B2.

---

## C. Architecture Decisions (BINDING)

### C1: Canonical YAML Frontmatter Schema for SKILL.md

All 5 bundled SKILL.md files MUST be rewritten to use YAML frontmatter using the OpenJarvis-observed canonical schema. The body content (description section, input/output schemas, examples, notes) is **preserved unchanged** below the closing `---`.

#### Required fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Lowercase, dot-separated, e.g. `research.web-summary`. MUST match the tool registry key. |
| `name` | string | Human-readable, e.g. `Web Summary`. |
| `version` | string | Semver, e.g. `1.0.0`. |
| `description` | string | One-line summary. Max 120 chars. |
| `author` | string | Fixed: `sudo-ai` for all bundled skills. |
| `trust_tier` | string | Fixed: `bundled` for all bundled skills. |
| `caps` | string (bracket array) | Capability list, e.g. `[net.fetch]`. Empty: `[]`. |

#### Optional fields (include when applicable)

| Field | Type | Notes |
|-------|------|-------|
| `tags` | string (bracket array) | e.g. `[research, web, no-llm]`. |
| `source` | string | Fixed: `bundled:sudo-ai` for bundled skills. |
| `minVersion` | string | Min SUDO-AI version required. Omit unless > 10.0. |
| `tools` | string (JSON array) | Tool translation table, JSON-encoded on one line. Omit if empty. |

#### Verbatim frontmatter template (copy-paste base for each file)

```yaml
---
id: category.skill-name
name: Human Readable Name
version: 1.0.0
description: One-line description of what this skill does (max 120 chars).
author: sudo-ai
trust_tier: bundled
caps: [cap.one, cap.two]
tags: [tag1, tag2]
source: bundled:sudo-ai
---
```

#### Per-skill canonical frontmatter (exact values B1 MUST use)

**research.web-summary**
```yaml
---
id: research.web-summary
name: Web Summary
version: 1.0.0
description: Search the web via DuckDuckGo and return structured summary with key facts and source URLs.
author: sudo-ai
trust_tier: bundled
caps: [net.fetch]
tags: [research, web, no-llm]
source: bundled:sudo-ai
---
```

**automation.cron-health**
```yaml
---
id: automation.cron-health
name: Cron Health
version: 1.0.0
description: Check all registered cron jobs and report healthy vs failing/overdue status.
author: sudo-ai
trust_tier: bundled
caps: [fs.read, db.read]
tags: [automation, monitoring, local]
source: bundled:sudo-ai
---
```

**system.self-diagnostic**
```yaml
---
id: system.self-diagnostic
name: Self Diagnostic
version: 1.0.0
description: Run comprehensive SUDO-AI platform health diagnostic across six local subsystems.
author: sudo-ai
trust_tier: bundled
caps: [fs.read, db.read]
tags: [system, health, local]
source: bundled:sudo-ai
---
```

**intelligence.daily-brief**
```yaml
---
id: intelligence.daily-brief
name: Daily Brief
version: 1.0.0
description: Generate structured daily briefing from Hacker News, GitHub Trending, and mind.db.
author: sudo-ai
trust_tier: bundled
caps: [net.fetch, db.read]
tags: [intelligence, briefing, daily]
source: bundled:sudo-ai
---
```

**content.viral-hook**
```yaml
---
id: content.viral-hook
name: Viral Hook
version: 1.0.0
description: Generate viral YouTube Shorts hook lines in curiosity/shock/challenge styles.
author: sudo-ai
trust_tier: bundled
caps: []
tags: [content, youtube, no-llm, no-network]
source: bundled:sudo-ai
---
```

---

### C2: GET /v1/registry/skills Response Shape

This is a **public, no-auth** endpoint. The response surfaces only the frontmatter subset. Internal scoring, body content, and session data are WITHHELD.

#### PUBLIC fields (exposed in list + detail responses)

```typescript
interface PublicSkillEntry {
  id: string;               // from frontmatter field `id`
  name: string;             // from frontmatter field `name`
  version: string;          // from frontmatter field `version`
  description: string;      // from frontmatter field `description`
  author: string;           // from frontmatter field `author`
  trust_tier: string;       // always "bundled" for public-facing entries
  caps: string[];           // from frontmatter field `caps`
  tags: string[];           // from frontmatter field `tags` (empty array if absent)
  source: string;           // from frontmatter field `source`
  sha256: string;           // contentHash from SkillMeta.sha256 (external name)
  importedAt: string;       // SkillMeta.created_at mapped to ISO-8601
}
```

#### GET /v1/registry/skills — list response

```json
{
  "data": [ /* PublicSkillEntry[] */ ],
  "total": 5,
  "limit": 50,
  "offset": 0
}
```

Pagination: `limit` (1–200, default 50) and `offset` (default 0) query params. Same clamping as `routes.ts:GET /v1/skills`.

#### GET /v1/registry/skills/:id — single entry response

Returns a single `PublicSkillEntry` object directly (not wrapped in `data`).
Returns 404 if id not found OR if the skill's trust_tier is not `bundled` (trust-tier filter — do not leak existence).

#### WITHHELD (never in any public response)

- `body_md` (raw markdown body — use `/raw` endpoint)
- `frontmatter_json` (raw JSON blob — superset of what's exposed)
- `archived_at` (internal lifecycle field)
- Brier/calibration/alignment scores
- `session_skills` attachment records
- Any internal registry row id (the `id` column in SQLite; expose frontmatter `id` only)

---

### C3: GET /v1/registry/skills/:id/raw Security Model

This endpoint returns the raw SKILL.md content (frontmatter + body) for a single skill.

**Trust-tier gate:** Only skills with `trust_tier = 'bundled'` are served. Any other tier (indexed, unreviewed, workspace) returns **404** — not 403. Do not leak existence of non-bundled skills to unauthenticated callers.

**Size cap:** Response body capped at **256 KB** (matches `MAX_RESPONSE_BYTES` constant in `importer.ts`). If `body_md` (including frontmatter reconstruction) exceeds 256 KB, return 413 with message `"Skill content exceeds size limit"`. In practice bundled skills are ~2–3 KB each; this gate is defensive.

**Rate limiting:** Sliding-window, per-IP (no auth on this endpoint), **20 req/min/IP**. Same window-eviction pattern as `routes.ts:checkImportRateLimit`. Return 429 with `Retry-After` header on violation. List endpoint: **60 req/min/IP**.

**CORS:** All three public endpoints (`/v1/registry/skills`, `/v1/registry/skills/:id`, `/v1/registry/skills/:id/raw`) MUST include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```
Handle `OPTIONS` preflight with 204 response.

**ETag caching:** `/v1/registry/skills/:id/raw` MUST include:
```
ETag: "sha256:<contentHash>"
```
Where `contentHash` is the skill's `sha256` field. If the request includes `If-None-Match` with a matching value, return 304 with no body.

**404 on missing:** `/v1/registry/skills/:id` and `/v1/registry/skills/:id/raw` MUST return 404 (not 400) for unknown ids.

**No-auth is intentional:** These are intentionally public. No `Authorization` header is checked. The intent is agentskills.io ecosystem discoverability.

---

### C4: `sudo:` SCHEME_BASE_URLS Entry

The `sudo:` scheme in `importer.ts:SCHEME_BASE_URLS` maps URIs of the form `sudo:skill-id` to `GET /v1/registry/skills/:id/raw` on the **public registry host**.

**Configuration source:**
- Read from env var `SUDO_PUBLIC_REGISTRY_BASE` at module load time.
- If unset or empty → the `sudo:` key is **NOT added** to `SCHEME_BASE_URLS`. Any `parseSkillUri("sudo:...")` call will throw `"Unsupported skill URI scheme: sudo"`. This is correct and intentional — prevents silent localhost resolution in production deployments that omit the env var.

**Validation of `SUDO_PUBLIC_REGISTRY_BASE` when set:**
1. Must start with `https://` (rejects `http://` for plain-text transport).
2. Must parse cleanly as a `URL`.
3. Hostname must NOT match any private/loopback range:
   - `localhost`, `127.x.x.x`, `::1`
   - `10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`, `169.254.x.x` (link-local)
4. If validation fails → log a `warn` with `createLogger('skills:importer')` and skip the `sudo:` entry (fail-open: startup continues, `sudo:` scheme simply unsupported).

**Resulting SCHEME_BASE_URLS entry (when valid):**
```typescript
// Dynamically added at module init — not a compile-time literal
sudo: `${process.env['SUDO_PUBLIC_REGISTRY_BASE']}/v1/registry/skills`,
```

The `buildFetchUrl` function appends `/${parsed.path}` → final URL is:
`${SUDO_PUBLIC_REGISTRY_BASE}/v1/registry/skills/<skill-id>/raw`

**SkillSourceScheme type extension:** B1 must add `'sudo'` to the `SkillSourceScheme` union in `wave10-types.ts`:
```typescript
export type SkillSourceScheme = 'github' | 'openclaw' | 'openjarvis' | 'local' | 'bundled' | 'sudo';
```
NOTE: `wave10-types.ts` is read-only for B2 but B1 owns the `importer.ts` change; the `wave10-types.ts` type extension is B1's responsibility as part of the importer.ts work.

**Scope bound:** B1 adds ONE entry to `SCHEME_BASE_URLS` and the type union. There is NO new resolver class, no new fetch path — existing `fetchSkillContent` handles the request. B2 must not touch `importer.ts`.

---

## D. File Ownership Matrix

**B1 owns exclusively:**

| File | Action |
|------|--------|
| `/root/sudo-ai-v4/src/core/skills/research/web-summary/SKILL.md` | Rewrite (add YAML frontmatter, preserve body) |
| `/root/sudo-ai-v4/src/core/skills/automation/cron-health/SKILL.md` | Rewrite |
| `/root/sudo-ai-v4/src/core/skills/system/self-diagnostic/SKILL.md` | Rewrite |
| `/root/sudo-ai-v4/src/core/skills/intelligence/daily-brief/SKILL.md` | Rewrite |
| `/root/sudo-ai-v4/src/core/skills/content/viral-hook/SKILL.md` | Rewrite |
| `/root/sudo-ai-v4/src/core/skills/importer.ts` | Add `sudo:` entry + hostname validation block |
| `/root/sudo-ai-v4/src/core/shared/wave10-types.ts` | Add `'sudo'` to `SkillSourceScheme` union only |

**B2 owns exclusively:**

| File | Action |
|------|--------|
| `/root/sudo-ai-v4/src/core/skills/registry-routes.ts` | CREATE — public registry route handler |
| `/root/sudo-ai-v4/src/core/skills/registry-route-types.ts` | CREATE — `PublicSkillEntry` type + `RegistryRoutesConfig` |
| `/root/sudo-ai-v4/src/cli.ts` | 3-line block: `registerRegistryRoutes(gatewayServer, skillRegistry)` immediately after the existing `registerSkillRoutes` call at line 1856 |
| `/root/sudo-ai-v4/src/core/skills/index.ts` | ADD one line: `export { registerRegistryRoutes } from './registry-routes.js';` |

**QE owns exclusively:**

| File | Action |
|------|--------|
| `/root/sudo-ai-v4/tests/skills/wave12-registry.test.ts` | CREATE — 8 new tests |

**Zero-overlap guarantee:** B1 does not touch `registry-routes.ts` or `cli.ts`. B2 does not touch any `SKILL.md` file or `importer.ts`. B1's touch on `wave10-types.ts` is a one-line union extension that B2 reads but does not write.

---

## E. Interface Contracts

### E1: `registerRegistryRoutes` (B2 entry point)

```typescript
// registry-routes.ts
export function registerRegistryRoutes(
  server: HttpServer,       // same node:http Server passed to registerSkillRoutes
  registry: SkillRegistry,  // same SkillRegistry instance, no duplication
): void
```

**No new SkillRegistry instance.** B2 receives the existing `skillRegistry` from cli.ts — the same object already initialized at line 1854. B2 MUST NOT call `new SkillRegistry(...)`.

### E2: cli.ts wiring block (exact 3 lines B2 adds)

```typescript
// Immediately after line 1856 (registerSkillRoutes call):
const { registerRegistryRoutes } = await import('./core/skills/registry-routes.js');
registerRegistryRoutes(gatewayServer, skillRegistry);
log.info('Public skill registry attached (/v1/registry/skills)');
```

Use dynamic import to match the existing lazy-import pattern used elsewhere in cli.ts.

### E3: `SkillRegistry` methods B2 MAY call (read-only)

B2 MUST NOT add methods to `registry.ts`. Use only existing API:

```typescript
registry.list(limit: number, offset: number): SkillMeta[]
registry.getSkillById(id: string): SkillFull | null
```

The trust_tier filter is applied IN the route handler after calling `registry.list()` / `getSkillById()`. Filter logic: include only entries where `frontmatter.trust_tier === 'bundled'`.

### E4: `PublicSkillEntry` (registry-route-types.ts)

```typescript
// registry-route-types.ts
export interface PublicSkillEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  trust_tier: 'bundled';   // narrowed — only bundled ever appears in public responses
  caps: string[];
  tags: string[];
  source: string;
  sha256: string;           // mapped from SkillMeta.sha256
  importedAt: string;       // mapped from SkillMeta.created_at
}

export interface RegistryRoutesConfig {
  // future: optional auth tokens for private registry modes
  // currently empty — all fields reserved
}
```

### E5: Rate limiter shape (reuse pattern from routes.ts)

B2 MUST implement two independent rate limiters using the **same sliding-window pattern** as `routes.ts:checkImportRateLimit`. Key by `ip:${req.socket.remoteAddress}` (no Bearer token on public endpoints — keying by token would require auth).

```typescript
const REGISTRY_LIST_RL:  { windowMs: 60_000, max: 60 }
const REGISTRY_RAW_RL:   { windowMs: 60_000, max: 20 }
```

### E6: SKILL.md body preservation contract (B1)

Each SKILL.md MUST be rewritten as:
```
---
<exact canonical frontmatter per §C1>
---
<original body content, starting from ## Description, preserved verbatim>
```

The heading `# category.skill-name` at line 1 of the current files is REMOVED (the name is now in frontmatter). The body begins with `## Description`.

---

## F. Risks + Threats

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| F1 | Data exposure — public `/v1/registry/skills` leaks capability inventory (caps, tags) to adversary profiling attack surface | MEDIUM | Public exposure is intentional and value-generating (ecosystem); `body_md` kept off list response; only bundled skills visible; cap list does not reveal internal secrets |
| F2 | Data exposure — `/v1/registry/skills/:id/raw` exposes full skill body including implementation notes to adversaries who can study SUDO-AI internals | LOW | Bundled skills contain no credentials or secrets; implementation notes are public-level information; 256 KB cap prevents bulk exfiltration |
| F3 | SSRF via `SUDO_PUBLIC_REGISTRY_BASE` misconfiguration — operator sets env var to internal service | HIGH | Mitigated by C4 hostname validation: reject RFC-1918 + loopback addresses at startup; log warn and skip `sudo:` entry entirely if invalid |
| F4 | Trust-tier confusion — non-bundled skill inadvertently served publicly | HIGH | Filter applied in route handler post-query; return 404 (not 403) to avoid leaking existence; test case T5 verifies this |
| F5 | Rate limit bypass — distributed IPs exhaust `/raw` endpoint | LOW | 20 req/min/IP is per-IP not global; no aggregate limit needed at current scale; note for future: add global concurrency cap if federation scales |
| F6 | SKILL.md migration breaks existing tests that snapshot `frontmatter: {}` | MEDIUM | B1 MUST grep `/root/sudo-ai-v4/tests/skills/` for `frontmatter.*{}` before modifying any file; update any assertions that assume empty frontmatter |
| F7 | `sudo:` scheme registered for `local` use pointing at `localhost:18900` in dev | HIGH | Addressed by C4: env var required, localhost rejected, scheme absent if unset |
| F8 | `getSkillById` in registry raises `SkillRegistryError(SKILL_INJECTION_BLOCKED)` — registry-routes must not swallow it silently | LOW | B2 MUST catch `SkillRegistryError` and return 422 with generic message (mirrors existing pattern in `routes.ts:GET /v1/skills/:id`) |

---

## G. Test Plan

File: `/root/sudo-ai-v4/tests/skills/wave12-registry.test.ts`
Minimum 8 tests. All must pass before Quality gate approves.

| # | Test ID | Description |
|---|---------|-------------|
| T1 | yaml-frontmatter-parse | Parse one migrated SKILL.md file, assert `meta.id`, `meta.trust_tier`, `meta.caps` are all populated (non-empty) |
| T2 | registry-list-200 | GET /v1/registry/skills returns 200, `data` is array, all entries have `trust_tier === 'bundled'` |
| T3 | registry-detail-200 | GET /v1/registry/skills/research.web-summary returns 200, body has correct `id`, `name`, `sha256` present |
| T4 | registry-raw-200 | GET /v1/registry/skills/research.web-summary/raw returns 200, Content-Type text/plain or text/markdown, body starts with `---`, contains `trust_tier: bundled` |
| T5 | registry-trust-tier-filter | Insert a mock non-bundled skill (trust_tier=unreviewed) into registry; GET /v1/registry/skills/:id returns 404 |
| T6 | registry-404-on-missing | GET /v1/registry/skills/does-not-exist returns 404, GET /v1/registry/skills/does-not-exist/raw returns 404 |
| T7 | no-auth-bypass | GET /v1/registry/skills without Authorization header returns 200 (not 401) — public endpoint |
| T8 | rate-limit-raw | Call GET /v1/registry/skills/research.web-summary/raw 21 times from same IP in rapid succession; 21st returns 429 with `Retry-After` header |

**T8 test isolation requirement:** The rate-limiter state in `registry-routes.ts` is a module-level `Map` that persists across tests in the same process. T8 will be flaky without isolation. B2 MUST export a `_resetRegistryRateLimits(): void` test-seam function from `registry-routes.ts` (prefix with underscore to signal test-only). QE MUST call `_resetRegistryRateLimits()` in a `beforeEach` hook for T8. The seam is never called in production code.

**Pre-migration check B1 MUST perform:** Before modifying any SKILL.md, run:
```bash
grep -rn 'frontmatter.*{}' /root/sudo-ai-v4/tests/skills/
```
Update any assertions that test for empty frontmatter on the 5 bundled files.

---

## H. Wave 12 Execution Plan

### Phase 0 — Simultaneous (B1 and B2 start at same time, no dependency)

**B1 workstream (SKILL.md migration + importer):**
1. Grep `tests/skills/` for `frontmatter.*{}` assertions on the 5 target files. Note them.
2. Rewrite each of the 5 SKILL.md files per §C1 exact frontmatter values. Preserve body from `## Description` onward. Remove the old `# category.skill-name` line 1.
3. Update any test assertions found in step 1.
4. In `importer.ts`, add the `sudo:` hostname validation block just after the `SCHEME_BASE_URLS` declaration. Add `'sudo'` to `SkillSourceScheme` in `wave10-types.ts`.
5. Run `tsc --noEmit` on `importer.ts` before signalling done.

**B2 workstream (registry routes):**
1. Create `/root/sudo-ai-v4/src/core/skills/registry-route-types.ts` with `PublicSkillEntry` interface (§E4).
2. Create `/root/sudo-ai-v4/src/core/skills/registry-routes.ts` implementing `registerRegistryRoutes` (§E1, §E5, §C2, §C3 including CORS, ETag, rate limits, trust-tier filter, 256 KB cap).
3. Add the 3-line wiring block to `cli.ts` at line ~1857 (§E2).
4. Run `tsc --noEmit` on all 3 files before signalling done.

### Phase 1 — Serial after both B1 and B2 complete

**Integrator:** Run `tsc --noEmit` on the full project. Verify no broken imports.

**index.ts barrel decision (BINDING):** B2 MUST add `export { registerRegistryRoutes } from './registry-routes.js';` to `/root/sudo-ai-v4/src/core/skills/index.ts` per the `standards.md` barrel convention. The cli.ts dynamic import path uses `'./core/skills/registry-routes.js'` (direct, not via barrel) because barrel re-exports do not work cleanly with `await import()` patterns in this codebase — see the existing lazy-import pattern for federation-routes.ts. The barrel export is for module consumers outside cli.ts. B2 owns the `index.ts` edit; it is a one-line addition. Add `index.ts` to B2's file ownership table (below).

**Security Engineer (Opus):** Adversarial review of `registry-routes.ts` focusing on:
- Trust-tier filter bypass (T5 scenario)
- Rate limit key collision (IPv6 vs IPv4 same machine)
- CORS wildcard scope (acceptable for public registry, confirm not applied to auth'd routes)
- `SUDO_PUBLIC_REGISTRY_BASE` validation completeness (F3)
- ETag header does not expose internal IDs

**Quality Engineer:** Write and run `tests/skills/wave12-registry.test.ts` (8 tests). All must pass. Total must be 3057+.

**Perf Watchdog:** Confirm `/v1/registry/skills` list call completes < 50ms p99 on local SQLite (no regression from existing `/v1/skills` baseline).

**User Advocate:** Test as third-party agent developer — can you `curl /v1/registry/skills` without a token, get a usable response, use the `sudo:` URI to reimport a bundled skill?

**Rollback Guardian + DevOps:** Standard pm2 reload, health check, smoke test.

### Parallelism summary

```
B1 ─────────────────┐
                     ├─→ Integrator → Security → Quality → Perf → Advocate → Rollback → DevOps
B2 ─────────────────┘
```

---

## Appendix: Fields NOT in Public Response (Security Reference)

The following `SkillMeta` / `SkillFull` fields exist in the registry but MUST NOT appear in `/v1/registry/skills` responses:

- `body_md` — full markdown body (served only via `/raw`)
- `frontmatter_json` — raw JSON string (superset, includes any future internal fields)
- `archived_at` — internal lifecycle; also: archived skills MUST be excluded from public list (filter `archived_at IS NULL`)
- `id` (SQLite integer row id) — expose frontmatter `id` string only
- Any field from `session_skills` table
- Brier/calibration scores, alignment signals, mistake patterns, injection stats

