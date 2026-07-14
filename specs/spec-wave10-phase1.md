# Wave 10 Phase 1 — agentskills.io Spec Compliance Spec

**Date:** 2026-04-19  
**Architect:** senior-builder owns all 3 items (single builder, no split — registry-route-types.ts is shared across all 3 tasks, splitting creates collision)  
**Baseline tests:** 3457 pass / 0 fail  
**Target:** 3457+ pass, 0 fail

---

## A. File Boundaries — Senior Builder Owns All

```
SKILL.md files (5):
  /root/sudo-ai-v4/src/core/skills/research/web-summary/SKILL.md
  /root/sudo-ai-v4/src/core/skills/automation/cron-health/SKILL.md
  /root/sudo-ai-v4/src/core/skills/system/self-diagnostic/SKILL.md
  /root/sudo-ai-v4/src/core/skills/intelligence/daily-brief/SKILL.md
  /root/sudo-ai-v4/src/core/skills/content/viral-hook/SKILL.md

Source files (5 modified, 1 new):
  /root/sudo-ai-v4/src/core/skills/registry.ts         (migration method)
  /root/sudo-ai-v4/src/core/skills/registry-route-types.ts  (PublicSkillEntry + emitter + toPublicEntry)
  /root/sudo-ai-v4/src/core/skills/registry-sql.ts      (migration SQL constant)
  /root/sudo-ai-v4/src/core/gateway/http-api.ts         (catchall exemption)
  /root/sudo-ai-v4/src/core/gateway/server.ts           (passthrough exemption)
  /root/sudo-ai-v4/src/core/gateway/well-known-routes.ts  (NEW)

Test files (2 modified, 1 new):
  /root/sudo-ai-v4/tests/skills/wave12-registry.test.ts  (name assertion updates + new fields)
  /root/sudo-ai-v4/tests/gateway/well-known.test.ts      (NEW)
```

No other files touched.

---

## B. Interface Contracts

### B1. SKILL.md frontmatter — new baseline for all 5 bundled files

All 5 files get `license:`, `compatibility:`, and `display_name:` added. The `name:` field changes from display string to canonical slug.

```yaml
---
id: research.web-summary
name: web-summary               # CHANGED: was "Web Summary" — now canonical slug (directory name)
display_name: "Web Summary"     # NEW: human label (double-quoted to survive parseFrontmatter)
version: 1.0.0
description: "..."
author: sudo-ai
trust_tier: bundled
license: MIT                    # NEW
compatibility: [node-22]        # NEW (flat bracket array — parseFrontmatter handles this)
caps: [net.fetch]
tags: [research, web, no-llm]
source: bundled:sudo-ai
metadata:
  trust_tier: bundled
---
```

Slug map for all 5:
- `research.web-summary`  → slug `web-summary`,  display `Web Summary`
- `automation.cron-health` → slug `cron-health`,  display `Cron Health`
- `system.self-diagnostic` → slug `self-diagnostic`, display `Self Diagnostic`
- `intelligence.daily-brief` → slug `daily-brief`,   display `Daily Brief`
- `content.viral-hook`    → slug `viral-hook`,    display `Viral Hook`

`parseFrontmatter` parse behavior for new fields:
- `license: MIT` → `meta['license'] = 'MIT'`
- `compatibility: [node-22]` → `meta['compatibility'] = ['node-22']`
- `display_name: "Web Summary"` → `meta['display_name'] = '"Web Summary"'` (literal quotes preserved by parser)

The builder MUST strip surrounding double-quotes when reading `display_name` from frontmatter: `(raw as string).replace(/^"|"$/g, '')`.

### B2. PublicSkillEntry — updated interface

Add 3 new fields to the interface in `registry-route-types.ts`:

```typescript
export interface PublicSkillEntry {
  id: string;
  name: string;             // now slug (e.g. "web-summary")
  version: string;
  description: string;
  author: string;
  trust_tier: 'bundled';
  caps: string[];
  tags: string[];
  source: string;
  sha256: string;
  importedAt: string;
  license: string;          // NEW — empty string when absent
  compatibility: string[];  // NEW — empty array when absent
  metadata: {
    trust_tier: 'bundled';
    display_name: string;   // NEW — human label, empty string when absent
  };
}
```

`toPublicEntry()` projection additions (in `registry-route-types.ts`):
```typescript
license:       typeof fm['license']       === 'string' ? stripQuotes(fm['license'])       : '',
compatibility: Array.isArray(fm['compatibility']) ? (fm['compatibility'] as string[]) : [],
metadata: {
  trust_tier:   'bundled',
  display_name: typeof fm['display_name'] === 'string' ? stripQuotes(fm['display_name']) : '',
},
```

Where `stripQuotes` is a module-private helper:
```typescript
function stripQuotes(s: string): string { return s.replace(/^"|"$/g, ''); }
```

`emitFrontmatterYaml()` additions in `registry-route-types.ts`:
- Add `'license'` and `'compatibility'` to `ORDERED_FM_KEYS` (before `caps`).
- Add `'display_name'` to `SKIP_IN_FALLTHROUGH` set (it will be emitted inside the metadata block).
- In the metadata block emitter, after emitting `trust_tier`, emit `  display_name: ${metadataDisplayName}` when present.
  `metadataDisplayName` is derived from `fm['display_name']` with `stripQuotes`, falling back to `fm['name']`.

