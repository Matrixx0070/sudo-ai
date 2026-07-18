# Money ledger — substrate + verdicts (F102, 2026-07-18)

**Substrate: `src/core/billing/` over `mind.db api_call_log`.** It is the only
ledger auto-fed by the daemon (CostTracker records every LLM call; the F123
metabolism report and `meta.cost-tracker` tool read it). Every other money
module is a view, an input feed, or a separate business domain — never a
second cost ledger.

| Module | Verdict | Why |
|---|---|---|
| `core/billing/*` (cost-tracker/reporter/rate-monitor/daily-budget) | **SUBSTRATE — keep** | Auto-wired, tested (5 suites), read by metabolism + tools. |
| `core/brain/cost-tracker.ts` | keep (not a ledger) | In-memory per-session token counter; orthogonal (cli.ts comment marks the distinction). |
| `core/earning/revenue.ts` + `earning.revenue` tool | **DELETED 2026-07-18** | Non-persistent: constructed fresh per tool invocation, so `record-cost`/`check-milestones` state died at call end — numbers it reported were per-call fabrications. Revenue reporting lives in `earning.tracker get-revenue` (real `video_metrics` data). |
| `core/earning/tracker.ts` + `optimizer.ts` | keep — input feed | YouTube Analytics ingestion → `mind.db video_metrics`. A revenue *source*, not a ledger duplicate. |
| `core/finance/revenue-tracker.ts` (`meta.finance` tool) | keep, **deferred conversion** | The only manual revenue/budget entry surface. Its `costs` table duplicates `api_call_log` and should become a view over it — deferred: zero tests on this module make an autonomous rewrite of a money surface a bad trade. Do not add new writers to its `costs` table. |
| `builtin/finance/` toolkit (`finance-ledger.json`) | keep, **deferred conversion** | Bookkeeper/tax/payment tools have unique surface; their private JSON ledger is a 5th store and should be re-pointed at mind.db when touched next. |
| `core/business/*` (`business.db`) | keep — separate domain | CRM/invoicing/sponsors is genuinely different data. Its revenue analytics should read the unified ledger when next touched. |
| `data/economy.db` (prod, 12KB, table `agent_wallet`, last write 2026-05-31) | flag for operator | Zero code references anywhere. Left in place (operator data); safe to archive/delete. |

Rule going forward: **new spend/revenue writers must target `api_call_log`
(costs) or a documented domain store — never a new table or JSON file.**
