# ADR 0005 — Tool-surface consolidation (324 → primitives + skills)

- **Status:** Proposed (no tool is removed by this ADR)
- **Date:** 2026-07-31
- **Deciders:** Frank (owner) — this ADR only *proposes*; retirement needs his GO
- **Supersedes:** nothing. **Related:** doctrine #1 (bitter lesson), #4 (primitive > helper), #5 (simplicity), Frank's "never drop capabilities" rule

## Problem

sudo-ai registers **324 built-in tools** across 40 toolkits. Claude Code — a mature agent
against the same class of model — ships **16**.

Measured evidence (`mind.db tool_outcome_stats`, a **19-day** window 2026-07-12 → 07-31,
**3,632 recorded calls**):

| Metric | Value |
|---|---|
| Tools registered | 324 |
| Tools ever invoked | **48 (15%)** |
| Tools never invoked | **276 (85%)** |
| Of the 48 used, called ≤2 times | 23 |
| Tools carrying real work | **~25** |

Three structural signals, not opinions:

1. **The router exists to hide the surface.** `tool-router.ts` sets `BASE_TOOL_SLOTS = 12`
   and routes the rest by category/keyword. We built retrieval machinery to compensate for
   a tool count too large to present — the cost of the surface is already being paid, in
   code we maintain.
2. **The domain verticals are prompt templates wearing a tool costume.** `content.summarize`
   makes **zero model calls**: it accepts text and returns *instructions on how to summarise*
   (`formatInstructions: { tldr: …, 'bullet-points': … }`). The model calls a tool to be told
   how to summarise, then summarises itself. `learn.tutor` (410 lines) likewise makes no model
   call. This is the definition of betting against the model.
3. **Every tool is permanent context and permanent maintenance.** Definitions consume tokens
   whenever routed in, each is a place the model can choose wrong, and each is code that must
   keep compiling, keep passing tests, and keep being read by whoever edits nearby.

## Alternatives considered

**A. Keep all 324.** Zero risk today. Rejected as the default because the cost is not zero —
it is paid continuously in routing machinery, context, maintenance and mis-selection, and it
grows. "It might be used one day" is not a design principle.

**B. Delete the unused 276.** Fast and wrong. The 19-day window cannot see genuinely seasonal
or rare tools (a tax helper in tax season), some tools exist for the *human* to invoke rather
than the agent, and deletion violates the never-drop-capabilities rule outright.

**C. (Chosen) Classify, then retire-into-Skills behind a deprecation flag.** Every tool is
sorted into KEEP-PRIMITIVE, KEEP-GATED, or RETIRE-TO-SKILL. Retirement means the *capability
survives as a Skill* (instructions the model already knows how to execute with `system.exec`
+ file primitives) while the *tool definition* leaves the registry.

## Decision

Adopt a three-bucket classification, and require evidence per tool before anything is retired.

- **KEEP — PRIMITIVE.** General capabilities the model composes with: `system.exec`,
  `coder.*` file primitives, `browser.*`, `skill.*`, `meta.*` control-plane. These are
  Claude Code's 16 in sudo-ai's naming. ~25 of these carry all current traffic.
- **KEEP — SAFETY-GATED.** Narrow tools that exist to make a dangerous operation *safe on an
  unattended channel*: path allowlists, approval gates, spend caps, sandbox routing. sudo-ai
  runs on Telegram/email/cron where no human is present to approve raw shell, so a gated
  narrow tool is a genuinely better primitive than `exec`. **This bucket is why sudo-ai should
  never converge fully to 16 tools.**
- **RETIRE-TO-SKILL.** Prompt-wrappers and domain verticals: a tool whose implementation makes
  no model call and performs no privileged operation is a prompt with extra steps.

**Initial candidate set: the 58 never-used domain-vertical tools** (`marketing.*`,
`business.*`, `finance.*`, `legal.*`, `social.*`, `earning.*`, `pm.*`, `personal.*`,
`learn.*`, `research.*`, `content.*`, `knowledge.*`) — full list in the appendix.

