# SUDO-AI Wave 11 — Hardening + Wiring Spec
# Authored: 2026-04-16 | Architect: claude-sonnet-4-6
# Status: FINAL — do not modify without Architect sign-off

---

## A. EXECUTIVE SUMMARY

Wave 11 is a hardening and wiring wave — no new primitives, only completing existing modules.
6 items across 4 files clusters. All 4 builders work in parallel from day 1.
Estimated net LOC: ~350 new TypeScript + ~60 lines deleted.
Estimated new tests: +30 minimum (target: B1 +8, B2 +8, B3 +8, B4 +6).
New npm dep: `googleapis` (one install by Builder 2 only — SSRF risk isolated to channels/).
Gate chain: Integrator (tsc --noEmit) → Security (Opus, VETO) → Quality (baseline 3019, 100% pass)
  → Performance Watchdog → Rollback Guardian → DevOps (pm2 reload sudo-ai-v5).
Wave duration target: 2-3 days. Single-pass build expected.

---

## B. ITEM INVENTORY

| # | Item | Builder | Files owned |
|---|------|---------|-------------|
| 1 | handleHealth double-response | B1 | src/core/gateway/http-api.ts |
| 5 | compare-routes getTokenBuf per-request | B1 | src/core/gateway/compare-routes.ts |
| 6 | /v1/admin/compare rate limit | B1 | src/core/gateway/compare-routes.ts |
| 2 | googleapis Gmail + Calendar wiring | B2 | src/core/channels/gmail-connector.ts, src/core/channels/gcalendar-connector.ts |
| 3 | Sleep-cycle hooks: SkillDiscovery + AgentConfigEvolver | B3 | src/core/consciousness/sleep-cycle/consolidator.ts |
| 4 | POST /v1/skills/import persistence | B4 | src/core/skills/registry.ts, src/core/skills/routes.ts |

ZERO file overlap. Each builder owns exclusive file(s). The only coordination point is the
`SkillRegistry.registerFromImport` interface defined in section D below — B4 writes it,
no other builder depends on it.

---

## C. ARCHITECTURE DECISIONS (BINDING)

### C1. Item 1 fix: delete the duplicate /health handler in http-api.ts

Decision: DELETE line 479 of `src/core/gateway/http-api.ts`:

    if (method === 'GET' && pathname === '/health') { handleHealth(res); return; }

Rationale: `server.ts:135` is the canonical /health handler. It returns richer data
(uptime, stats). The http-api.ts version returns only `{status:'ok', version:'v5'}` which
is inferior. Deleting one line is safer than adding a guard. The `handleHealth` function
and `handleModels` function at lines 343-348 stay — they are exercised by other routes.

Do NOT add `if (res.headersSent) return;`. Do NOT add '/health' to the fallthrough list.
One line deleted is the entire fix.

### C2. Item 5 fix: move getTokenBuf() call to per-request scope in compare-routes.ts

Decision: In `registerCompareRoutes`, remove:
    const tokenBuf = getTokenBuf();   // line 233 — module-level snapshot, STALE after boot

Refactor `handleCompare` signature to remove the `tokenBuf` parameter.
Inside `handleCompare`, call `getTokenBuf()` directly as the first line — matching the
pattern at skills/routes.ts:91-96 (`isAuthorised` that calls `getTokenBuf()` internally).

The updated function signature is:
    async function handleCompare(req, res, deps): Promise<void>

Inside it, the first line replaces the old auth call:
    const tokenBuf = getTokenBuf();
    if (\!isAuthorised(req, tokenBuf)) { ... }

The `registerCompareRoutes` closure passes only `req, res, deps` to `handleCompare`.

### C3. Item 6: sliding-window rate limit in compare-routes.ts

Decision: 5 requests per 60-second window, keyed by bearer token (if set) or
remote IP (fallback). Sliding window (array of timestamps), same implementation
pattern as `skills/routes.ts:49-73`.

Constants to add at top of compare-routes.ts:
    const COMPARE_RL_WINDOW_MS = 60_000;
    const COMPARE_RL_MAX       = 5;
    const _compareRlWindows    = new Map<string, number[]>();

Function to add (mirrors checkImportRateLimit):
    function checkCompareRateLimit(req): { allowed: boolean; retryAfterSec: number }

Call site: inside the `server.on('request', ...)` handler, BEFORE auth check,
AFTER method/pathname guard. Respond 429 with `Retry-After` header on deny.

### C4. Item 2: googleapis wiring strategy

Decision: Use `pnpm add googleapis`. Use the existing `isGooglapisAvailable()` probe
already in each connector. Replace the TODO stub bodies with real implementations.
Load credentials via `CredentialStore.getCredential(namespace, url)` where:
  - Gmail: namespace='gmail', url='https://oauth2.googleapis.com/token'
  - Calendar: namespace='gcalendar', url='https://oauth2.googleapis.com/token'

