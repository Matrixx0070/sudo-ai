# ADR-0008: Consolidate the memory-write lanes behind one API

Status: **Proposed** — FRANK GATE. No code changes ride this ADR.

Date: 2026-07-31

## Problem

Three live probes on 2026-07-31 (14:38Z, 14:51Z, 15:11Z) sent the agent the
same request — "remember this fact" — and watched the unified event log
(`/v1/events`, shipped that day). The agent used a **different storage lane
each time it was free to choose**: `knowledge.graph` add-node, then
`meta.self-modify` + `system.exec` file writes, then `knowledge.graph` again.
SIGNALS.md entry 2026-07-31 records the observation.

Inventory of write lanes that all mean "the agent remembers something":

| # | Lane | Store | Written by |
|---|------|-------|-----------|
| 1 | `MindDB.storeChunk` | `mind.db` chunks (+ 2 vec tables) | auto-dream Phase 2 facts, gdrive/nlm learning returns, auto-summarizer |
| 2 | `structured-memory` saveMemory/deleteMemory | JSON files per type | Drive lanes (curiosity, inbox, dead-ends, prospective), NotebookLM returns |
| 3 | `KnowledgeGraph.addNode/addEdge` | `kg_nodes`/`kg_edges` | `knowledge.graph` tool (agent-interactive) |
| 4 | `Zettelkasten.create/link` | zettel store | `knowledge.zettel` tool |
| 5 | `workspace/MEMORY.md` + guidance files | flat files, injected each turn | `meta.self-modify` (agent-interactive) |

Costs, all live-observed or already paid once:

- **Every cross-cutting concern multiplies by 5.** Event instrumentation
  needed three separate PRs (#1044 lane 2, #1045 lanes 1+3) and lanes 4–5 are
  still blind spots. The same multiplication applies to the F18 quarantine
  convention, injection guards (`guardMemoryWrite` covers lanes 1–2 only),
  near-dup admission (#1024 covers lane 1 only), contradiction/supersede
  (SUDO_MEMORY_SUPERSEDE, lane 2 only), ZDR (lane 2 only), decay/evergreen
  (lane 1 only), and invariant 9's two-reader consensus for memory surgery.
- **Retrieval is fragmented the same way**: two vec tables that cannot be
  cross-queried (see project-local-embeddings), kg/zettel searched only via
  their own tools, MEMORY.md injected wholesale. A fact's retrievability
  depends on which lane the model happened to pick when storing it.
- **Nondeterministic behavior**: the same user intent lands in stores with
  different durability, retrieval, and governance properties, chosen by
  per-turn model whim.

## Comparison point

Claude Code has exactly one agent-facing memory-write surface (auto-memory
files with an index), and its harness enforces format/caps at that single
seam. sudo-ai's own event system (ADR-adjacent work, PRs #1037–#1045) got its
leverage the same way: ONE bus, publish once, every consumer downstream.
Memory writes are the same shape of problem.

## Alternatives

**A. Status quo + per-lane patching.** Keep 5 lanes; extend each control to
each lane as gaps surface. Rejected direction: the 3-PR instrumentation
campaign just demonstrated the O(lanes × concerns) cost, and every new lane
(there was no process stopping lane 5 from appearing) resets the work.

**B. Single choke-point API, stores unchanged (RECOMMENDED).** Add
`memory-write.ts`: one `writeMemory(intent)` entry that runs the shared
pre-write pipeline ONCE — injection guard → zone/ZDR check → near-dup
admission → event publish — then routes to the existing store by declared
intent (`fact | node | note | guidance | structured`). Existing stores and
schemas untouched; callers (tools, dream, gdrive/nlm lanes) migrate
incrementally; direct store writes outside the API become a lint/architecture
test violation (like the gdrive hot-path test). The agent-facing tool surface
shrinks to one `memory.remember` tool that takes intent, aligning with
ADR-0005's tool-sprawl direction.

**C. Full store unification (one schema, one DB).** Migrate kg/zettel/
structured/MEMORY.md into mind.db with typed rows and one vec index.
Maximum simplification, but it is a data migration across live stores with
retrieval-behavior changes — weeks of work and real regression risk to
prod recall (which was just tuned: #1023–#1025). Not justified until B's
choke point exists and shows which stores still earn their keep.

**D. Routing policy only (prompt/tool-description steering).** Tell the model
which tool to use for which memory kind. Cheapest, but bets against nothing —
it leaves every governance gap open and history (three different lanes in
three probes) shows steering alone does not produce determinism.

## Decision (proposed)

Alternative **B**, in three flag-gated slices:

1. **B1 — choke point + events + guards**: `writeMemory()` with the shared
   pipeline; migrate the interactive tools (`knowledge.graph` add-node,
   `knowledge.zettel` create, the meta.self-modify memory path) to call it.
   Architecture test: no new direct-store imports outside the API.
2. **B2 — background lanes**: migrate dream/gdrive/nlm callers; retire
   per-lane duplicate guards where the pipeline now covers them (deletion is
   progress; capability preserved — same stores, same data).
3. **B3 — evaluate C** with 30 days of choke-point telemetry (per-lane write
   volumes now visible on the event bus for free): keep, merge, or retire
   stores based on measured use, under invariant 9's consensus rules for any
   surgery.

## Tradeoffs

- One more abstraction (the API) — justified only because it deletes ≥4
  duplicated control implementations and closes 2 uninstrumented lanes; if B2
  doesn't retire the per-lane guards it replaced, the abstraction failed and
  should be removed.
- Slight latency on interactive memory writes (pipeline is local-only:
  regex guard + sqlite near-dup + 2 sqlite event writes; no network, no
  model calls — sub-ms in practice, and writes are not on the retrieval hot
  path).
- Migration touches the tool surface — needs the usual live tool-choice
  verification (lesson: tests alone don't prove the agent picks the tool).

## Consequences

- Every future memory control (quarantine tiers, decay, consensus surgery,
  zone assertions) is written once at the choke point instead of five times.
- `memory.*` events become complete and trustworthy — the observability that
  exposed this problem stops having blind spots.
- The store zoo becomes measurable, making B3/C a data-driven decision
  instead of a taste-driven one.
- Frank gate: this ADR proposes; nothing executes without GO. Estimated
  scope: B1 ≈ one PR-day, B2 ≈ one PR-day, B3 = decision review only.
