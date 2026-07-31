# SIGNALS

Evidence of the system being used beyond its intended design (Engineering
Doctrine §9). Format: `date | observation | evidence | possible opportunity`.

2026-07-31 | The agent has at least three distinct memory-storage lanes and picks between them nondeterministically for the same "remember this" request: knowledge.graph (kg_nodes), meta.self-modify (file-based MEMORY.md-style writes), and MindDB.storeChunk 'learning' facts — plus the structured-memory API used by Drive/NotebookLM lanes. | Unified event log (/v1/events), three consecutive live probes 2026-07-31 14:38Z / 14:51Z / 15:11Z: identical "remember" prompts produced tool.completed for knowledge.graph, then meta.self-modify+system.exec, then knowledge.graph again. | Consolidate to one memory-write API (capability > feature) or at least one routing policy; until then, event instrumentation and invariant enforcement must cover every lane separately — each new lane is an uninstrumented blind spot by default.
