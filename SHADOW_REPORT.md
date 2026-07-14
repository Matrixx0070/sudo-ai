# SHADOW_REPORT — gw-refactor Phase 7

**Verdict: PASS** — material divergence 0.000% over 341 comparisons (threshold: < 1%).

Method (A19, PROGRESS.md): NO dual provider calls. The shadow compares
TRANSFORMATIONS on the same data — the legacy BrainRequest is mapped to IR and
egressed through the matching adapter, then the wire body's semantic content
(message count after folding, concatenated user/assistant/system/tool-result
text, tool names + schemas, max_tokens/temperature) is diffed against the
original legacy inputs. The response side round-trips the legacy result through
resultToIR and diffs stop-reason class, exact text, tool-call name/args, and
usage (±10% tolerance).

## Replay (recorded prod traces, zero cost / zero side effects)

- Source: `/root/sudo-ai-v4/data/traces.db` (read-only), 500 most recent `brain_call` traces with `prompt_raw`
- Generated: 2026-07-14T09:39:07.537Z
- Replayed: **303** — material: **0** (0%)
- Skipped: truncated_prompt_raw=197, bad_prompt_json=0, no_model=0

### Response-side coverage limits (traces.db)

usage and toolCalls are not stored in traces.db — skipped; text compared only when finishReason=stop and response_raw not truncated.
Text compared on 45 rows, skipped on 258.

### Material divergences by field

_none_

### Example material traces (ids + field names only)

_none_

## Live shadow (gateway.db, LLM_SHADOW=1)

- Rows: **38** — divergent: **0**, match: **38**