`DecryptedCredential` fields used: `client_id`, `client_secret`, `refresh_token`.
Create `google.auth.OAuth2(client_id, client_secret)`, call `setCredentials({refresh_token})`.
Fail gracefully (return {success:false, output:'...'}) when vault credential is absent.
Do NOT initiate browser consent flow — offline-only credential use.

Import the `CredentialStore` class from `../security/vault-credentials.js` in each connector.
Construct with `new CredentialStore()` inside each exported function (lazy, not module-level).

The `getCredential(namespace, url)` call returns `DecryptedCredential | null`.
If null → return {success:false, output:'Google credentials not configured in vault. ...'}

googleapis import inside each function body (keep the dynamic import probe pattern):
    const { google } = await import('googleapis');

### C5. Item 3: SleepCycle hook pattern for SkillDiscovery + AgentConfigEvolver

Decision: Follow the existing duck-typed optional-injection pattern used by
`mistakePatternRecognizer`, `crossSignalDiagnostics`, `reanchorMonitor`.

Two new duck-typed interfaces to add in consolidator.ts (before the SleepCycle class):

    interface SkillDiscoveryLike {
      mine(windowMs?: number): unknown[];  // returns TracePattern[] but we avoid the import
    }

    interface AgentConfigEvolverLike {
      emit(event: string, ...args: unknown[]): boolean; // EventEmitter-compatible
      listenerCount(event: string): number;
    }

Two new optional fields on SleepCycle private members:
    private readonly skillDiscovery: SkillDiscoveryLike | undefined;
    private readonly agentConfigEvolver: AgentConfigEvolverLike | undefined;

Two new optional keys on the constructor opts object:
    skillDiscovery?: SkillDiscoveryLike;
    agentConfigEvolver?: AgentConfigEvolverLike;

Assignment in constructor body (after existing assignments):
    this.skillDiscovery = opts.skillDiscovery;
    this.agentConfigEvolver = opts.agentConfigEvolver;

Hook site: after the existing `this.reanchorMonitor` block (approximately line 601),
before the `this.auditChainSync` block (approximately line 603).
Both blocks are fail-open (try/catch, log.warn on error, never throw).

SkillDiscovery hook behaviour:
  - Call `this.skillDiscovery.mine(24 * 60 * 60 * 1000)` (24-hour window).
  - Log result count at debug level: `{event:'skill.discovery.mined', patternCount: N}`.
  - Store count in a local variable `skillDiscoveryPatternCount` (type: number | undefined).
  - Include in the `_finalise` call summary if non-zero (see section D).

AgentConfigEvolver hook behaviour:
  - Emit a 'sleep-cycle-complete' event: `this.agentConfigEvolver.emit('sleep-cycle-complete', {sessionId})`.
  - Only emit if `this.agentConfigEvolver.listenerCount('sleep-cycle-complete') > 0`.
  - Log emission at debug level.
  - Fail-open if emit throws.

### C6. Item 4: SkillRegistry.registerFromImport public method

Decision: Add one new public method to `SkillRegistry` in registry.ts.
Call it from `skills/routes.ts` in the POST /v1/skills/import handler,
between the duplicate check and the `sendJson(res, 200, ...)` call.

Method signature and behaviour defined in section D below.

### C7. Package manager

Project uses pnpm. Lock file is `pnpm-lock.yaml`. Use `pnpm add googleapis` — NOT `npm install`.
Builder 2 runs this before touching any source files.

---

## D. INTERFACE CONTRACTS (BINDING)

### D1. SkillRegistry.registerFromImport

File: `src/core/skills/registry.ts`

```typescript
/**
 * Persist a skill imported via SkillImporter into the registry.
 * Computes the next version number, assigns a new UUID, and inserts a row.
 *
 * Caller MUST verify the skill is not a duplicate (by name+contentHash)
 * before calling this method — registerFromImport does NOT re-check.
 *
 * @param manifest - The SkillManifest returned by SkillImporter.import().
 * @param raw      - The raw skill file content (used as body_md).
 * @throws SkillRegistryError with code 'INSERT_FAILED' on database write error.
 */
registerFromImport(manifest: SkillManifest, raw: string): void
```

Implementation notes:
- `id`: `randomUUID()` — always a new UUID, ignore manifest.id for the DB row.
- `name`: `manifest.name`
- `version`: query `this.q.maxVersion.get(manifest.name)` → `(maxRow.max_ver ?? 0) + 1`
- `frontmatter_json`: `JSON.stringify({ name: manifest.name, version: manifest.version, author: manifest.author, description: manifest.description, trust_tier: manifest.trust, caps: manifest.caps, source: manifest.source })`
- `body_md`: `raw`
- `sha256`: `manifest.contentHash`
- `created_at`: `new Date().toISOString()`
- `trust_tier`: `manifest.trust`
- `caps_json`: `JSON.stringify(manifest.caps)`