**Retirement protocol (nothing skips this):**
1. Frank GO per namespace — never per-tool-by-agent-judgement, never bulk.
2. Capability first moves to a Skill; the Skill is proven to reproduce the tool's output.
3. Tool goes flag-off (`SUDO_LEGACY_TOOLS=1` restores) for one full release.
4. Only then is the code deleted, in a separate reversible commit.

## Tradeoffs

- **Cost:** a retired tool is one more thing the model must *do* rather than *call*. On a
  weaker fallback model (glm, gemini) that is a real quality drop — mitigated because the
  brain chain leads with opus-5 and Skills carry the instructions.
- **Benefit:** smaller routed context, fewer wrong-tool selections, less code, and the
  surface stops growing by default.
- **Risk accepted:** a rare-but-real tool gets retired and someone notices in three months.
  The flag-off release and Skill fallback bound that cost to "set a flag".

## Consequences

- `tool-router.ts` becomes less load-bearing as the surface shrinks; if the surface ever fits
  in the base slots, the router can be simplified out entirely (a second, later win).
- New tools face a bar: *what privileged thing does this do that `system.exec` + a Skill
  cannot?* A tool that cannot answer that is a Skill.
- This ADR is **advisory until Frank GOes a namespace**. No behaviour changes on merge.

## Appendix — retirement candidates (never invoked in 19 days / 3,632 calls)

| Tool | Namespace | Recorded calls |
|---|---|---|
| `marketing.ad-campaign-builder` | marketing | never |
| `marketing.ad-copy-generator` | marketing | never |
| `marketing.competitor-analysis` | marketing | never |
| `marketing.content-calendar` | marketing | never |
| `marketing.keyword-research` | marketing | never |
| `marketing.seo-audit` | marketing | never |
| `business.analytics` | business | never |
| `business.calendar` | business | never |
| `business.crm` | business | never |
| `business.email` | business | never |
| `business.invoicing` | business | never |
| `business.reports` | business | never |
| `finance.bookkeeper` | finance | never |
| `finance.financial-report` | finance | never |
| `finance.payment-processor` | finance | never |
| `finance.tax-calculator` | finance | never |
| `legal.terms-generator` | legal | never |
| `social.multi-post` | social | never |
| `social.schedule-post` | social | never |
| `social.trend-scanner` | social | never |
| `social.twitter-manager` | social | never |
| `social.youtube-analytics` | social | never |
| `social.youtube-upload` | social | never |
| `earning.optimizer` | earning | never |
| `earning.tracker` | earning | never |
| `pm.project-planner` | pm | never |
| `pm.task-manager` | pm | never |
| `pm.time-tracker` | pm | never |
| `personal.calendar-manager` | personal | never |
| `personal.email-manager` | personal | never |
| `personal.reminder-system` | personal | never |
| `personal.task-inbox` | personal | never |
| `learn.exam-prep` | learn | never |
| `learn.explain-concept` | learn | never |
| `learn.homework-helper` | learn | never |
| `learn.study-planner` | learn | never |
| `learn.tutor` | learn | never |
| `research.literature-review` | research | never |
| `research.market-research` | research | never |
| `research.paper-finder` | research | never |
| `research.paper-summarizer` | research | never |
| `content.presentation-builder` | content | never |
| `content.proofread` | content | never |
| `content.rewrite` | content | never |
| `content.seo-content-optimizer` | content | never |
| `content.summarize` | content | never |
| `content.viral-hook` | content | never |
| `content.write-article` | content | never |
| `content.write-copy` | content | never |
| `content.write-email-sequence` | content | never |
| `content.write-script` | content | never |
| `content.write-social-post` | content | never |
| `knowledge.graph` | knowledge | never |
| `knowledge.grok-rag` | knowledge | never |
| `knowledge.notes` | knowledge | never |
| `knowledge.research` | knowledge | never |
| `knowledge.search` | knowledge | never |
| `knowledge.zettelkasten` | knowledge | never |
_Evidence: `mind.db tool_outcome_stats`, 2026-07-12 → 2026-07-31. A 19-day window cannot prove a tool is dead — it proves the burden of proof belongs with keeping it._
