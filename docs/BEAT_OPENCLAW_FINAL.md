# BEAT OPENCLAW — Final Report

Autonomous execution of the §12 plan from `docs/OPUS_HANDOFF_BEAT_OPENCLAW.md`.
Target: SUDO-AI beats OpenClaw 2026.7.1-2 on every measurable point. All work
was built in per-workstream worktrees off `origin/main`, tests-green, merged, and
**live-deployed to the prod daemon** (`sudo-ai-v5`), with cited evidence per row
in `docs/BEAT_OPENCLAW_SCORECARD.md`.

## Outcome: 16 of 18 rows green; the 2 remainders are one operator decision

| Bucket | Rows | State |
|---|---|---|
| ✅ Green (cited, live-verified) | S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14, S15, S16, S17 | **16** |
| 🟡 Partial | S18 (2-of-3: success + latency win; cost/msg gated on S1) | 1 |
| ⛔ Needs Frank | S1 (code-complete; ≥90% needs the context-window decision) | 1 |

**S1 and S18's remaining gap are the SAME decision** — the context-window vs
cache tradeoff (#448). One call from you closes both.

## What shipped (workstreams BO1–BO14, PRs #838–#851, all merged to main + deployed)

- **BO1 (S9)** measurement harness — per-turn prompt report (section chars+sha256,
  no raw text) + stable-prefix-churn detector + cache-share tool.
- **BO2/BO2b (S1)** cache discipline — agent system prompt now **byte-stable**
  (1 sha256 over 50 turns; dynamic content ~20k→1073 chars); per-turn churn
  relocated to the message tail; **S16 learning gate green (2238/2238)**.
- **BO3 (S2)** policy-digest truncation + missing-file markers + truncation
  warnings — a hard rule survives 4.1× over-budget.
- **BO4 (S4,S5)** per-session-type prompt profiles (subagent/cron **~67% token
  cut**) + empty-heartbeat model-call skip.
- **BO5 (S11)** prompt-literal sanitization at interpolation seams (adversarial
  bidi/zero-width/control-char identifier neutralized).
- **BO6 (S3)** skill catalog (≤30 tok/skill, byte-stable) + `skill.read`
  on-demand + version-hash, deterministic triggers kept (hybrid).
- **BO7 (S6)** /status card on Telegram + SPA + admin.
- **BO8 (S7)** usage drill-down — **0.000000% ledger drift** over 6,602 rows.
- **BO9 (S8)** sessions table + fork + **archive-with-confirm** (beats OpenClaw
  defect).
- **BO10 (S10)** guidance-file UI + gated hash-audited writes; frozen identity
  files read-only (invariant 4, triple-gated).
- **BO11 (S13,S14)** live working-states (SPA phases + elapsed + model/context
  chip, live-verified over a real WebSocket) + whimsy (SUDO_WHIMSY).
- **BO12 (S12)** deterministic **zero-spend** `sudo-ai onboard` + hash-audited
  config writes.
- **BO13 (S17)** defect-parity: **7 of OpenClaw's 8 defects absent, 1 fixed**
  (cron-Remove now confirm-gated). `docs/BEAT_OPENCLAW_DEFECT_PARITY.md`.
- **BO14 (S18)** head-to-head bench. `docs/BEAT_OPENCLAW_BENCH.md`.
- **S15/S16 leads protected** — security suites 957+8 green, learning suites
  357+27 green; no beat-openclaw change regressed them (verified on merged main).

## Head-to-head (S18, live on prod)

| Metric | OpenClaw | SUDO-AI | Verdict |
|---|---|---|---|
| 50-turn success | 50/50 | 50/50 | tie |
| Latency (median) | 5,310 ms | **593 ms** model-call | **SUDO-AI ~9× faster** |
| Cost / msg | ~$0.007 | $0.00985 | OpenClaw lower (S1-gated) |
| Cache-read share | 91.6% | 14.1% | S1 decision |

## THE ONE DECISION FOR YOU — S1 (and therefore S18's cost row)

OpenClaw's flagship advantage is its ~4× input-cost cut from a 91.6% cache-read
share. SUDO-AI's cache-discipline code fix is **done, deployed, and S16-safe**
(byte-stable prefix proven on the wire). Reaching ≥90% requires **one config
change**: enlarge `SUDO_AGENT_WINDOW_SIZE` so the conversation history is
append-only (cacheable). That **reverts the deliberate #448 context-budget
design** ("keep-tokens" sliding window) — which the standing rule says *don't
revert without asking*. In the prompt-caching era this is likely net-cheaper
(cache reads ≈ 10% cost), so bumping the window + caching may serve #448's
cost-control intent rather than fight it — but that judgment is yours.

**If you approve** enlarging the window (and optionally routing the primary
conversational turn to a cache-friendly model like grok-4-fast or claude-oauth),
the byte-stable prefix + append-only history should carry cache-read share to
≥90% (trend measured: 38→48→57%, 77% on claude-oauth), which turns **S1 green and
flips S18's cost/msg to a win** — SUDO-AI then beats OpenClaw on every row.

## What was NOT done autonomously (per §12 stop conditions)
- The S1 window/#448 revert (this decision).
- No prod credential rotation (the shared xAI OAuth token issue is noted for you;
  it blocked isolated ≥90% measurement).
- No NotebookLM/N5, npm publish, user-data deletion, or frozen-surface writes.