Wrap `this.q.insert.run(...)` in try/catch; re-throw as `SkillRegistryError('registerFromImport failed: ' + msg, 'INSERT_FAILED')`.

The `SkillManifest` type is already imported in registry.ts scope (check imports).
If not present, add: `import type { SkillManifest } from '../shared/wave10-types.js';`

### D2. SleepCycle opts extension

File: `src/core/consciousness/sleep-cycle/consolidator.ts`

The constructor opts type gains two optional fields:

```typescript
skillDiscovery?: {
  mine(windowMs?: number): unknown[];
};
agentConfigEvolver?: {
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
};
```

These are inline in the opts object literal type, NOT exported as named types.
The private fields mirror the same structure.

### D3. compare-routes.ts rate-limit check function

```typescript
function checkCompareRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterSec: number }
```

Returns `{ allowed: true, retryAfterSec: 0 }` when under limit.
Returns `{ allowed: false, retryAfterSec: N }` where N is ceiling seconds to wait.
Sliding window: keep only timestamps within last COMPARE_RL_WINDOW_MS.
Key priority: bearer token (non-empty) → remote IP → 'unknown'.

### D4. POST /v1/skills/import handler — updated call site

In `src/core/skills/routes.ts` between lines 256-262 (after duplicate check, before sendJson):

```typescript
// Persist to registry
registry.registerFromImport(manifest, result.raw);
```

Insert that single line immediately after:
```typescript
if (existing && existing.sha256 === manifest.contentHash) {
  sendError(res, 409, `Skill already imported: ${manifest.name} v${manifest.version}`);
  return;
}
// INSERT HERE: registry.registerFromImport(manifest, result.raw);
sendJson(res, 200, { skill: manifest, imported: true });
```

---

## E. FILE OWNERSHIP MATRIX (STRICT)

| Builder | Files exclusively owned |
|---------|------------------------|
| B1 (Senior) | `/root/sudo-ai-v4/src/core/gateway/http-api.ts` (line delete only) |
| B1 (Senior) | `/root/sudo-ai-v4/src/core/gateway/compare-routes.ts` (Items 5 + 6) |
| B2 (Backend) | `/root/sudo-ai-v4/src/core/channels/gmail-connector.ts` |
| B2 (Backend) | `/root/sudo-ai-v4/src/core/channels/gcalendar-connector.ts` |
| B2 (Backend) | `/root/sudo-ai-v4/pnpm-lock.yaml` (side-effect of pnpm add) |
| B2 (Backend) | `/root/sudo-ai-v4/package.json` (googleapis dep entry) |
| B3 (Backend) | `/root/sudo-ai-v4/src/core/consciousness/sleep-cycle/consolidator.ts` |
| B4 (Backend) | `/root/sudo-ai-v4/src/core/skills/registry.ts` |
| B4 (Backend) | `/root/sudo-ai-v4/src/core/skills/routes.ts` |

NO other builder may touch these files. If a test file needs creation, the builder
who owns the module under test owns the test file too.

---

## F. ACCEPTANCE CRITERIA (PER ITEM)

### F1. Item 1 — handleHealth double-response RESOLVED

- `GET /health` returns exactly one HTTP response with status 200.
- The response body contains `uptime` and `stats` fields (from server.ts handler).
- `curl -s localhost:18900/health | jq '.uptime'` returns a number (not null).
- No `ERR_HTTP_HEADERS_SENT` in logs after `/health` request.
- Verified: `http-api.ts` no longer contains `handleHealth(res)` call at line 479.

### F2. Item 5 — compare-routes getTokenBuf per-request

- Restarting the process with a NEW `GATEWAY_TOKEN` env var causes `GET /v1/admin/compare`
  to honour the new token immediately without a code change.
- Test: in a unit test, spy on `getTokenBuf` and confirm it is called on every request
  invocation of `handleCompare`, not once at module registration.
- The `tokenBuf` closure variable at old line 233 no longer exists in the source file.

### F3. Item 6 — /v1/admin/compare rate limit

- The 6th request within 60 seconds from the same IP receives HTTP 429 with a `Retry-After`
  header containing a positive integer.
- Requests 1-5 in the window succeed (assuming valid auth + params).
- After the 60-second window expires, the counter resets and request 1 succeeds again.
- `_compareRlWindows` Map is module-scoped (not exported).
- Rate limit check occurs BEFORE auth check (fail fast, no token consumption on limit hit).