### B3. GET /.well-known/agentskills.json — new route

New file `/root/sudo-ai-v4/src/core/gateway/well-known-routes.ts`.

**Function signature:**
```typescript
export function registerWellKnownRoutes(
  server: import('node:http').Server,
  registry: import('../skills/registry.js').SkillRegistry,
): void
```

**Response shape (exact):**
```json
{
  "registry": "<origin>/v1/registry/skills",
  "spec_version": "1.0",
  "provider": "sudo-ai",
  "total_skills": 5,
  "last_updated_iso": "2026-04-19T00:00:00.000Z"
}
```

**Origin detection:** `const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'; const host = (req.headers['host'] as string | undefined) ?? 'localhost:18900'; const origin = \`${proto}://${host}\`;`

**Cache:** `Cache-Control: public, max-age=60`. ETag computed as `sha256(JSON.stringify(body)).slice(0,16)` — respond 304 when `If-None-Match` header matches.

**CORS:** `Access-Control-Allow-Origin: *` on all responses including 304. OPTIONS preflight returns 200 with Allow: `GET, OPTIONS`.

**Rate limit:** Reuse `checkListRateLimit` from `registry-route-types.ts` (60/min/IP, same map as list endpoint). Return 429 with `Retry-After` header on exceed.

**`total_skills`:** call `registry.list(1000, 0).filter(isBundled).length`. Import `isBundled` from `registry-route-types.ts`.

**`last_updated_iso`:** `registry.list(1, 0)[0]?.created_at ?? new Date().toISOString()`. This returns the most recent skill's `created_at`.

**HTTP path:** `GET /.well-known/agentskills.json` (and OPTIONS).

### B4. Gateway listener exemptions

In `/root/sudo-ai-v4/src/core/gateway/server.ts` (passthrough listener, ~L157):
Add `pathname.startsWith('/.well-known')` to the exemption block before any `passThrough()` call.

In `/root/sudo-ai-v4/src/core/gateway/http-api.ts` (catchall, ~L491):
Add `pathname.startsWith('/.well-known')` to the inner exemption block (inside `if (pathname.startsWith('/v1/'))`— note: this block only handles `/v1/` paths so well-known must be added OUTSIDE that inner if-block, as a separate early return before the `/v1/` block). Pattern to follow: match pathname, call `return` without setting any headers.

In `/root/sudo-ai-v4/src/core/gateway/http-api.ts` the catchall listener structure is:
```
if pathname starts with /v1/ → { exemptions block → auth gate → route handlers }
// non-/v1/ paths fall through here (no response sent)
```
The `.well-known` guard must be a standalone block: `if (pathname.startsWith('/.well-known')) { return; }` placed immediately after the `/v1/` block, BEFORE any `passThrough()` or 404 that might exist below it.

### B5. DB Migration — REQUIRED

The `name` column in the `skills` table is used as the dedup key (`checkHash(name, sha256)`) and as a query key (`getLatestByName`, `maxVersion`, `archive`). When `name:` in SKILL.md flips from `"Web Summary"` to `"web-summary"`, `checkHash("web-summary", sha256)` will miss the old row `("Web Summary", sha256)` and insert a duplicate version.

**Fix:** Add a startup migration method `applyWave10Phase1NameMigration(db)` in `registry-sql.ts`. Called from `SkillRegistry` constructor after `applyWave10Migrations()`. Runs idempotently (UPDATE is safe to run multiple times — no-op when already slugged).

```typescript
export function applyWave10Phase1NameMigration(db: import('better-sqlite3').Database): void {
  const DISPLAY_TO_SLUG: [string, string][] = [
    ['Web Summary',    'web-summary'],
    ['Cron Health',    'cron-health'],
    ['Self Diagnostic','self-diagnostic'],
    ['Daily Brief',    'daily-brief'],
    ['Viral Hook',     'viral-hook'],
  ];
  const stmt = db.prepare(`UPDATE skills SET name = ? WHERE name = ?`);
  for (const [display, slug] of DISPLAY_TO_SLUG) {
    stmt.run(slug, display);
  }
}
```

Also update `session_skills.skill_name` for any attached sessions:
```typescript
const stmtSS = db.prepare(`UPDATE session_skills SET skill_name = ? WHERE skill_name = ?`);
for (const [display, slug] of DISPLAY_TO_SLUG) {
  stmtSS.run(slug, display);
}
```

Call from `SkillRegistry` constructor: `applyWave10Phase1NameMigration(this.db);` immediately after `applyWave10Migrations(this.db);`.

### B6. CLI wiring for well-known route

In `/root/sudo-ai-v4/src/cli.ts`, import `registerWellKnownRoutes` and call it with the shared `server` and `registry` instances, immediately after `registerRegistryRoutes(server, registry)`.

---

## C. Migration Contract

**No new SQLite columns.** The `name` column stays TEXT. Migration is a data UPDATE only (B5 above).

