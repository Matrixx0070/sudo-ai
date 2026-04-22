# Wave 10C Briefing

**Delivered by Scout 2026-04-19.**

## Project State
- Tests: 3479 pass / 0 fail / 3 skipped (post Wave 10B-Activation)
- pm2 prod: sudo-ai-v5 port 18900, PID 2042660
- pm2 stage: sudo-ai-v5-staging port 18901 (48h seal soak in progress, criterion #5 MET)

---

## Item 1 — Unbounded arrays (MEDIUM security)

### SkillDiscovery.records[]
- File: `/root/sudo-ai-v4/src/core/learning/skill-discovery.ts`
- Line 57: `private readonly records: ToolCallRecord[] = [];`
- Line 74: `this.records.push({...})` inside `recordToolCall()`
- No cap, no eviction. Array grows for lifetime of process.

### AgentConfigEvolver.traces[]
- File: `/root/sudo-ai-v4/src/core/learning/agent-config-evolver.ts`
- Line 56: `private readonly traces: TraceInput[] = [];`
- Line 85: `this.traces.push(trace)` inside `recordTrace()`
- Pre-filter at line 84 (`if (trace.quality < 0) return`) does not bound the array.

---

## Item 2 — _isSuccess misclassification (LOW data-integrity)

- File: `/root/sudo-ai-v4/src/core/agent/loop.ts`
- Line 548: `const _isSuccess = !(typeof _tr.result === 'string' && _tr.result.startsWith('Error'));`
- Bug: when `_tr.result` is an object like `{error: "..."}`, `typeof` is `'object'` → `_isSuccess = true` (false positive).
- Context: `_tr.result` is typed `unknown`; tools can return strings OR objects. Object-shaped errors are common.
- Downstream: corrupts `quality` at line 561 (`_quality = _w10bToolSuccessCount / _w10bToolCallCount`), biasing proposals.

---

## Item 3 — skillIdForTool stub (functionality gap)

### Stub location
- File: `/root/sudo-ai-v4/src/core/tools/registry.ts`
- Lines 209-212: `skillIdForTool(name: string): string | null { void name; return null; }`
- Called from `/root/sudo-ai-v4/src/core/agent/loop.ts` lines 562-563 (duck-typed optional call via `?.`)

### Two skill-loading paths — architect must choose

**Path A: flat skills/*.md (in-memory only)**
- Loader: `/root/sudo-ai-v4/src/core/skills/markdown-loader.ts` line 117
- Parses `allowed-tools: [tool1, tool2]` into `MarkdownSkill.allowedTools?: string[]`
- Loaded in cli.ts line 1766 via `loadMarkdownSkills(path.resolve(process.cwd(), 'skills'))`
- 33 flat skills confirmed to have `allowed-tools` frontmatter
- Sample: `skills/gmail.md` → `allowed-tools: [comms.gmail-send, comms.gmail-read, web.fetch]`
- NOT persisted to SQLite

**Path B: src/core/skills/**/SKILL.md (SQLite persisted)**
- Loader: `/root/sudo-ai-v4/src/core/skills/registry.ts` line 159 (`scanBundledSkills`)
- 5 bundled SKILL.md files: `web-summary`, `cron-health`, `self-diagnostic`, `daily-brief`, `viral-hook`
- NONE carry `allowed-tools` frontmatter (grep confirmed zero hits)

### Open question for architect
- Return type is `string | null` (singular). Multiple flat skills share tools (e.g. `memory_search` in 8+ skills). Tie-breaker rule needed.
- Must also decide: index build at startup (sync scan) vs lazy/on-demand.

---

## Existing Cap Conventions (5 live templates)

| Pattern | File | Style |
|---|---|---|
| `MAX_PER_TOOL = 200` + `bucket.splice(0, bucket.length - MAX_PER_TOOL)` | `src/core/learning/failure-learner.ts` line 33/73 | Array splice, same module |
| `MAX_ENTRIES = 10000` + `splice(0, EVICT_COUNT)` batch | `src/core/health/metrics.ts` lines 119-122 | Batch eviction on push |
| `if (this.observations.length > 500) this.observations = this.observations.slice(-500)` | `src/core/consciousness/kairos.ts` line 538 | Inline slice-assign |
| `MAX_RL_WINDOWS = 50_000` + `evictRlMap()` when `>= RL_EVICT_AT (0.8)` | `src/core/skills/registry-route-types.ts` lines 104-120 | Separate eviction function |
| `MAX_HISTORY = 60` + `.slice(-MAX_HISTORY)` | `src/cli/commands/chat/App.tsx` line 50/546 | Slice on mutation |

---

## Relevant Test Files

- `/root/sudo-ai-v4/tests/learning/skill-discovery.test.ts`
- `/root/sudo-ai-v4/tests/learning/agent-config-evolver.test.ts`
- `/root/sudo-ai-v4/tests/learning/wave10b-activation.test.ts` — Test 6 asserts `skillIdForTool` returns null (must update when stub replaced)
- No existing test in `tests/tools/` covers `registry.ts` skillIdForTool

---

## Known Blockers / Watch-outs

1. **Two-source ambiguity**: flat `skills/*.md` has `allowed-tools` data but in-memory-only; bundled `SKILL.md` files have SQLite persistence but zero `allowed-tools`. Architect must pick the data source first.
2. **Fan-out policy undefined**: multiple skills map to same tool. Architect specifies tie-breaker.
3. **Test 6 in wave10b-activation.test.ts** flips red once real index built. Builder must update.
4. **records/traces are `readonly` arrays** — `readonly` on reference not contents. splice/length=0/push all work.
5. **recordToolCall is fail-open in loop.ts** — cap inside SkillDiscovery is sufficient; no loop.ts changes for Item 1.
6. **Staging is in 48h soak** — do NOT `pm2 reload sudo-ai-v5-staging` during this wave. Prod reload only.

---

## Stack
- TypeScript ESM, Node 22, pnpm, vitest, better-sqlite3, pm2
- Tool naming: `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$`
- Auto-discovery loader (zero cli.ts edits if duck-typed setters used)
- `_testOnly_*` exports gated with `NODE_ENV !== 'test'`

---

## TL;DR for Architect

- Item 1 (cap): `skill-discovery.ts:74` and `agent-config-evolver.ts:85` push to unbounded arrays; 5 cap patterns available, pick a style.
- Item 2 (isSuccess): `loop.ts:548` only catches string errors; object `{error: "..."}` miscounted — add object check.
- Item 3 (reverse index): `registry.ts:209` stub always null; **BLOCKER** — 5 bundled SKILL.md have no `allowed-tools`, but 33 flat skills/*.md do. Architect must pick source + fan-out tie-breaker.
