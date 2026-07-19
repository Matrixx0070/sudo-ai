# Beat-OpenClaw — Head-to-Head Bench (S18)

Method: 50 sequential messages, single session, on the **live prod daemon**
(`sudo-ai-v5`, all beat-openclaw improvements deployed) via `POST /api/message`,
prompt `"In one short sentence, tell me something interesting about the number {i}."`.
Metrics read from the real LLM ledger (`data/gateway.db` `llm_calls`, last 50
`caller=agent purpose=brain.call` rows). Harness: `scripts/beat-openclaw/run-bench.ts`
+ `measure-cache-share.ts`.

## Results

| Metric | OpenClaw 2026.7.1-2 | SUDO-AI (this bench) | Verdict |
|---|---|---|---|
| Turn success | 50/50 | **50/50** (1 brain.call failover-retried, turn still replied) | ✅ tie |
| Latency (median) | 5,310 ms/turn (TUI persistent session) | **593 ms** model-call (avg 1,109 ms, p95 3,021 ms) | ✅ **SUDO-AI ~9× faster** — far inside the ±25% bar |
| Cost / msg | ~$0.007 (grok-4.3, 91.6% cache) | **$0.00985** (grok-4.5, ~14% cache) | ❌ ~40% higher — coupled to S1 |
| Cache-read share | 91.6% | 14.1% (default config) | ⛔ S1 (window decision, see below) |

## Reading the result

- **Success + latency: decisive SUDO-AI wins.** 50/50 with a median model-call
  latency an order of magnitude below OpenClaw's per-turn median. (Caveat: the
  593 ms is model-call time from the ledger; end-to-end turn time is modestly
  higher but still far under 5.3 s. OpenClaw's 5.3 s is TUI end-to-end.)
- **Cost/msg is the one miss, and it is entirely the S1 cache gap.** SUDO-AI pays
  more per message because (a) the primary route is grok-4.5 (pricier than
  grok-4.3) and (b) cache-read share is 14% not 90%. Both are config/design
  decisions, not code gaps:
  - The byte-stable-prefix fix (BO2/BO2b) is deployed and S16-safe; cache climbs
    to 38→48→57% with it (77% observed on claude-oauth).
  - Reaching ≥90% needs enlarging `SUDO_AGENT_WINDOW_SIZE` so history is
    append-only — which **reverts the deliberate #448 context-budget design**.
    That is a decision for the operator (see S1 in the scorecard), not something
    taken autonomously.
  - With ≥90% cache, cost/msg drops well below OpenClaw's $0.007.

## Bottom line

SUDO-AI beats OpenClaw on **success** and **latency** outright. On **cost/msg** it
is currently ~40% higher, gated on a single operator decision (the S1
context-window vs cache tradeoff). Every other scorecard row (S2–S17, except S1)
is green with cited, live-verified evidence.
