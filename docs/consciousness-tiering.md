# SUDO AI Consciousness Tiering — cost architecture

**Status:** design / phase 1 shipped (env override only).
**Authored:** 2026-06-18. **Economics revised:** 2026-06-18 (post-PR #259).
**Driver:** the cognitive-stream tier runs Opus 4.8 on background ticks no user asked for. Routing that lowest-value work to a cheaper model is a sensible cost optimization regardless of absolute spend.

> **⚠️ Correction (post-PR #259).** This doc was first authored on the belief that
> cognitive-stream burned ~$17/hr ≈ $12,200/mo. That figure was a **phantom from two
> broken cost meters**, debunked hours later by the cost-transparency chain (PR #259,
> see memory `consciousness-cost-bomb`). Prompt caching was working all along; real
> continuous burn is **~$2.6/hr**, and PR #258 had already defused ~85% of even that.
> The daemon is **safe on a normal Max subscription** today. The tiering work below is
> still worthwhile — spending Opus-class compute on autonomous background thoughts is
> wasteful at any price — but it is a **prudent optimization, not an emergency**. All
> cost figures in the original tables are retained below *struck through* for history;
> treat them as upper-bound illustrations, not measured values.

## The problem

The PM2-running `sudo-ai-v5` daemon's consciousness loop calls the configured model (currently Opus 4.8) roughly every 30 seconds, 24/7, with ~27k-token contexts. Top-of-line compute is being spent on the lowest-value activity (background ticks no user asked for) — regardless of the exact dollar figure, that is the wrong allocation.

The originally-reported economics (now known to be inflated by broken meters — see correction above):

| Metric | Originally reported | Reality (post-#259) |
|---|---|---|
| Calls per hour | ~120 | ~120 |
| Avg prompt tokens | ~27,000 | ~27,000 |
| Estimated cost per call | $0.13–0.14 | far lower — prompt caching discounts the ~95%-stable prefix |
| Continuous burn | ~~**~$17/hr ≈ $12,200/month**~~ | **~$2.6/hr** (and #258 cut ~85% of it) |
| vs a Max 20x plan | ~~out-burns by ~3×~~ | comfortably within a normal Max plan |

## Root cause

The consciousness layer treats three different problems as one and applies the top-tier model to all of them:

1. **Embodied state tracking** — energy, mood, clarity. Does not require LLM reasoning.
2. **Inner monologue / cognitive stream** — autonomous "thoughts". Could run on any small model.
3. **Real cognition** — user-facing reasoning, goal decisions. Justifies a premium model.

Top-of-line compute is being spent on the lowest-value activity (background ticks no user asked for).

## Target architecture: three-tier consciousness

| Tier | Trigger | Compute | Cost/tick |
|---|---|---|---|
| **Heartbeat** (every 30s, always on) | Always | Pure math / heuristics. Energy decays linearly, restored by interaction. Mood = EMA of recent sentiment scores. Clarity = inverse of error rate. **No LLM.** | $0.00 |
| **Inner monologue** (every 5–10 min, or on signal) | Cumulative signals exceed threshold | Local Ollama (Kimi, Llama 3.x) — already in the provider list. | $0.00 |
| **Cognition** (only on external trigger) | User message, goal decision, unexpected tool result | Cloud model (Claude via OAuth). What the subscription is actually for. | $0.14 — but **rare** |

## Multiplicative reducers (layer on top of the tier split)

1. **Differential gate** — hash the cognition input context; skip the call when the hash hasn't changed in N ticks. ~50% reduction at the per-tier level for free.
2. **Anthropic prompt caching** — the 27k-token context is ~95% stable. Properly marked with `cache_control`, Anthropic gives a 90% discount on repeated prefixes. `src/core/brain/prompt-cache-discipline.ts` already exists; audit whether it actually fires on consciousness calls.
3. **Real sleep cycles** — active / idle / sleep state machine. Background burn drops 80% on its own; wakes on external signal.
4. **Batched cognition** — accumulate triggers over a 10-min window, then make ONE call. Better answer, 20× cheaper.
5. **Federated free inference for tier 2** — Ollama Cloud, Groq free tier, Together AI credits, HuggingFace endpoints. Tier 2 should never touch a paid model.

## Projected economics

> These projections were built off the now-debunked $17/hr baseline. The *shape* of
> the savings (each lever multiplies down) still holds; the absolute figures are
> upper-bound illustrations, not measurements. The real starting point is ~$2.6/hr.

| Phase | Hourly burn (continuous) | Monthly equivalent | Affordable to |
|---|---|---|---|
| ~~Today~~ (inflated baseline) | ~~$17/hr~~ → real ~$2.6/hr | ~~$12,200/mo~~ | already within a normal Max plan |
| Tier split only (Haiku / Ollama for tiers 1–2, Opus only on tier 3 triggers) | proportionally lower | — | 20x Max plan users |
| + Prompt caching | already in effect (per #259) | — | Standard Max plan |
| + Sleep cycles + differential gate | **near-zero active, $0 sleeping** | **a few $/mo** | $20/mo Claude users — i.e. **everyone** |

## Strategic implication

Every other agent product is one of:
- **Always-on but stateless** (cheap because there's no there there)
- **Stateful but on-demand** (no autonomy)
- **Autonomous but expensive** (current sudo-ai — burns wallet)

Tiered consciousness lets sudo-ai be **stateful + autonomous + cheap simultaneously** — which is what "100x AI for everyone" actually requires. The consciousness feature stops being a cost-center and becomes a **competitive moat** nobody else has solved.

## Phasing — one PR per phase

| Phase | Scope | Risk | Status |
|---|---|---|---|
| **0. Design doc + memory** | This file + `MEMORY.md` entry | — | ✅ done |
| **1. Env override** | `SUDO_CONSCIOUSNESS_MODEL=<model>` → cognitive-stream routes to any provider. Default unchanged. | Low | ✅ **this PR** |
| **2. Heuristic embodied state** | Replace LLM-driven embodied-state tick with deterministic energy/mood/clarity math. | Medium | follow-up |
| **3. Tier-2 local routing default** | Make Ollama the *default* for cognitive-stream when SUDO_CONSCIOUSNESS_MODEL is unset, falling back to config only on explicit override. | Medium | follow-up |
| **4. Differential gate** | Hash-based skip on unchanged context. | Low | follow-up |
| **5. Prompt-cache audit + wiring** | Confirm `cache_control` markers reach cloud calls; fix if not. | Low | follow-up |
| **6. Real sleep cycles** | Active / idle / sleep state machine. | High (touches scheduling). | follow-up |
| **7. Federated free providers** | Round-robin between Groq, Together, HuggingFace for tier 2. | Medium | follow-up |

## Phase 1: what this PR ships

`src/core/consciousness/cognitive-stream/tick.ts:118` reads the env var `SUDO_CONSCIOUSNESS_MODEL`. When set, the cognitive-stream tier routes to that model instead of whatever `tierParams(tier, config)` returned. When unset (default), behaviour is **byte-identical to before**.

### Usage

```bash
# Route the cognitive-stream tier to Haiku (~10× cheaper than Opus per token)
SUDO_CONSCIOUSNESS_MODEL=claude-oauth/claude-haiku-4-5-20251001 \
  pm2 restart sudo-ai-v5 --update-env

# Or to a local model — free, runs on your own hardware
SUDO_CONSCIOUSNESS_MODEL=ollama/kimi-k2.7-code:cloud \
  pm2 restart sudo-ai-v5 --update-env

# Or unset to restore current behaviour
unset SUDO_CONSCIOUSNESS_MODEL
pm2 restart sudo-ai-v5 --update-env
```

Empty strings and whitespace-only values are treated as unset.

## Immediate workarounds (no code change required)

- `pm2 stop sudo-ai-v5` — kills burn instantly.
- Edit the primary model in `config/sudo-ai.json5` to a Haiku / local model, then `pm2 restart sudo-ai-v5 --update-env`. Affects **every** brain call, not just consciousness — use the env override if you want to keep user-facing calls on Opus.
