# Scaffolding Audit — 2026-08-06

First run of the doctrine sweep mandated by Engineering Doctrine #1/#2/#3
("never bet against the model", `// SCAFFOLD:` markers exist so they can be
deleted later, "deletion is progress"). This file is the **baseline** — the
next sweep starts here instead of from scratch.

Method and its limits are stated at the bottom. Read them before trusting a
"nothing depends on it" claim.

---

## 0. Headline finding

**Not one of the 9 `SCAFFOLD:`-marked sites in the repo is a model-limitation
scaffold.** All of them work around *third-party API / vendor-UI brittleness*
(xAI's connector crawler, Gemini's batchexecute wire indices, Grok's statsig
spinner assets, an Ink/React dev-build warning). Those do not get cheaper as
models improve; they get cheaper only when the vendor changes.

Meanwhile the code that *is* model-limitation scaffolding — keyword intent
classifiers, malformed-JSON repair, laziness nudges, rationalization guards,
universal-negative guards, output filler-strippers — carries **zero markers**.

So the marker convention is currently pointing at the wrong population. The
concrete recommendation is in §4.

---

## 1. Marked `SCAFFOLD:` inventory (complete, 9 sites)

Enumerated case-insensitively over `*.ts *.tsx *.mts *.cts *.js *.mjs *.py *.sh
*.json5` plus `*.md`, excluding `node_modules/` and `graphify-out/`.

| # | Site | Works around | Model-limitation? | Verdict |
|---|------|--------------|-------------------|---------|
| S-M1 | `src/core/gateway/mcp-http-transport.ts:59` + `:186` + `:208` (COMMAND_DISGUISE) | xAI's MCP connector crawler silently drops tools it classifies as non-read-scope, so the operator-authorized `agent.command` lane is invisible in the Grok app | No — vendor classifier | **KEEP.** Vendor-side, still live. Every real guard (capability token, F18 arg quarantine, budgets) still runs at `tools/call`; only the advertised name/description is reshaped. Removal breaks a working owner-tier lane. |
| S-M2 | `src/cli/commands/chat-warning-filter.ts:3` (+ `src/cli/commands/chat.ts:9`) | Spurious React duplicate-key warning from Ink 7 / react-reconciler 0.33 / React 19.2, **dev builds only**; stack contains zero sudo-ai frames | No — upstream dev-build artifact | **KEEP.** File documents that the obvious alternative (force `NODE_ENV=production` for the TUI) was rejected because 22 sites branch on `NODE_ENV`, including the llm-client caller guard which flips throw→fail-open. Re-check on the next Ink/React bump. |
| S-M3 | `src/llm/gemini-web-mint.ts:62` (`model_id` + capacity constants) | Gemini web-seat internal constants | No — vendor wire format | **KEEP** (vendor). |
| S-M4 | `src/llm/gemini-web-mint.ts:241` (reply `[4]` / `[1][0]` indices) | Gemini batchexecute response indices, version-brittle | No — vendor wire format | **KEEP** (vendor). |
| S-M5 | `src/llm/gemini-web-mint.ts:317` (media indices) | Same, "MOST version-brittle part" per the comment | No | **KEEP** (vendor). |
| S-M6 | `src/llm/gemini-web-mint.ts:462` / `:645` (Deep Research plan + status indices) | Same | No | **KEEP** (vendor). |
| S-M7 | `src/llm/gemini-web-mint.ts:732` / `:775` / `:813` / `:856` (read-chat, immersive report, conversation-list indices) | Same | No | **KEEP** (vendor). |
| S-M8 | `src/llm/grok-statsig-mint.ts:58` | The 4 `.r-gswh7` loading-spinner `d` paths are grok static assets, byte-stable | No — vendor asset | **KEEP — DO NOT TOUCH.** Grok/statsig lane; two production outages already came from edits here. Out of scope for any sweep without an explicit owner GO. |
| S-M9 | `scripts/grok-web/statsig_mint.mjs:106` | Same as S-M8, script-side twin | No | **KEEP — DO NOT TOUCH** (same lane). |