### F4. Item 2 — googleapis Gmail + Calendar wiring

- `pnpm add googleapis` completes without error. `googleapis` appears in `package.json` dependencies.
- `listGmailMessages()` called when vault has no 'gmail' credential:
  returns `{ success: false, output: 'Google credentials not configured in vault...' }`.
- `listGmailMessages()` called when vault has a valid 'gmail' OAuth credential:
  calls `gmail.users.messages.list` and returns `{ success: true, messages: [...], count: N }`.
- `sendGmailMessage(to, subject, body)` called with vault credential:
  builds RFC 2822 string, base64url-encodes it, calls `gmail.users.messages.send`.
- `listCalendarEvents()` with valid vault credential: calls `calendar.events.list` with
  `timeMin: now`, `timeMax: now + 7 days`, returns `{ success: true, events: [...] }`.
- `createCalendarEvent({summary, start, end})` with valid vault credential:
  calls `calendar.events.insert`, returns `{ success: true, eventId: '...', output: '...' }`.
- `createCalendarEvent({summary, start, end}, dryRun=true)` returns `{ success: true, dryRun: true }`.
- No vault credential → graceful `{success: false}` — NEVER throws.

### F5. Item 3 — Sleep-cycle hooks

- `new SleepCycle({ ..., skillDiscovery: mockDiscovery, agentConfigEvolver: mockEvolver })`
  compiles and constructs without error.
- After a complete `startSleep()` cycle, `mockDiscovery.mine` is called exactly once with
  `windowMs = 86400000` (24h in ms).
- After a complete cycle, `mockEvolver.emit` is called with `'sleep-cycle-complete'` and
  an object containing `sessionId`.
- If `skillDiscovery.mine` throws, the sleep cycle continues (fail-open) and returns a
  valid SleepSession.
- Constructing `SleepCycle` WITHOUT `skillDiscovery` or `agentConfigEvolver` still works
  (backward compatible — both optional).

### F6. Item 4 — POST /v1/skills/import persistence

- `POST /v1/skills/import` with a valid URI returns HTTP 200 with `{ skill: {...}, imported: true }`.
- Immediately after, `GET /v1/skills` returns the imported skill in the list.
- `GET /v1/skills/:id` returns full skill body for the imported skill.
- Duplicate import (same name + contentHash) returns HTTP 409 (unchanged behaviour).
- `registry.registerFromImport(manifest, raw)` inserts exactly one row with the correct
  `trust_tier` and `caps_json` from the manifest.

---

## G. TEST PLAN (MINIMUM)

Each builder creates tests in the `tests/` directory, following existing vitest patterns.
The baseline is 3019 tests. Wave 11 must deliver >= 3049 tests passing.

### G1. Builder 1 tests (target +8)

File: `tests/gateway/wave11-health-compare.test.ts`

1. GET /health returns 200 with `uptime` field (integration-level mock server).
2. GET /health does NOT trigger double-response (assert no ERR_HTTP_HEADERS_SENT).
3. `checkCompareRateLimit`: 5 requests → all allowed, 6th → not allowed.
4. `checkCompareRateLimit`: window expiry resets counter (mock Date.now).
5. `checkCompareRateLimit`: key is bearer token when token provided.
6. `checkCompareRateLimit`: key falls back to IP when no bearer.
7. `handleCompare` calls `getTokenBuf()` on every invocation (spy test).
8. compare-routes: 429 response includes `Retry-After` header with positive integer.

### G2. Builder 2 tests (target +8)

File: `tests/channels/wave11-googleapis.test.ts`

Use `vi.mock('googleapis', ...)` to stub the googleapis module.
Use a mock `CredentialStore` that returns a preset credential or null.

1. `listGmailMessages` — no vault credential → {success:false}.
2. `listGmailMessages` — with credential → calls `gmail.users.messages.list`.
3. `sendGmailMessage` — with credential → calls `gmail.users.messages.send`.
4. `sendGmailMessage` — missing 'to' → {success:false, output contains 'required'}.
5. `listCalendarEvents` — no vault credential → {success:false}.
6. `listCalendarEvents` — with credential → calls `calendar.events.list`.
7. `createCalendarEvent` — dryRun=true → {success:true, dryRun:true}.
8. `createCalendarEvent` — with credential → calls `calendar.events.insert`.

### G3. Builder 3 tests (target +8)

File: `tests/consciousness/wave11-sleep-hooks.test.ts`

Use the existing SleepCycle test scaffolding pattern.

