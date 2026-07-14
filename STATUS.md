# gw-refactor — one-page status map (2026-07-14)

## What is running where

```
┌─ PROD (untouched) ──────────────────┐   ┌─ STAGING (new code) ────────────────┐
│ pm2: sudo-ai-v5                     │   │ pm2: gw-refactor-staging            │
│ dir: /root/sudo-ai-v4  branch: main │   │ dir: /root/gwrefactor-clone         │
│ port 18900 · Telegram ON            │   │ branch: gw-refactor · port 28900    │
│ your real bot — NOTHING changed     │   │ Telegram OFF · xAI only · SHADOW ON │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
                 └────────── PR #752 (awaiting YOUR review) ──────────┘
```

## What we built (the new pipe, inside the app)

```
 any caller (agent / consciousness / cron / RAG / vision / voice)
        │
        ▼
 src/llm/  ←── THE ONE DOOR. CI fails if anyone goes around it.
   ├─ client.ts    every call carries WHO (caller) and WHY (purpose)
   ├─ policy.ts    retries · circuit breaker · user-first lanes · $ budgets
   ├─ adapters/    one internal format (IR) ↔ OpenAI / Anthropic wire
   └─ logging.ts   every call → data/gateway.db (llm_calls table)
        │
        ▼
 providers (claude-oauth, xAI, …)  — same as before, for now
```

## Is it safe? (evidence)

| Check | Result |
|---|---|
| Full test suite | 10,132 tests, 0 failed |
| CI on GitHub | green |
| New pipe vs old pipe, real traffic | 341 comparisons, **0 differences** |
| Staging live run | 0 crashes, 0 errors, replies work |
| Prod impact | zero — never touched, never restarted |

## Switches (all OFF/safe by default)

| Flag | What it does | Now |
|---|---|---|
| `LLM_DIRECT_FALLBACK` | 1 = old path serves traffic (safe) | **1** |
| `LLM_SHADOW` | 1 = compare old vs new silently | staging only |
| `SUDO_GATEWAY_LOG` | call logging → gateway.db | ON |
| `SUDO_CONTEXT_BUDGET` | compact prompts BEFORE they overflow | ON |
| `SUDO_LLM_BUDGETS` | daily $ caps per caller | **unset — set after merge** |
| `SUDO_LLM_BACKGROUND_HALT` | panic lever: stop all background AI spend | off |

## Money (today)

- **Prod**: $27 *notional* — it's your flat Claude subscription; caching already saves 64.6% of input tokens. Real risk = quota, not dollars.
- **Staging**: $1.89 *real* xAI dollars in ~1h. Kill it after the PR review: `pm2 delete gw-refactor-staging`.
- ⚠ Found: grok-4.5 caches **nothing** → if prod ever fails over to it, costs jump ~10x. Fix candidate: fail over to grok-4-fast (caching proven).

## Your 3 decisions

- [ ] **Review + merge PR #752** — https://github.com/Matrixx0070/sudo-ai/pull/752 (activates logging/cache/compaction; traffic path unchanged)
- [ ] **After merge**: set budgets (`SUDO_LLM_BUDGETS`) and check cache-hit per caller in gateway.db
- [ ] **Cutover slice** (next mission): make the new pipe actually carry traffic. Recommendation: in-process, no external gateway (your Claude subscription can't ride one)
