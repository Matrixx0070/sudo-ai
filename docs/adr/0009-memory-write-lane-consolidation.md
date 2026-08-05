# ADR 0009 — Memory-write-lane consolidation (one guarded MemoryWriter)

- **Status:** Proposed (no lane is removed by this ADR; the two clear-cut bug-fixes it cites already shipped separately)
- **Date:** 2026-08-05
- **Deciders:** Frank (owner) — this ADR only *proposes*; the MEMORY.md ownership change and any lane migration need his GO
- **Related:** SIGNALS.md 2026-07-31 (the originating observation); doctrine #4 (capability > feature, platform > tool), #5 (simplicity), #6 (architecture emerges — justify the facade); memory invariant #2 (quarantine everything); ADR 0005 (same "one primitive, many wrappers" instinct, applied to tools)

## Problem

A "remember this" fact can be persisted through **four independent storage backends with no shared write API and no routing policy**. The same request lands in different stores nondeterministically (three consecutive live probes 2026-07-31 produced knowledge.graph, then meta.self-modify, then knowledge.graph for identical prompts — the originating SIGNALS entry).

The four write surfaces (verified by reading each call site):

| Store | Written by | Guard on write? |
|---|---|---|
| `mind.db` → `chunks` | `MindDB.storeChunk` (14 files) **and** AutoDream raw SQL (`auto-dream.ts:415`) | guard only on the `storeChunk` path |
| `kg_nodes` (knowledge.db) | `knowledge.graph` + `knowledge.zettelkasten` tools | none |
| `structured-memory/*.json` | `saveMemory` (12 files) | its own `shouldSaveMemory` heuristic |
| `workspace/MEMORY.md` | AutoDream (append) + `meta.memory-consolidate` (LLM rewrite) + `meta.self-modify` (arbitrary edit) | none |

Three concrete defects this sprawl has already produced — not tidiness complaints:

1. **Injection-guard bypass (FIXED, commit 196dbc1c).** `auto-dream.ts` wrote learning facts via raw `INSERT INTO chunks`, sidestepping `guardMemoryWrite`, which `MindDB.storeChunk` runs and the codebase's own rule requires (`brain-serializer.ts:16` "never raw SQL"). Since ~all learning facts flow through AutoDream, the highest-volume writer was an injection blind spot (invariant #2). Now guarded in-place.
2. **Dead translator mappings (FIXED, commit 196dbc1c).** `tool-translator.ts` mapped Hermes `memory_read`/`memory_write`/`memory_delete` to `memory.read`/`write`/`delete` — none registered (only `memory.get` + `memory.search` exist, both read-only). Translated calls faked success then failed deep. Now `memory_read → memory.get`; write/delete left honest-unmapped pending a canonical write tool (this ADR).
3. **Systematic dual-write (OPEN).** The Drive/NotebookLM pipelines write the *same fact twice* — `storeChunk('learning')` then `saveMemory('reference')` back-to-back (`returns.ts:192→195`, same pattern in `routes-n1`, `curiosity`, etc.). One fact, two stores, two different dedup policies.

Plus the originating symptom: interactive "remember this" is routed only by a keyword boost of the `knowledge` category (`tool-router.ts:468`), so nothing decides which store is canonical — the model's tool choice does, per-turn.

## Alternatives considered

- **A. Status quo.** Rejected. Each lane is an uninstrumented blind spot by default (auto-dream and the dead mappings were two; more will appear), and invariant/guard coverage must be re-proven per lane forever.
- **B. Routing policy only** — keep all backends, add a policy that picks one for interactive writes. Partial: fixes the nondeterministic-routing symptom but not the dual-write duplication or the guard/instrumentation-per-lane class of bug.
- **C. Single `MemoryWriter` facade (recommended)** — one write chokepoint that every lane (interactive tool + autonomous pipeline) calls; it guards, admits (near-dup), publishes the event, and owns a single canonical store; the other stores become *projections* derived from it, not independent writers.
- **D. Collapse to one physical store; delete kg_nodes + structured-memory.** Too aggressive / drops capability. `kg_nodes` serves graph traversal reads and `structured-memory` serves Drive zone-metadata reads — both real. Keep them as facade-owned projections, not writers.

## Decision (proposed)

Introduce **`MemoryWriter`** as the single write path for facts:

- **Mandatory guard + admission.** Every write runs `guardMemoryWrite` and near-dup admission — no raw-SQL or direct-store escape hatch survives (the auto-dream and dual-write patterns fold into one guarded call).
- **One canonical store** (`mind.db chunks`). `kg_nodes` and `structured-memory` become **projections** the writer derives, replacing the current back-to-back dual-writes with one write + declarative projection — killing defect #3.
- **Event bus by default.** The writer always publishes `memory.created`, so a new lane is instrumented the moment it calls the facade (closing the "each new lane is a blind spot" root cause).
- **Expose one interactive write tool** (`memory.write`) so the model has a single, obvious target — and restore the Hermes `memory_write` translator mapping to it (defect #2's deferred half).
- **MEMORY.md becomes a projection, single-owner.** It is *rendered* from the canonical store, not independently written. `meta.memory-consolidate` becomes a re-render, and `meta.self-modify` loses MEMORY.md write rights (or keeps them only as a `// SCAFFOLD:`-marked escape hatch). **This ownership change is the one decision that needs Frank's explicit GO** — three writers with incompatible semantics (append / LLM-rewrite / arbitrary edit) collapse to one.

## Tradeoffs

- **Migration surface:** ~14 `storeChunk` + ~12 `saveMemory` call sites move behind the facade. Mechanical but broad; do it as flag-gated slices, not a big bang.
- **Projection consistency is eventual,** not transactional — a reader hitting `kg_nodes` between write and projection sees staleness. Acceptable for memory (already eventually-consistent via decay/dream), but must be stated.
- **MEMORY.md ownership change can break existing `meta.self-modify` workflows** that hand-edit it. Mitigated by the SCAFFOLD escape hatch and a deprecation window.
- **Near-term cost** for a benefit that compounds later — classic platform-over-tool trade (doctrine #4).

## Consequences

- One guard chokepoint; invariant #2 holds by construction, not by per-lane audit.
- Dual-write duplication eliminated; one fact, one canonical row, N derived projections.
- Interactive "remember this" becomes deterministic (one tool, one store).
- Every future memory lane is instrumented and guarded by default — new blind spots become impossible without deliberately bypassing the facade.
- Until adopted: the two shipped fixes hold the line, and this ADR is the reference for why any new memory writer must route through `storeChunk`/the facade, never raw storage.