1. SleepCycle constructs with `skillDiscovery` and `agentConfigEvolver` opts — no throw.
2. SleepCycle constructs WITHOUT those opts — backward compatible.
3. After startSleep(): `skillDiscovery.mine` called once with 86400000.
4. After startSleep(): `agentConfigEvolver.emit` called with 'sleep-cycle-complete'.
5. `agentConfigEvolver.emit` argument contains `sessionId` string.
6. `skillDiscovery.mine` throws → sleep cycle still returns a SleepSession (fail-open).
7. `agentConfigEvolver.emit` throws → sleep cycle still returns a SleepSession (fail-open).
8. `agentConfigEvolver.listenerCount` returns 0 → emit is NOT called.

### G4. Builder 4 tests (target +6)

File: `tests/skills/wave11-import-persist.test.ts`

Use in-memory SQLite database (`:memory:`) via the existing SkillRegistry test helpers.

1. `registerFromImport(manifest, raw)` inserts one row with correct `name` and `sha256`.
2. `registerFromImport` computes version = max_existing + 1.
3. `registerFromImport` on empty registry creates version = 1.
4. After `registerFromImport`, `getSkillMeta(manifest.name)` returns non-null.
5. POST /v1/skills/import → GET /v1/skills confirms imported skill appears in list.
6. `registerFromImport` re-throw as SkillRegistryError with code 'INSERT_FAILED' on DB error.

---

## H. WAVE EXECUTION PLAN

### Phase 1 — All 4 builders start simultaneously (Day 1)

B1: Delete http-api.ts line 479. Then refactor compare-routes.ts Items 5+6 in a single edit pass.
    Write tests. Estimated time: 2-3 hours.

B2: Run `pnpm add googleapis` first. Then wire gmail-connector.ts. Then gcalendar-connector.ts.
    Write tests. Estimated time: 4-6 hours (network + googleapis API familiarity).

B3: Add duck-typed interfaces, private fields, constructor opt keys, hook blocks in consolidator.ts.
    Write tests. Estimated time: 2-3 hours.

B4: Add `registerFromImport` to registry.ts. Add call in routes.ts. Write tests.
    Estimated time: 2 hours.

### Phase 2 — Integrator (after all builders signal done)

- Run `tsc --noEmit` from `/root/sudo-ai-v4/`.
- Verify no new TypeScript errors.
- Verify module imports resolve (googleapis, vault-credentials in connectors).
- Signal Security Engineer.

### Phase 3 — Security Engineer (Opus, VETO power)

Adversarial review focus areas:
- Item 2: googleapis OAuth credential scope — does the connector request minimum scopes?
  Gmail: `https://www.googleapis.com/auth/gmail.readonly` for list,
         `https://www.googleapis.com/auth/gmail.send` for send. Verify scopes are specified.
- Item 6: rate-limit map is module-scoped and never cleared — potential memory DoS if
  distinct IPs exhaust map capacity. Acceptable for single-process pm2 deployment; note as known.
- Item 4: `registerFromImport` does not re-validate caps via `checkCapabilities`. The route
  handler's duplicate check is the trust gate. Confirm this is acceptable.

### Phase 4 — Quality Engineer (100% pass gate, baseline 3019)

### Phase 5 — Performance Watchdog

No soak regression expected. Item 6 rate-limit check is O(n) over timestamps array (max
~5 entries); negligible overhead. Item 2 googleapis calls are async + vault-gated.

### Phase 6 — Rollback Guardian + DevOps

---

## I. ROLLBACK PLAN (PER ITEM)

### I1. Item 1 (health fix) rollback
Risk: None. server.ts handler remains unchanged. Reverting means re-adding line 479 to http-api.ts.
Impact of failure: /health would return double-response again (existing bug, same as pre-wave).

### I2. Item 2 (googleapis) rollback
Risk: Medium. `pnpm add googleapis` modifies package.json and pnpm-lock.yaml.
Rollback: `pnpm remove googleapis` restores lock file state. Connectors fall back to stub
gracefully because `isGooglapisAvailable()` returns false when package is absent.
Zero user-facing breakage on rollback.

### I3. Item 3 (sleep hooks) rollback
Risk: Low. Both new opts are optional. Rolling back consolidator.ts to prior version
means sleep cycles continue without SkillDiscovery/AgentConfigEvolver hooks.
Any caller passing those opts would need to be updated (search cli.ts / bootstrap).

### I4. Item 4 (import persistence) rollback
Risk: Low. Reverting: remove the `registry.registerFromImport(manifest, result.raw)` call
in routes.ts and remove the method from registry.ts. Import endpoint returns 200 again
without persisting — same as pre-wave behaviour. No data loss (SQLite row simply not written).

### I5. Items 5+6 (compare-routes refactor) rollback
Risk: Low. compare-routes.ts is a standalone file. Reverting restores module-level tokenBuf
snapshot (stale-after-boot bug re-appears) and removes rate limit. Neither breaks existing function.

