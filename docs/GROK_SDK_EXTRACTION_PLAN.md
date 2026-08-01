# Grok SDK — extraction & publication plan

Status: **Plan only — nothing published.** Date: 2026-08-01
Source: `sudo-ai-v4` `src/llm/grok-*.ts` (~30 modules) + ADR 0008 `GrokSeat` façade.

---

## 1. Headline finding: extraction is cheap

The grok modules are already almost standalone. Measured coupling to sudo-ai
internals across all 30 files:

| Import | Count | Extraction cost |
|---|---|---|
| `core/shared/logger.js` | 33 | **Trivial** — inject a `Logger` iface, default no-op |
| `core/shared/paths.js` (`DATA_DIR`) | 15 | **Trivial** — becomes a `storeDir` constructor option |
| `shared-types/ir/v1.js` | 9 | **Small** — vendor the IR types, or drop the IR-shaped fns |
| `core/tools/builtin/browser/anti-detect.js` | 3 | **Scope decision** — see §4 |
| `core/shared/atomic-write.js` | 1 | **Trivial** — inline (~20 lines) |
| `./transport.js` (`callIR`) | 1 | `grok-seat-generate.ts` **stays behind** (sudo-ai-specific) |

Four small seams and one module left behind. No architectural rework.

---

## 2. Package identity

| Field | Value |
|---|---|
| Name | `@<scope>/grok-seat` (scope = Frank's npm org) |
| License | MIT (matches `@xai-official/grok`'s Apache-2.0 neighbourhood; MIT is simpler) |
| Repo | new, standalone — **not** a sudo-ai subdirectory |
| Runtime | Node ≥ 20, ESM-only |
| Deps | keep near-zero: `undici`/native `fetch`. Playwright **optional peer** (browser lane only) |

**Naming caution:** avoid `grok-sdk`, `xai-*`, or anything implying official
status. It is unaffiliated with xAI and the name must not suggest otherwise.

---

## 3. What moves

**Core (lane-agnostic)**
`grok-seat.ts` (façade) · `grok-web-session-manager.ts` (credential store)
`xai-oauth-manager.ts` + `xai-models.ts` (OAuth lane) · `grok-budget.ts`

**Capabilities** — `grok-{models,files,memory,rag,skills,workspaces,automations,`
`voice,realtime-voice,media-extras,embeddings,runcode,connector,mcp-connector}.ts`

**Stays in sudo-ai** — `grok-seat-generate.ts` (wraps `callIR`),
`grok-web-provider.ts` / `grok-web-mcp-provider.ts` (IR transport providers),
`grok-web-tool-loop.ts` (sudo-ai ReACT integration).

---

## 4. THE SCOPE DECISION (blocks publication, not extraction)

The modules split cleanly along the two auth lanes, which is exactly the line the
risk falls on:

**Lane A — OAuth / `cli-chat-proxy`** (9 modules: `xai-oauth-manager`, `xai-models`,
`grok-runcode`, `grok-web-tools`, …)
Sanctioned device-auth flow, documented surface, native function-calling.
No circumvention. Metered — and honest about it, since `cost_in_usd_ticks`
capture (#1052) gives exact per-call cost.
→ **Safe to publish.**

**Lane B — cookie / `grok.com/rest/*`** (20 modules: chat, image, video, voice,
RAG, files, memory, automations, skills, workspaces)
Undocumented consumer endpoints, requires the user's `sso` cookie, and depends on
`grok-statsig-*` (re-derived request signing) plus `anti-detect.js` + a headed
browser to satisfy Cloudflare/`cf_clearance`.
→ **Publishing this distributes anti-bot circumvention to third parties.**
Consequences fall on *users* (account bans) and on the *publisher* (name attached,
ongoing breakage — the algorithm drifted and broke prod this week).

Precedent already set in this repo: `CLAUDE.md` invariant 6 — *"No unofficial
NotebookLM endpoints in the core, ever"*; the unofficial adapter is
compile-excluded and default OFF. Lane B is the same call at larger blast radius.

**Recommended:** publish **Lane A + the `GrokSeat` architecture** (health model,
budgets, self-healing — the genuinely novel parts, zero ToS risk). Keep Lane B
in-tree, exactly as the NotebookLM adapter was handled.

**If Lane B ships anyway**, these are mandatory, not optional:
- Prominent README: unofficial, unaffiliated with xAI, **may violate xAI ToS and
  risk account suspension**.
- Lane B behind an explicit opt-in flag, **default OFF** (mirrors invariant 6).
- No bundled cookie-harvesting UX — user supplies their own session, deliberately.
- Documented breakage expectation + the drift canary shipped as a user-facing
  diagnostic.

---

## 5. Extraction steps (order matters)

1. **Break the seams in-tree first**, while the full sudo-ai test suite still
   guards them — do NOT refactor after moving:
   - `Logger` interface + no-op default (replaces 33 imports)
   - `storeDir` option (replaces 15 `DATA_DIR` imports)
   - inline `atomic-write`
   - vendor or drop the IR types
   Ship as a normal PR; sudo-ai keeps working unchanged.
2. **Create the repo**, copy the selected modules + their tests, `git init`.
3. **Package scaffolding** — `package.json` (exports map, `files`, `engines`),
   `tsconfig` (ESM, `declaration: true`), tsup/tsc build, vitest.
4. **Port the tests.** They are already dependency-injected (`deps.bridge`,
   `deps.mintStatsig`, `fetchImpl`) so they travel with almost no change — this is
   why the suite is worth moving first, before any API polish.
5. **Public API surface** — export `GrokSeat` + capability namespaces only. Keep
   internals unexported; interfaces are the thing you cannot change later.
6. **Docs** — README (quickstart, one-login flow, `doctor()` output), LICENSE,
   SECURITY.md (credential handling), CHANGELOG.
7. **CI** — typecheck + test + build on PR; publish via workflow with npm
   provenance/OIDC. **Never publish from a laptop; never relay an OTP.**
8. **`npm publish --dry-run`**, inspect the tarball, then a `0.1.0` release.

---

## 6. Pre-publish checklist (all must be true)

- [ ] Scope decision made (§4) and reflected in what actually shipped
- [ ] No secrets, tokens, cookies, or `data/` fixtures in the tarball (`--dry-run` verified)
- [ ] No sudo-ai internals leaked (paths, prompts, infra hostnames, `mcp.sudoapi.shop`)
- [ ] README states unaffiliated-with-xAI plainly
- [ ] LICENSE present
- [ ] Package name does not imply official status
- [ ] CI green; build output runs from a clean `npm install`
- [ ] Version `0.x` — signals unstable interface honestly

---

## 7. Ongoing cost (decide before publishing, not after)

A published package is a support commitment. This surface breaks **often**: in one
week we saw the statsig algorithm drift, a free model get revoked, and a required
client-version header appear (HTTP 426). Internally that is a Tuesday; publicly it
is an issue tracker. Budget for it or scope Lane A only, where the surface is
stable because it is sanctioned.