**Re-scan behavior after migration:** After the UPDATE runs, `scanBundledSkills()` reads SKILL.md with `name: web-summary` → `meta['name'] = 'web-summary'` → `checkHash('web-summary', sha256)`. Because the migration already renamed the existing row, `checkHash` finds it and skips re-insert. Correct.

**`id:` field (dotted form) is unchanged.** All internal lookups via `frontmatter['id']` (federation, optimizer, registry routes) remain unaffected.

---

## D. Test Plan

### D1. Update `tests/skills/wave12-registry.test.ts`

Modify the `BUNDLED_SKILLS` fixture at ~L147–L183 — change all 5 `name:` values from display string to slug:
- `'Web Summary'` → `'web-summary'`
- `'Cron Health'` → `'cron-health'`
- `'Self Diagnostic'` → `'self-diagnostic'`
- `'Daily Brief'` → `'daily-brief'`
- `'Viral Hook'` → `'viral-hook'`

Update assertion at L336: `expect(body['name']).toBe('web-summary');`
Update comment at L272: `// The registry.list() returns by name; web-summary name is now 'web-summary'`

Add assertion to T3 (after existing `body['name']` check):
```typescript
expect(body['metadata']['display_name']).toBe('Web Summary');
expect(body['license']).toBe('MIT');
expect(Array.isArray(body['compatibility'])).toBe(true);
```

Add assertion to T9 (raw body has metadata block) — verify raw body includes `display_name`:
```typescript
expect(bodyText).toContain('display_name: Web Summary');
```

Add T13: frontmatter parses license + compatibility + display_name:
```typescript
it('T13: bundled SKILL.md frontmatter includes license, compatibility, display_name', async () => {
  const { status, bodyText } = await httpGetRaw(baseUrl, '/v1/registry/skills/research.web-summary');
  expect(status).toBe(200);
  const body = parseJson(bodyText) as Record<string, unknown>;
  expect(body['license']).toBe('MIT');
  expect(body['compatibility']).toEqual(['node-22']);
  expect((body['metadata'] as Record<string, unknown>)['display_name']).toBe('Web Summary');
  expect(body['name']).toBe('web-summary');
});
```

### D2. New `tests/gateway/well-known.test.ts`

Pattern: spin up real `http.createServer`, wire `registerWellKnownRoutes`, seed a mock registry.

Tests required (minimum 6):
- WK-1: GET `/.well-known/agentskills.json` → 200, JSON body has all 5 required fields (`registry`, `spec_version`, `provider`, `total_skills`, `last_updated_iso`)
- WK-2: `spec_version` is exactly `"1.0"`, `provider` is exactly `"sudo-ai"`
- WK-3: `total_skills` matches mock registry bundled count
- WK-4: ETag header present; conditional GET with matching `If-None-Match` → 304 with no body
- WK-5: `Access-Control-Allow-Origin: *` header present on 200 response
- WK-6: OPTIONS `/.well-known/agentskills.json` → 200 with CORS headers
- WK-7: Rate limit — 61st request in 60s window from same IP → 429 with `Retry-After`

### D3. Regression gates
- `pnpm test` full suite must pass at 3457+ / 0 fail
- `pnpm build:cli` (or `pnpm tsc --noEmit`) must be clean

---

## E. Gateway Listener Ordering

Route must be exempted BEFORE any auth gate. Required in both files:

**`server.ts`** — add to the exemption block (~L157):
```typescript
pathname.startsWith('/.well-known') ||
```

**`http-api.ts`** — add OUTSIDE the `if (pathname.startsWith('/v1/'))` block, as a new standalone guard placed immediately after the `/v1/` block closes. Must NOT be inside the inner exemption block (that only runs for `/v1/` paths):
```typescript
// /.well-known routes — handled by registerWellKnownRoutes listener
if (pathname.startsWith('/.well-known')) { return; }
```

No auth token is required for `/.well-known/agentskills.json`. CORS is wildcard. This is a public discovery endpoint.

---

## F. Acceptance Criteria

1. `GET /.well-known/agentskills.json` returns HTTP 200 with `Content-Type: application/json` containing exactly the 5 fields: `registry`, `spec_version`, `provider`, `total_skills`, `last_updated_iso` — and `spec_version === "1.0"`, `provider === "sudo-ai"`.

2. `GET /v1/registry/skills` returns 5 bundled skills; each entry has `name` equal to the canonical slug (e.g. `"web-summary"` not `"Web Summary"`), `metadata.display_name` equal to the human label, `license === "MIT"`, and `compatibility` is a non-empty array.

3. All 5 bundled SKILL.md files parse without frontmatter errors: `parseFrontmatter(raw).meta` contains `id`, `name` (slug), `display_name` (quoted string), `license`, `compatibility` (array), `trust_tier`.

4. `pnpm test` = 3457+ pass, 0 fail, 3 skipped (no regressions).

5. `pnpm build:cli` completes with 0 TypeScript errors.

6. After `pm2 reload sudo-ai-v5`, both apps show `online` status, `GET /health` returns 200 on both ports, and `GET /.well-known/agentskills.json` returns 200 with `total_skills: 5`.