---

## J. DECISIONS LOG

| Decision | Chosen | Rejected | Reason |
|----------|--------|----------|--------|
| Item 1 fix approach | Delete line 479 | Add `if (res.headersSent) return;` guard | Deletion is simpler, removes dead code, server.ts response is richer |
| Item 5 fix scope | compare-routes.ts only | skills/routes.ts | Item 5 bug is in compare-routes (module-level tokenBuf); skills/routes already correct |
| Item 6 rate limit | 5/min per IP or token | 10/min | Same endpoint costs 2x model calls; more conservative limit appropriate |
| Item 2 dep | googleapis (monorepo) | @googleapis/gmail + @googleapis/calendar | Existing stubs reference 'googleapis'; consistency; avoid dual dep |
| Item 3 AgentConfigEvolver interface | EventEmitter duck-type (emit+listenerCount) | Full EventEmitter extends | Avoids runtime import of EventEmitter; fail-open emit guard requires listenerCount |
| Item 4 registerFromImport id | new randomUUID() | manifest.id | Registry IDs must be unique DB UUIDs, not semantic IDs from manifest |
| Item 4 trust gate | Route handler duplicate check is the gate | Re-run checkCapabilities in registerFromImport | checkCapabilities was already run by importer.import() before this point |

---

## K. SPAWN PROMPTS FOR BUILDERS

### Builder 1 (Senior — Gateway)

"You are Builder 1, Senior Backend.
Project: SUDO-AI v5 at /root/sudo-ai-v4/. Node 22 ESM, TypeScript 6, raw node:http, pnpm, vitest 4.
Your file boundaries (no other builder touches these):
  - /root/sudo-ai-v4/src/core/gateway/http-api.ts
  - /root/sudo-ai-v4/src/core/gateway/compare-routes.ts
  - /root/sudo-ai-v4/tests/gateway/wave11-health-compare.test.ts (create new)

Task (3 items, single-pass):

ITEM 1 — http-api.ts: Delete exactly line 479:
  `if (method === 'GET' && pathname === '/health') { handleHealth(res); return; }`
  No other changes to this file.

ITEM 5 — compare-routes.ts: The `const tokenBuf = getTokenBuf()` at line 233
(inside registerCompareRoutes, before server.on) is a module-level snapshot that goes
stale if GATEWAY_TOKEN changes after boot. Fix: remove that const. Refactor handleCompare
to drop the tokenBuf parameter. Inside handleCompare, add `const tokenBuf = getTokenBuf();`
as its first line. Update the server.on call site accordingly.

ITEM 6 — compare-routes.ts: Add sliding-window rate limit (5 req/60s per IP or bearer token).
  Add module-level constants: COMPARE_RL_WINDOW_MS=60000, COMPARE_RL_MAX=5, _compareRlWindows=new Map<string,number[]>().
  Add function checkCompareRateLimit(req) following the exact same pattern as
  skills/routes.ts:49-73. Call it inside the server.on request handler BEFORE handleCompare,
  AFTER the method/pathname guard. Respond 429 with Retry-After header on deny.

Tests: create /root/sudo-ai-v4/tests/gateway/wave11-health-compare.test.ts with 8 tests
(see spec section G1). Run vitest to confirm all pass.

When done: report 'B1 complete' with test count and tsc --noEmit result."

---

### Builder 2 (Backend — Channels)

"You are Builder 2, Backend.
Project: SUDO-AI v5 at /root/sudo-ai-v4/. Node 22 ESM, TypeScript 6, pnpm, vitest 4.
Your file boundaries:
  - /root/sudo-ai-v4/src/core/channels/gmail-connector.ts
  - /root/sudo-ai-v4/src/core/channels/gcalendar-connector.ts
  - /root/sudo-ai-v4/package.json (dep entry only — pnpm add adds this)
  - /root/sudo-ai-v4/pnpm-lock.yaml (side effect only)
  - /root/sudo-ai-v4/tests/channels/wave11-googleapis.test.ts (create new)

FIRST: run `pnpm add googleapis` from /root/sudo-ai-v4/. Confirm it succeeds.
If network is blocked, stop immediately and report to Lead — do not proceed without this dep.

Task: Wire the 4 stub functions in both connectors.

Credential loading pattern (use in every function):
  import { CredentialStore } from '../security/vault-credentials.js';
  const store = new CredentialStore();
  const cred = store.getCredential(NAMESPACE, 'https://oauth2.googleapis.com/token');
  if (\!cred) return { success: false, output: 'Google credentials not configured in vault. Store OAuth tokens via POST /v1/vaults/{namespace}/credentials.' };

