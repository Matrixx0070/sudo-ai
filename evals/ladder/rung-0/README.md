# Ladder rung 0 — basic response validity (ADR-0002)

Golden set for the lowest Verifiability Ladder rung: does the route return a
well-formed, on-instruction response at all? Every item is code-gradeable
(rungs 0–3 are code-graded per ADR-0002; no LLM judge involved).

Format (`golden.json`): array of `{id, input, expect}` —

- `id` — unique stable string per item.
- `input` — the exact user message sent to the route under test.
- `expect` — rung-specific check descriptor. Rung-0 checks:
  - `nonEmpty: true` — reply is non-empty text.
  - `outputContains: "<substr>"` — reply contains the substring (case-insensitive).
  - `outputMatches: "<regex>"` — reply matches the regex (case-insensitive).
  - `jsonParses: true` — reply parses as JSON.

Loader: `src/core/eval/sandbox/ladder.ts` (`loadGoldenSet(0)`); the rung
grading engine is the next slice — `runLadderRung(0, route)` is a documented
stub until it lands.
