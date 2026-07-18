# GW-13 — Scenario Journeys

Journey-shaped end-to-end tests that exercise the gateway's **real** cross-subsystem
flows and assert on **observable artifacts** (SQLite rows, sentinel files,
trust-tier decisions) rather than internals. They target the bug class that unit
tests miss and that has actually bitten production: the #751 empty-reply →
Telegram silence, IMAP starvation, the session fork loop ("lost chats").

Modelled on OpenClaw's Docker e2e journeys (upgrade-survivor, corrupt-plugin),
scoped down to what SUDO can verify hermetically with a mock LLM transport.

## What runs

`tests/journeys/` — run in-process under vitest (no live daemon, no provider, no
secrets). A "restart" is modelled by re-opening the same on-disk data dir with
fresh objects, so durability guarantees are proven across a real process
boundary.

| Journey | Ties together | Asserts |
|---|---|---|
| **1. restart-survivor** (MVP) | GW-9 sentinel + GW-15 durable outbox | A reply committed `dispatched` at crash becomes `unknown` on boot recovery (never double-sent); a queued reply is delivered exactly once; the sentinel handoff completes (ready.json written, intent cleared, `resumed=true`); a stale intent flags a failed prior handoff. |
| **2. failover → delivery** | GW-2 failover chain + GW-15 outbox | The failover chain is built from the **real production config order** (`config/sudo-ai.json5 models.primary`, the array `brain.ts` feeds `ModelFailover`). A cost-cliff guard asserts, against that real order, that the cheap grok-4-fast tier precedes the expensive no-cache grok-4.5 — so a config regression that reorders them trips this journey. It then drives a real HTTP failover hop (config's first tier down → next tier answers) and the reply is persisted and acked exactly once. |
| **3. webhook → untrusted sandbox** | trust-tier resolver (Spec 8) | A non-owner webhook caller classifies `untrusted` → `docker` backend with fail-closed egress (`network:none`); an operator-set allowlist graduates to the enforced allowlist (still docker-only); owner/internal turns stay host-tier; a peer cannot forge egress. |

Harness pieces:
- `tests/journeys/llm-stub-server.ts` — scriptable OpenAI-compatible mock (per-model
  status, request log for order assertions).
- `tests/journeys/harness.ts` — isolated on-disk `DATA_DIR` per journey + handoff helper.

## How to run

```bash
# In-process (fast, the primary CI gate):
pnpm exec vitest run tests/journeys/

# Containerised (the hermetic isolation vehicle — also run in CI):
docker build -f Dockerfile.journeys -t sudo-ai-journeys .
docker run --rm sudo-ai-journeys
# or
docker compose -f docker-compose.journeys.yml up --build --exit-code-from journeys
```

CI: `.github/workflows/journeys.yml` runs the suite **nightly** (07:00 UTC) and on
`workflow_dispatch`, in two jobs — `vitest` (fast, direct) and `container` (builds
+ runs the hermetic no-egress compose so the Docker vehicle is exercised, not just
documented). Deliberately off the per-PR path (Docker build + runtime). MVP
acceptance is **journey 1 green**. Note: GitHub only runs `schedule`/`dispatch`
from the default branch, so nightly CI begins once the wave stack merges to `main`;
until then the suite is exercised locally + via the container build.

## Design notes / boundaries

- **No full-daemon HTTP boot.** The spec's Docker-compose full boot needs a live
  daemon + secrets this program's constraints (no deploy) can't provide. The
  journeys instead drive the actual subsystem entry points and assert on the same
  artifacts a full boot would produce (outbox states, sentinel files, tier
  decisions). The container is the CI isolation vehicle, not a second
  implementation.
- **Journey 2 reads production config, not a re-encoded literal.** An earlier draft
  asserted an order it had itself passed in (a tautology that couldn't catch the
  cost-cliff regression). It now reads `models.primary` from `config/sudo-ai.json5`
  — the same source of truth `brain.ts` uses — so a real reorder regresses it.
  (The unit-level guard also lives in `tests/brain/gw2-failover.test.ts`.)
- **Sandbox assertion is on the decision, not an escape.** Journey 3 asserts the
  trust-tier resolver routes an untrusted caller to Docker with fail-closed
  egress — it does not attempt to break out of a container (that would test the
  kernel, not our routing).
- **Adding a journey:** add a `journey-N-*.test.ts` that composes real modules +
  the stub, assert on artifacts, keep it hermetic (no real network), and close any
  DB/server handles in `afterEach`. Extend the table above.
