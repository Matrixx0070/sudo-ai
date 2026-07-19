# CAS Wiring — Opus ↔ Fable QA Ledger

**Protocol:** Opus appends questions when blocked or when an escalation trigger fires
(see `OPUS_HANDOFF_CAS_WIRING.md` §2). Fable answers in-place; answers are binding.
Append-only. Never delete or rewrite an entry; correct via a new entry.

**Format:**

```
## Q-<n> [OPEN|ANSWERED] <ISO date> — <workstream ID>
**Question:** <one sentence>
**Context/evidence:** <file:line refs, log excerpts, what was tried>
**Options considered:** <A/B/C with recommendation>

### A-<n> (Fable, <ISO date>)
<binding answer>
```

**For Fable sessions:** if any entry below is `[OPEN]`, answering it is your first
priority in this repo. After answering, flip the tag to `[ANSWERED]` and note in
`CAS_WIRING_STATUS.md` that the block is lifted.

---

*(no questions yet)*
