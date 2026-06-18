# eval-baselines

Committed baselines for the eval regression gate (`.github/workflows/eval-gate.yml`).

Each file is a JSON envelope produced by `scripts/eval-gate.mts --update-baseline`:

```json
{
  "version": 1,
  "savedAt": "2026-06-18T00:00:00.000Z",
  "summary": { "runId": "...", "tasks": [ ... ], "passRate": 1, ... }
}
```

The `summary` is a `RunSummary` from `src/core/eval/bench-regression.ts` — a
per-task roll-up plus derived `passRate`, `meanScore`, `passesPerDollar`, and
`passesPerMinute`. The gate compares a fresh run against this snapshot and fails
on a quality regression (any pass-rate drop or `pass→fail` task flip by default).

## Files

- `agent.json` — baseline for the agentic suite (`scripts/agent-bench-run.mts`,
  `AGENT_BENCH_TASK=all`). Generated, not hand-edited.

## Refreshing a baseline

Run the gate workflow with `update_baseline=true`, download the
`eval-gate-report` artifact, and commit the regenerated `agent.json`. Updating
the baseline is a deliberate, reviewed act — it redefines "passing", so it
should land in its own commit with the reason stated.

A baseline that does not exist yet is not an error: the gate reports
`🟡 NO BASELINE`, passes, and prompts you to capture one.
