# ADR 0008 — GrokSeat: one login, one façade, self-healing

Status: Proposed · Date: 2026-08-01 · Supersedes nothing

## Problem

The $30 Grok seat is fully exploited — ~17 capabilities live across **30+ modules**
(`src/llm/grok-*.ts`): chat, image, video, voice STT/TTS/LiveKit, RAG, files, memory,
automations, skills, workspaces, models, run-code, embeddings, MCP connectors. There is
**no façade**: a caller must know which of 30 modules to import, and — worse — which of
**two unrelated auth lanes** that module rides.

The capability surface is not the problem. **Durability is.** Measured failures, all real,
all within one week:

| Failure | Evidence |
|---|---|
| OAuth token silently expired | `data/xai-oauth.json` dead for 6 days; nobody noticed until probed |
| statsig algorithm drift | canary `pureNodeGate:403 / oracleGate:200`; killed app-chat + video + RAG in prod |
| warm browser absent | oracle can't self-launch (fails in 0.4s); whole free lane down |
| env var never plumbed | `SUDO_GROK_ORACLE_CDP_URL` set in `config/.env` but `ecosystem.config.cjs` *enumerates* env, so it never reached the process |
| free model revoked | `grok-4.5-build-free` → 404; lane silently became metered ($161.27 invoiced) |

Every one was **silent**. The system had no way to answer "is the seat healthy?" — which is
exactly what "log in once and it just works" requires.

## Alternatives considered

1. **Do nothing; keep importing modules directly.** Cheapest. Rejected: it is precisely the
   status quo that produced five silent outages. There is no single place to ask "is the
   seat working?", so nobody ever asked.
2. **Rewrite the 30 modules into one package.** Rejected outright — violates "prefer
   evolution over replacement" and "never drop capabilities". The modules are live,
   tested, and correct; the defect is that nothing *composes* them.
3. **Publish a standalone npm SDK now.** Premature. Packaging is a distribution decision;
   it should follow a stable internal interface, not precede it. Revisit once the façade
   has proven stable in-tree (see Consequences).
4. **A thin façade + unified auth/health core over the existing modules.** ← chosen.

## Decision

Add **`GrokSeat`** — a façade, not a subsystem. It owns exactly three things the current
architecture has nowhere to put, and delegates everything else:

1. **One login.** `login()` establishes BOTH lanes (cookie session + OAuth) and reports
   which succeeded. Today these are two unrelated flows with two failure modes and no
   common entry point.
2. **One health model.** `status()` / `doctor()` answers "which capabilities are live right
   now, and if not, why" — per lane, with the *specific* remedy. This is the observability
   the doctrine mandates and the thing whose absence caused every silent failure above.
3. **One self-healing policy.** Token refresh, statsig demote+purge, warm-browser
   supervision, and relogin signalling behind a single recovery path, so a caller never
   implements retry semantics per module.

Capability access stays **delegation only** — `seat.voice`, `seat.chat`, `seat.files` are
lazy re-exports of the existing modules. The façade adds no capability logic; if it starts
to, that is a design smell and the logic belongs in the module.

**Explicitly NOT in scope:** no new transport, no new auth mechanism, no reimplementation.
`GrokWebSessionManager` and `XaiOAuthManager` remain the owners of their lanes; `GrokSeat`
composes them.

## Tradeoffs

- **A façade risks becoming a god-object.** Mitigated by the delegation-only rule above and
  a max-lines ratchet entry. If `GrokSeat` grows capability logic, the ADR has failed.
- **Two lanes stay two lanes.** We do not unify cookie + OAuth into one credential — they
  are genuinely different auth systems on xAI's side, and pretending otherwise would hide
  real failure modes. The façade makes the *duality explicit and observable* instead of
  invisible.
- **`doctor()` costs live calls.** Health checks that never touch the network lie. Bounded
  to cookie-only, statsig-free, $0 endpoints (`/rest/subscriptions`, `/rest/rate-limits`)
  plus an explicit opt-in deep mode for the metered/quota-consuming paths.
- **The free lane depends on a headed browser.** Not fixable here — it is inherent to the
  statsig gate. The façade's job is to *report* it clearly, not hide it.

## Consequences

- One place to ask "is the seat healthy?", so the next silent expiry is loud instead.
- Callers stop importing 30 modules and stop hand-rolling retry/refresh.
- The seat becomes benchmarkable: `doctor()` output is a natural nightly watchdog check
  (extends the existing self-heal/watchdog engine rather than adding a new one).
- Publishing later becomes a packaging step over a proven interface, not a rewrite.
- Every capability keeps its current module and tests — zero capability deletion.

## Build order (smallest useful version first)

1. `status()` / `doctor()` over both lanes — **observability first**, since it is what was
   missing when all five failures went silent. Ships alone, useful alone.
2. `login()` unifying both lanes + one clear relogin signal.
3. Delegating capability accessors (mechanical, no logic).
4. Wire `doctor()` into the nightly watchdog.
5. *(Gated, separate decision)* extract as a published package.
