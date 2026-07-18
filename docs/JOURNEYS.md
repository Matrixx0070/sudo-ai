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
| **2. failover → delivery** | GW-2 failover chain + GW-15 outbox | The cheap cache-friendly tier is tried **before** the expensive no-cache escalation; on its transient failure, failover hops over real HTTP to the stub, obtains the reply, and the reply is persisted and acked exactly once. |
| **3. webhook → untrusted sandbox** | trust-tier resolver (Spec 8) | A non-owner webhook caller classifies `untrusted` → `docker` backend with fail-closed egress (`network:none`); an operator-set allowlist graduates to the enforced allowlist (still docker-only); owner/internal turns stay host-tier; a peer cannot forge egress. |

Harness pieces:
- `tests/journeys/llm-stub-server.ts` — scriptable OpenAI-compatible mock (per-model
  status, request log for order assertions).
- `tests/journeys/harness.ts` — isolated on-disk `DATA_DIR` per journey + handoff helper.

## How to run

```bash
# In-process (fast, what CI actually executes):
pnpm exec vitest run tests/journeys/

# Containerised (the isolation vehicle):
docker build -f Dockerfile.journeys -t sudo-ai-journeys .
docker run --rm sudo-ai-journeys
# or
docker compose -f docker-compose.journeys.yml up --build --exit-code-from journeys
```

CI: `.github/workflows/journeys.yml` runs the suite **nightly** (07:00 UTC) and on
`workflow_dispatch` — deliberately off the per-PR path (Docker build + runtime).
MVP acceptance is **journey 1 green**.

## Design notes / boundaries

- **No full-daemon HTTP boot.** The spec's Docker-compose full boot needs a
  package-manager install + image build that this program's constraints (no
  deploy, guardian-gated tooling) can't verify here. The journeys instead drive
  the actual subsystem entry points and assert on the same artifacts a full boot
  would produce (outbox states, sentinel files, tier decisions). The container is
  the CI isolation vehicle, not a second implementation.
- **Sandbox assertion is on the decision, not an escape.** Journey 3 asserts the
  trust-tier resolver routes an untrusted caller to Docker with fail-closed
  egress — it does not attempt to break out of a container (that would test the
  kernel, not our routing).
- **Adding a journey:** add a `journey-N-*.test.ts` that composes real modules +
  the stub, assert on artifacts, keep it hermetic (no real network). Extend the
  table above.
