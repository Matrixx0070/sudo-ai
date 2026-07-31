# Ladder rung 1 — tool-schema conformance (ADR-0002)

Golden set for rung 1: given a declared tool schema, does the route emit a
conformant tool call? Shapes are adapted from the gateway-e2e scenarios and the
grok-web-tools probes (single-tool call, required params, primitive types,
nested object args, enum values). Code-graded (rungs 0–3 per ADR-0002).

Format (`golden.json`): array of `{id, input, expect}` —

- `id` — unique stable string per item.
- `input` — user message plus an inline description of the tool the route may
  call (the grading engine registers the tool for the turn).
- `expect` — rung-1 check descriptor:
  - `toolCalled: "<name>"` — the named tool was invoked.
  - `paramsInclude: { key: value }` — the tool-call args include these
    key/value pairs after JSON parsing.
  - `paramTypes: { key: "string"|"number"|"boolean"|"object" }` — declared
    primitive types are respected (no stringified numbers/booleans).

Loader: `src/core/eval/sandbox/ladder.ts` (`loadGoldenSet(1)`); the rung
grading engine is the next slice — `runLadderRung(1, route)` is a documented
stub until it lands.
