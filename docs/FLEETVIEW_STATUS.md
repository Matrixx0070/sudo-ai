# FleetView (F95) — verdict: PARK as experiments

**Verdict (2026-07-19, Phase 4.3):** PARK. The three FleetView surfaces
(`src/tui/fleetview`, `src/desktop/fleetview`, `src/gateway/jsonrpc`) are
**tsx-runnable experiments** with no consumers and no product demand. They are
explicitly parked as experiments, NOT deleted and NOT packaged into build targets.
Packaging them into real binaries is not warranted today (no live consumer, adds
bundler/Electron packaging complexity for zero current benefit).

## What exists

| Surface | Path | Nature |
|---|---|---|
| TUI | `src/tui/fleetview/` | ink (React-for-terminal) dashboard entry |
| Desktop | `src/desktop/fleetview/` | Electron-style desktop shell |
| JSON-RPC | `src/gateway/jsonrpc/` | `fetcher.ts`, `methods.ts`, `server.ts`, `index.ts` — the data backend the TUI/desktop poll |

All three are **tsx-only**: they run directly under `tsx`, and the default
`build` target deliberately does NOT include these entry points (the TUI entry's
own docstring states this).

## How to run (tsx, no build step)

```bash
# JSON-RPC backend
pnpm gateway:fleetview      # tsx src/gateway/jsonrpc/index.ts

# Terminal UI
pnpm tui:fleetview          # tsx src/tui/fleetview/index.ts

# Desktop shell
pnpm desktop:fleetview      # tsx src/desktop/fleetview/index.ts
```

Each entry reads config from env and fails honestly (exit 1 + message) on
missing/malformed env rather than crashing inside render.

## Test coverage (retained)

- `tests/tui/fleetview-fetcher.test.ts`, `tests/tui/fleetview-format.test.ts`
- `tests/desktop/fleetview-config.test.ts`, `tests/desktop/fleetview-main-helpers.test.ts`
- `tests/gateway/jsonrpc-fetcher.test.ts`
- `tests/dashboard/fleetview.test.ts`

## Why parked, not packaged

- **No consumers**: nothing in the shipped daemon depends on these surfaces.
- **No product pull**: the admin/operator story is already served by the inline
  dashboard-html admin UI; FleetView is a richer-client experiment.
- Real packaging (bundled TUI binary, Electron app build + code-signing) is a
  multi-day investment justified only by a concrete operator need, which does not
  exist today. When it does, this doc is the starting point.