Gmail (namespace='gmail'):
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  auth.setCredentials({ refresh_token: cred.refresh_token });
  const gmail = google.gmail({ version: 'v1', auth });

  listGmailMessages(maxResults=20): call gmail.users.messages.list({ userId:'me', maxResults: Math.min(maxResults,20) }).
    For each message, call gmail.users.messages.get({ userId:'me', id: msg.id, format:'metadata', metadataHeaders:['From','Subject','Date'] }).
    Return { success:true, messages:[{id,threadId,snippet,from,subject,date}], count:N, output:'Listed N messages' }.

  sendGmailMessage(to, subject, body): Validate to/subject/body non-empty → {success:false} if missing.
    Build RFC 2822 string. Base64url-encode. Call gmail.users.messages.send({ userId:'me', requestBody:{ raw: encoded } }).
    Return { success:true, messageId: response.data.id, output:'Message sent' }.

Calendar (namespace='gcalendar'):
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  auth.setCredentials({ refresh_token: cred.refresh_token });
  const calendar = google.calendar({ version: 'v3', auth });

  listCalendarEvents(calendarId='primary'): call calendar.events.list({ calendarId, timeMin:now.toISOString(), timeMax:(now+7days).toISOString(), singleEvents:true, orderBy:'startTime', maxResults:20 }).
    Return { success:true, events:[{id,summary,start,end,description,location}], count:N, output:'Listed N events' }.

  createCalendarEvent(event, dryRun=false): validate summary+start+end non-empty.
    If dryRun=true: return existing stub { success:true, dryRun:true, output:'Dry-run: ...' }.
    Call calendar.events.insert({ calendarId:'primary', requestBody: event }).
    Return { success:true, eventId: response.data.id, output:'Event created: {summary}' }.

All functions: wrap in try/catch; on error return { success:false, output: err.message }.
Never throw. Never expose raw stack traces to callers.

Tests: create tests/channels/wave11-googleapis.test.ts with 8 tests using vi.mock('googleapis').
See spec section G2. Run vitest to confirm all pass.

When done: report 'B2 complete' with test count."

---

### Builder 3 (Backend — Consciousness)

"You are Builder 3, Backend.
Project: SUDO-AI v5 at /root/sudo-ai-v4/. Node 22 ESM, TypeScript 6, pnpm, vitest 4.
Your file boundaries:
  - /root/sudo-ai-v4/src/core/consciousness/sleep-cycle/consolidator.ts
  - /root/sudo-ai-v4/tests/consciousness/wave11-sleep-hooks.test.ts (create new)

Task: Add SkillDiscovery and AgentConfigEvolver hooks to SleepCycle.

Step 1 — Add two duck-typed interfaces near the top of consolidator.ts (after existing duck-typed interfaces, before the SleepCycle class):

  interface SkillDiscoveryLike {
    mine(windowMs?: number): unknown[];
  }

  interface AgentConfigEvolverLike {
    emit(event: string, ...args: unknown[]): boolean;
    listenerCount(event: string): number;
  }

Step 2 — Add two private fields to SleepCycle class:
  private readonly skillDiscovery: SkillDiscoveryLike | undefined;
  private readonly agentConfigEvolver: AgentConfigEvolverLike | undefined;

Step 3 — Add to constructor opts type (the object literal type in the constructor signature):
  skillDiscovery?: SkillDiscoveryLike;
  agentConfigEvolver?: AgentConfigEvolverLike;

Step 4 — In constructor body, after `this.reanchorMonitor = opts.reanchorMonitor;`:
  this.skillDiscovery = opts.skillDiscovery;
  this.agentConfigEvolver = opts.agentConfigEvolver;

Step 5 — Add hook blocks in startSleep() after the `this.reanchorMonitor` block (~line 601)
and BEFORE the `this.auditChainSync` block. Both blocks are try/catch fail-open.

SkillDiscovery hook:
  if (this.skillDiscovery) {
    try {
      const patterns = this.skillDiscovery.mine(24 * 60 * 60 * 1000);
      log.debug({ event: 'skill.discovery.mined', patternCount: patterns.length }, 'SkillDiscovery.mine completed in sleep cycle');
    } catch (err: unknown) {
      log.warn({ err, event: 'skill.discovery.error' }, 'SkillDiscovery.mine threw — skipping (fail-open)');
    }
  }

AgentConfigEvolver hook:
  if (this.agentConfigEvolver) {
    try {
      if (this.agentConfigEvolver.listenerCount('sleep-cycle-complete') > 0) {
        this.agentConfigEvolver.emit('sleep-cycle-complete', { sessionId });
        log.debug({ event: 'agent-config-evolver.emit', sessionId }, 'AgentConfigEvolver sleep-cycle-complete emitted');
      }
    } catch (err: unknown) {
      log.warn({ err, event: 'agent-config-evolver.error' }, 'AgentConfigEvolver emit threw — skipping (fail-open)');
    }
  }

