# LLM gateway conformance suite (gw-refactor Phase 6)

A file-based golden matrix run against every gateway adapter. It EXTENDS the
behavioural unit tests in `tests/llm/adapters/*.test.ts` — do not delete those;
this suite pins the exact wire shapes as committed JSON.

## Layout

```
tests/conformance/
  harness.ts            # case lists + golden I/O (stable stringify, digests)
  conformance.test.ts   # the vitest matrix + targeted invariants
  goldens/<adapter>/<case>.json
```

Adapters (golden directories):

| Adapter            | Function under test                          |
|--------------------|----------------------------------------------|
| `egress-openai`    | `egressOpenAI(ir)` → request body             |
| `egress-anthropic` | `egressAnthropic(ir)` → request body          |
| `parse-openai`     | `parseOpenAIResponse(wire)` → IRResponse      |
| `parse-anthropic`  | `parseAnthropicResponse(wire)` → IRResponse   |
| `ingress-openai`   | `ingressOpenAI(body, meta)` → IRRequest       |
| `stream-openai`    | OpenAI SSE machine → IRStreamEvent[]          |
| `stream-anthropic` | Anthropic SSE machine → IRStreamEvent[]       |
| `transport`        | `callIR(ir)` against an in-process fetch stub → `{wire_request, ir_response}` (gw-cutover Phase 0) |
| `errors`           | classifyHttpError / classify*Response / classifyThrown → `{class, retryable}` |

## Running

- `pnpm conformance` (or plain `pnpm vitest run tests/conformance`, and it is
  part of `pnpm test`): asserts every adapter output deep-equals its committed
  golden. A **missing** golden is a failure telling you to run update mode.
- `pnpm conformance:update`: sets `CONFORMANCE_UPDATE=1`, which makes the SAME
  vitest run **write** `goldens/**` instead of asserting. Review the git diff
  before committing — a golden change is a wire-shape change.

## Rules

- Goldens are stable-stringified (recursively sorted keys, 2-space indent) so
  diffs are deterministic.
- Outputs whose stable JSON exceeds **32 KB** are stored as a digest
  `{"__digest": true, "bytes": N, "sha256": "..."}` (see the `context-100k`
  case) — the digest still fails loudly on any byte change without committing
  ~400 KB of JSON.
- Fixtures use the model id `testprov/conformance-model-1`, which is unknown to
  `aliases.ts`/`limits.ts`, so no `LLM_ALIAS_*` env override can change a golden.
- Invariants a golden cannot express live as explicit tests in
  `conformance.test.ts`: tool-schema byte-exact round trip (ingress→egress),
  the 100k-context `estimateTokens` ±15% window plus no-truncation spot checks,
  and RULE 4 stream-abort single-use enforcement.

## CI

`.github/workflows/ci.yml` runs the full test suite (which includes this
directory) plus an explicit labeled `Conformance` step on pushes and PRs to
`main` and `gw-refactor`.