Non-marker matches deliberately excluded: `coder.scaffold` tool strings in
`src/core/tools/builtin/coder/project-scaffold.ts` (a product feature named
"scaffold", not a doctrine marker), the prose word "scaffolding" in
`src/llm/grok-web-mcp-provider.ts:93`, and the hypothetical `// SCAFFOLD:`
escape hatch proposed in `docs/adr/0009-memory-write-lane-consolidation.md:44`
(not yet code).

**Net: 0 marked scaffolds are deletable as model-obsolete. All 9 are vendor
scaffolds and all 9 stay.**

---

## 2. Unmarked scaffolding — model-limitation workarounds with no marker

These are the ones the doctrine actually targets. All are live unless noted.

| # | Site | The bet against the model | Wiring | Verdict |
|---|------|---------------------------|--------|---------|
| S-U1 | `src/core/agent/response-compressor.ts` (161 lines) | Strips "filler openers" (`got it`, `sure`, `let me`, `i'll`, `okay`, …) from final answers and hard-truncates >60 lines / >4000 chars. Header cites "Codex GPT-5.4 strict formatting rules" | **Dead.** Only reference in the whole repo was the `src/core/agent/index.ts` barrel line. No call site, no test | **DELETED in this PR.** Evidence in §3. |
| S-U2 | `src/core/agent/special-requests.ts` | Keyword classifier for `undo` / `review` / `explain` / `time` intents that returns a system hint — i.e. tells the model what its own user meant | **Dead.** `detectSpecialRequest` / `getSpecialRequestHint` referenced only by the barrel (`index.ts:47`) | **DELETE NOW — recommended, NOT executed.** Same evidence class as S-U1, but it overlaps a *live* capability (`intent-classifier.ts`), so it goes to the owner rather than the axe. One-line barrel edit + one file to remove. |
| S-U3 | `src/core/agent/intent-classifier.ts` (294 lines) | Regex `CONVERSATION_PATTERNS` + a hardcoded `SPAWN_KEYWORDS` table ("make a video" → 5 named agent roles, "build an app" → architect/backend/frontend/tester/devops) decide intent type, suggested tools, complexity and team composition. Header: "Adapted from ChatGPT Agent output (2026-04-03)" | **Live**: `loop.ts:52` (`classifyIntent` + `formatIntentHint`), `learning/routing-trace.ts:21`, and `self-improvement/engine.ts:431` writes tuning suggestions back into this very file | **NEEDS-MEASUREMENT.** This is the single largest bet against the model in the repo: a 2026-04 keyword table telling an Opus-5-class model what tools to reach for. It is *advisory* (a hint string), so the removal risk is low — but "low risk" is not evidence. Needs an A/B on real turns (hint on vs off) measuring tool-choice correctness before anything is cut. Note the self-improvement engine currently *feeds* this table, so removing it also removes a learning sink. |
| S-U4 | `src/core/tools/json-repair.ts` (207 lines) | Repairs almost-valid JSON tool calls: markdown fences, trailing commas, single quotes, Python literals, unquoted keys, truncated tails | **Live**: `brain.ts:68` | **KEEP.** Its own header states the correct scope: "Frontier models emit native tool calls and never reach this code; smaller models (kimi/glm/ollama/local) routinely emit almost-valid JSON." sudo-ai routes those lanes in production, so this is not obsolete — it is *correctly scoped* scaffolding. Design contract is safe (a repair is accepted only if it actually parses). Kill trigger: the day no non-native-tool-call route exists. |
| S-U5 | `src/core/agent/laziness-nudge.ts` (231 lines) | Classifies the agent as "lazy" (talks but doesn't act) and injects proactivity nudges. Explicitly "Grok Build CLI parity" | **Live**: `loop.ts:130`, `loop-injections.ts:31`, own test file | **NEEDS-MEASUREMENT.** Classic weak-model compensation; frontier models are far less prone to text-only stalls. But it is also an autonomy safety net for *long* runs, which is a different failure mode than model weakness. Measure nudge-fire rate per model on the current routes: if it fires ~never on opus-5/sonnet-5, gate it to the weak lanes rather than delete it. |
| S-U6 | `src/core/agent/rationalization-guard.ts` (241 lines) | Pattern list of ways "LLMs rationalize skipping safety checks" | Live (1 src importer, tests) | **KEEP.** Safety-side, cheap, and the failure it guards is not one that model strength removes — stronger models rationalize *more* fluently, not less. |
| S-U7 | `src/core/agent/universal-negative-guard.ts` (290 lines) | Mechanically scans final answers for unqualified universal-negative claims and triggers one bounded self-revision | Live (1 src importer, tests) | **KEEP.** The file's own header records that the prompt-only version was **live-proven insufficient** — a measured result, not a guess. This is the doctrine's own standard for when structural scaffolding is justified. |
| S-U8 | `src/core/brain/negative-router.ts` (362 lines) | 3-tier routing: Tier-0 regex DFA and Tier-1 weighted keyword/bigram scoring route/block/redirect **before any LLM call**; Tier-2 falls back to LLM classification | Live (6 src importers, tests) | **NEEDS-MEASUREMENT.** Tiers 0/1 are latency/cost optimizations, not capability substitutes — that is a legitimate reason to keep handcrafted logic. The measurable question is Tier-1's *disagreement rate* with Tier-2 on real traffic. If Tier-1 is frequently overridden, it is buying 200ms at the price of wrong routes. |
| S-U9 | `src/core/agent/complexity-scorer.ts` (129 lines) + `src/core/agent/task-decomposer.ts` (255 lines) | Heuristic complexity score picks `suggested_max_tokens`; decomposer breaks "complex" requests into numbered subtasks "to prevent LoopGuard triggers" | Live (6 / 1 src importers) | **NEEDS-MEASUREMENT.** The token-budget half is legitimate cost control. The decomposition half is the bet against the model — frontier models plan multi-step work natively. Note the decomposer already only fires an LLM micro-call *after* the heuristic gate, so cost is bounded. |
| S-U10 | `src/core/brain/tool-schema-compat.ts` (142 lines) | Strips JSON-Schema keywords (`minLength`, `maxItems`, …) that xAI's function-calling validator rejects; `sanitizeOAuthToolName` lifts the Anthropic `mcp_` prefix reservation | Live: `transport.ts:90`, tests | **KEEP, but MARK.** This is a *provider API* workaround, not a model workaround — exactly the population the `SCAFFOLD:` marker should cover and currently doesn't. Without it, real agent turns to `xai/*` return HTTP 400. |
| S-U11 | `src/core/tools/native-tool-correction.ts` (381 lines) | Glob/prefix mapping table redirecting MCP tool calls to native SUDO equivalents when the MCP call fails | Live but **default-off**: `registry.ts:407` — "used only when `SUDO_NATIVE_TOOL_CORRECTION_FALLBACK=1`" | **KEEP (dormant).** Off by default, so it costs nothing at runtime. Do not delete: it is a working capability behind a flag. Revisit only with the owner. |
| S-U12 | `src/llm/rephrase-heuristic.ts` (28 lines) | Jaccard word-similarity says "the user rephrased, so the last answer failed" — an outcome signal derived from a bag-of-words overlap | Live: `logging.ts:262` → `loop.ts:1682`, fail-open, off with `SUDO_GATEWAY_LOG=0` | **KEEP.** 28 lines, fail-open, feeds outcome telemetry only. Upgrade path (embedding similarity instead of Jaccard) is cheap now that embeddings are local and $0 — but that is an improvement, not a deletion. |

---

## 3. What this PR actually deletes, and the evidence

### S-U1 — `src/core/agent/response-compressor.ts` (DELETED)

Why it is scaffolding: it exists to clean up model prose ("Got it!", "Sure!",
"Let me…") and to truncate long answers — a bet that the model cannot be
concise. Its own regexes would also strip legitimate sentence openers
(`/^(let me|i'll|i will|okay|alright|right)[,\s]*/i`), i.e. if it were ever
wired in it would mangle correct output.

Why deleting it is safe — repo-wide grep over `*.ts *.tsx *.mts *.mjs *.js
*.json *.md`, excluding `node_modules/` and `graphify-out/`:

```
$ grep -rn "compressResponse\|removeFiller" ... .
src/core/agent/response-compressor.ts:73:export function compressResponse(...)
src/core/agent/response-compressor.ts:75: log.warn(... 'compressResponse: ...')
src/core/agent/response-compressor.ts:149:export function removeFiller(...)
src/core/agent/index.ts:45:export { compressResponse, removeFiller } from './response-compressor.js';
```

Four hits: three self-references and one barrel re-export. Zero call sites,
zero tests.

**Instrument validated with a positive control** (an empty grep is not
evidence): the same command shape for a symbol known to be live,
`classifyIntent`, returned 15 hits. The search works.

Not public API either: `package.json` exports only `"." -> dist/server/cli.js`
and `"./cli"`; `src/core/agent/index.ts` is an internal barrel, not a published
entry point. So removing the barrel line cannot break a downstream consumer of
the npm package.

Reversibility: one file plus one export line. `git revert` restores it whole.

Verification run in this worktree:

- `npx tsc --noEmit -p tsconfig.json` → `TSC_EXIT=0`
- `pnpm check:arch` → `ARCH_EXIT=0` (max-lines ratchet OK, 180 tracked files;
  flag-manifest up to date, 820 flags; 3 architecture test files, 19 tests pass)
- `npx vitest run tests/agent tests/tools/json-repair.test.ts
  tests/brain/tool-schema-compat.test.ts` → **140 files, 1625 tests passed**

Nothing else is deleted in this PR. Every other candidate is a recommendation.

---

## 4. Recommendations for the owner (no code changed for these)

1. **Retarget the `SCAFFOLD:` marker.** As written, doctrine #2 says the marker
   covers "a workaround for a current *model* limitation". In practice 9/9
   markers are *vendor-API* workarounds, and 12/12 model workarounds are
   unmarked. Either widen the marker to two kinds (`SCAFFOLD(model):` /
   `SCAFFOLD(vendor):`) or add a second marker. Without this, the next sweep
   finds the same wrong population.
2. **Add a marker-lint to `check:arch`.** There is no check enforcing doctrine
   #2 today, which is why this sweep had to be done by hand.
3. **S-U2 `special-requests.ts`:** dead by the same evidence as S-U1 — owner's
   call, not executed here.
4. **S-U3 `intent-classifier.ts`:** the highest-value measurement in the repo.
   A/B the hint on real turns before touching it, and remember the
   self-improvement engine writes into it.
5. **S-U5 / S-U8 / S-U9:** gate to weak lanes rather than delete, if the
   measurements show frontier models never trip them.
6. **S-U10:** mark it, don't cut it.

## 5. Method, and what was NOT verified

- Marker enumeration is exhaustive over the listed extensions; it would miss a
  marker written in a file type not in that list (e.g. `.rs`, `.go`, `.yaml`).
- The unmarked-scaffolding list in §2 is **representative, not exhaustive**. It
  was assembled from targeted searches for the categories named in the doctrine
  (keyword/regex classifiers, repair chains, retry ladders, output parsers). A
  broader unreferenced-export scan across `src/` surfaced ~801 exported symbols
  with no non-barrel reference — the overwhelming majority are legitimate tool
  definitions reached through registries and test-only reset hooks, so that scan
  is **not** a deletion list and was not used as one.
- Reference counting is static (`grep` + an AST-free export scan). It cannot see
  dynamic dispatch, string-keyed registries, or reflection. For S-U1 this was
  mitigated by the fact that the symbols are plain function names with zero
  textual occurrences anywhere outside their own file and one barrel line.
- **No runtime/production validation was performed for this audit.** The
  deletion is proven by static reference analysis + typecheck + arch checks +
  1625 targeted tests, not by a live Telegram→SUDO AI turn. That is the weakest
  point of this PR.
- The Grok/statsig lane (S-M8, S-M9) was read but deliberately not exercised or
  modified.