Note: `sessionId` is a local variable already in scope at the hook site (search for `const sessionId` in startSleep()).
Confirm the variable name matches. Do not rename it.

Tests: create tests/consciousness/wave11-sleep-hooks.test.ts with 8 tests. See spec section G3.
Run vitest to confirm all pass.

When done: report 'B3 complete' with test count."

---

### Builder 4 (Backend — Skills)

"You are Builder 4, Backend.
Project: SUDO-AI v5 at /root/sudo-ai-v4/. Node 22 ESM, TypeScript 6, better-sqlite3, pnpm, vitest 4.
Your file boundaries:
  - /root/sudo-ai-v4/src/core/skills/registry.ts
  - /root/sudo-ai-v4/src/core/skills/routes.ts
  - /root/sudo-ai-v4/tests/skills/wave11-import-persist.test.ts (create new)

Task: Expose a public `registerFromImport` method on SkillRegistry, and call it from the route handler.

Step 1 — registry.ts: Add the following public method (after the `loadSkillBody` method, before `getSkillById`):

  registerFromImport(manifest: SkillManifest, raw: string): void {
    const maxRow = this.q.maxVersion.get(manifest.name) as { max_ver: number | null };
    const version = (maxRow.max_ver ?? 0) + 1;
    const frontmatter_json = JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      trust_tier: manifest.trust,
      caps: manifest.caps,
      source: manifest.source,
    });
    try {
      this.q.insert.run({
        id: randomUUID(),
        name: manifest.name,
        version,
        frontmatter_json,
        body_md: raw,
        sha256: manifest.contentHash,
        created_at: new Date().toISOString(),
        trust_tier: manifest.trust,
        caps_json: JSON.stringify(manifest.caps),
      });
      log.debug({ name: manifest.name, version }, 'skill registered via registerFromImport');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SkillRegistryError('registerFromImport failed: ' + msg, 'INSERT_FAILED');
    }
  }

Ensure `SkillManifest` is imported at the top of registry.ts:
  import type { SkillManifest, SkillTrustTier } from '../shared/wave10-types.js';
  (SkillTrustTier is likely already there — check first, add only what is missing.)

Step 2 — routes.ts: In the POST /v1/skills/import handler, after the duplicate check block
(the `if (existing && existing.sha256 === manifest.contentHash)` block that sends 409),
add exactly ONE line before `sendJson(res, 200, ...)`:

  registry.registerFromImport(manifest, result.raw);

The full block becomes:
  const existing = registry.getSkillMeta(manifest.name);
  if (existing && existing.sha256 === manifest.contentHash) {
    sendError(res, 409, `Skill already imported: ${manifest.name} v${manifest.version}`);
    return;
  }
  registry.registerFromImport(manifest, result.raw);   // ← INSERT THIS LINE
  sendJson(res, 200, { skill: manifest, imported: true });

Wrap the registerFromImport call in a try/catch if you want to map SkillRegistryError
to a 500 response — optional but preferred for operator debugging.

Tests: create tests/skills/wave11-import-persist.test.ts with 6 tests. See spec section G4.
Use SQLite :memory: DB. See existing registry tests for setup pattern.
Run vitest to confirm all pass.

When done: report 'B4 complete' with test count."

---

## L. KNOWN RISKS (REQUIRING LEAD APPROVAL BEFORE STEP 3)

### L1. Network sandbox may block `pnpm add googleapis`

Builder 2's first action is `pnpm add googleapis`. If the sandbox blocks outbound npm registry
access, Builder 2 is blocked. Mitigation: Lead pre-approves sandbox override for that single
pnpm command, or pre-installs googleapis manually, or Builder 2 uses `dangerouslyDisableSandbox:true`
for the install step only. googleapis is ~85MB uncompressed including all sub-deps.

### L2. `CredentialStore` public API surface unclear

The spec references `store.getCredential(namespace, url)` but the vault-credentials.ts read
shows the class internals without the exact public method signature confirmed. Builder 2 must
inspect vault-credentials.ts lines 1-200 on startup and confirm the method name + signature
before writing connector code. If the method is named differently, Builder 2 adjusts only the
connector files — no spec change needed.

### L3. `sessionId` variable name in startSleep() hook site

The spec assumes `sessionId` is in scope at the hook insertion point (~line 601 in consolidator.ts).
Builder 3 must confirm the variable name by reading the surrounding code before inserting.
If the variable is named differently (e.g., `sid`), Builder 3 uses the actual name.

---

Spec version: wave11-v1.0
Last updated: 2026-04-16
