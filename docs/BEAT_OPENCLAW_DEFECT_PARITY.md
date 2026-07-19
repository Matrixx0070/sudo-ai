# BEAT-OPENCLAW — Defect-Parity Audit (BO13 / Scorecard S17)

**Mission.** For each of the 8 UI defects catalogued in OpenClaw
(`OPUS_HANDOFF_BEAT_OPENCLAW.md` §10), prove the defect is **ABSENT** in
SUDO-AI's equivalent surface, or **FIX** it if present. Every verdict below
carries a `file:line` citation and a guard (test or code inspection).

**Surfaces under audit.** SUDO-AI's admin UI is the INLINE
`src/core/gateway/dashboard-html.ts` + fragments (`dashboard-usage.ts`,
`dashboard-sessions.ts`, `dashboard-guidance.ts`); the chat SPA is
`src/renderer/chat/*` served by `src/core/gateway/static-middleware.ts` via
`src/core/channels/web.ts`.

**Guard suites (all green):**
- `tests/beat-openclaw/defect-parity.test.ts` — BO13 regression guards (this workstream)
- `tests/sessions/session-admin-actions.test.ts` — BO9 archive-confirm gate (reused for #2)

Run: `npx vitest run tests/beat-openclaw/defect-parity.test.ts tests/sessions/session-admin-actions.test.ts tests/api/admin-stub-honesty.test.ts` → **34 passed**. `npx tsc --noEmit -p tsconfig.json` → **exit 0**.

---

## Verdict table

| # | OpenClaw defect | SUDO-AI equivalent surface (file:line) | Verdict | Guard |
|---|---|---|---|---|
| 1 | "New chat in worktree" button is a no-op | No worktree-chat widget exists; analog is chat SPA "New chat" — `src/renderer/chat/App.tsx:102-107,139-143`, `src/renderer/chat/peer.ts:39-45` | **ABSENT** | `defect-parity.test.ts` #1 (2 tests) — no `worktree` in App.tsx; `handleNewChat` wired to `clearMessages`+`resetChatPeerId`+reload; `resetChatPeerId` mints `crypto.randomUUID()` |
| 2 | Confirm-less Archive **and** confirm-less cron-Remove | Archive: `src/core/sessions/session-admin-actions.ts` `planArchive` + `dashboard-sessions.ts:149-158`. Cron-Remove: `src/core/api/admin/cron.handler.ts:156-179` | **ABSENT (archive) + FIXED (cron)** | Archive: BO9 `session-admin-actions.test.ts` (14 tests). Cron: BO13 added a confirm gate — `defect-parity.test.ts` #2 (3 tests): unconfirmed DELETE → 400 `confirm_required`, job survives; `?confirm=true` deletes |
| 3 | PWA manifest 404 on nested routes | Neither SPA ships a manifest link — `src/renderer/chat/index.html`, `src/renderer/admin/index.html`; nested routing `static-middleware.ts:102-113` | **ABSENT** | `defect-parity.test.ts` #3 (2 tests) — no `rel=manifest`/`.webmanifest` in either index.html; middleware maps nested `/chat/*` + `/v1/admin/dashboard/*` with a `DIST_DIR + sep` traversal guard. **Live:** `GET /chat` → 200 with **0** manifest references |
| 4 | Editor drops a Save during an in-flight save | Guidance editor `dashboard-guidance.ts:135-150`; Fork/Archive `dashboard-sessions.ts:140-158` | **ABSENT** | `defect-parity.test.ts` #4 (2 tests) — Save sets `save.disabled = true` **before** the POST and re-enables only in the callback; Fork/Archive buttons disable identically |
| 5 | Settings search filters only active tab but claims section-wide no-match | No settings-search widget exists in any dashboard fragment | **ABSENT (no analog)** | `defect-parity.test.ts` #5 (1 test) — no `placeholder="…search…"` input in any fragment; the sole `<input>` is the browser-takeover text box (`dashboard-html.ts:666`) |
| 6 | "Open" header button no-op | Inline dashboard header `dashboard-html.ts:78-79` (Refresh, Copy digest); chat SPA header `App.tsx:135-146` (Directory, New chat) | **ABSENT** | `defect-parity.test.ts` #6 (2 tests) — both header buttons carry real `onclick` handlers; no `>Open<` no-op; SPA header buttons bound to `setDirectoryOpen`/`handleNewChat` |
| 7 | Unsaved-counter unreliable | No global unsaved counter; guidance Save reports per-action audited outcome `dashboard-guidance.ts:144-148` | **ABSENT (no analog)** | `defect-parity.test.ts` #7 (2 tests) — no `unsaved`/`dirtyCount`/`pendingCount` in any fragment; Save surfaces `configHashBefore`→`configHashAfter` per action |
| 8 | No min-clamp on number spinners + `{}` residue on field unset | No `<input type=number>` anywhere; numeric rendering coerces via `Number(x\|\|0)` — `dashboard-usage.ts:55-62`, `dashboard-sessions.ts:52-60,125` | **ABSENT (no analog)** | `defect-parity.test.ts` #8 (2 tests) — no `type=number` in any fragment; `Number(x\|\|0)` yields a finite number for unset/undefined/null, never `{}`/`[object …]` |

---

## Per-defect notes

### #1 — worktree-chat no-op → ABSENT
SUDO-AI never exposes a "New chat in worktree" button (OpenClaw's dead widget).
The closest analog is the chat SPA **"New chat"** button, which is fully wired:
`handleNewChat` clears the persisted conversation, calls `resetChatPeerId()`
(which writes a fresh `crypto.randomUUID()` peer id, i.e. a new server session),
and reloads. It performs real work — not a no-op. There is no dead button to fix.

### #2 — confirm-less Archive + cron-Remove → ABSENT (archive) + FIXED (cron)
**Archive** was already solved by BO9: `planArchive` REJECTS any unconfirmed
call with `confirm_required` *before* any state change, and the UI opens a
`window.confirm()` and only POSTs `confirm:true` on agreement. Archive is a
reversible state mark, never a hard delete. Locked by the 14 BO9 tests.

**Cron-Remove** was the one real gap: `DELETE /api/admin/cron/jobs/:id` performed
an unconfirmed **hard delete** (`jobs.splice` + `writeJobs`) — exactly OpenClaw's
confirm-less cron-Remove. BO13 **fixed** it by requiring an explicit confirm
(`?confirm=true` or `?confirm=<job-id>` type-to-confirm), reusing BO9's
`isConfirmed`. An unconfirmed delete now returns `400 confirm_required` and the
job survives. No UI or test called this endpoint prior to the fix, so the change
is non-breaking.

### #3 — PWA manifest 404 on nested routes → ABSENT
OpenClaw's SPA linked its manifest with a **relative** URL, so loading the app on
a nested route resolved the manifest to a wrong path → 404. SUDO-AI's SPAs ship
**no `<link rel="manifest">` at all** (verified in both `index.html` files and in
the live-served `/chat` page: 0 manifest references) — there is no manifest to
mis-resolve. Nested asset routes ARE handled by `static-middleware.ts` (mapped
into the built SPA dir behind a `DIST_DIR + sep` path-traversal guard). Vite
emits absolute `/assets/...` URLs, which never break under a nested path.

### #4 — editor drops Save during in-flight save → ABSENT
The guidance editor disables the Save button *before* dispatching the request and
re-enables it only inside the response callback, so a second click during flight
is inert — no dropped or concurrent save. Fork and Archive use the same
disable-during-flight guard.

### #5 — settings search mis-scopes no-match → ABSENT (no analog)
SUDO-AI's inline dashboard has no settings-search / filter input, so there is no
surface on which a tab-scoped filter could falsely claim a section-wide no-match.

### #6 — "Open" header button no-op → ABSENT
Every header/action button is bound to a real handler (Refresh → `refresh()`,
Copy digest → `copyDigest()`, Directory → `setDirectoryOpen`, New chat →
`handleNewChat`). No dead "Open" button exists.

### #7 — unsaved-counter unreliable → ABSENT (no analog)
There is no global unsaved/dirty counter. The guidance editor reports each save's
outcome per action (audited config hash before→after), which cannot drift because
it is derived from the server response, not accumulated client-side.

### #8 — no min-clamp + `{}` residue → ABSENT (no analog)
SUDO-AI ships no `<input type=number>` spinner in any admin/SPA surface, so there
is no spinner missing a min-clamp. All numeric rendering coerces through
`Number(x||0)`, which returns a finite number for unset/undefined/null inputs —
it can never leave a literal `{}` (empty-object toString) in a field.

---

## Hard-rule compliance
- **S15/S16 untouched.** No security or learning suite is modified; the only
  product change is the cron-delete confirm gate (strictly *more* restrictive).
- **Invariant 4 (frozen surfaces).** The guidance editor keeps frozen
  identity/constitution files read-only (`dashboard-guidance.ts:153-166`); BO13
  changed nothing there.
- **Additive only.** The cron fix adds a gate; it deletes no capability and
  breaks no existing caller (none existed).
