# D3 stage 2 — adapter construction out of `cli.ts` (handoff)

Written 2026-08-06 at the end of a long session, so the next one starts cold
without re-deriving anything. ADR 0010 is the why; this is the how.

## Where things actually stand

| | status |
|---|---|
| Channel **enablement** decisions | ✅ 9 of 9 from `core/channels/channel-registry.ts` |
| `gatewayFinalize` | ✅ derived from the registry (was a hand-written expression) |
| Config-lie doctor | ✅ wired at boot |
| Adapter **construction** | ❌ untouched — all still inline in `cli.ts` |
| `cli.ts` size | ~6,400 lines — **unchanged** |

**ADR 0010's own revert criterion for D3:** if `cli.ts` line count and
files-touched-per-channel do not fall, D3 has failed and should be reverted.
Enablement alone does not satisfy it. Stage 2 is where that gets earned.

## The actual problem

Each channel block in `cli.ts` does five things, and only the first is now
declarative:

1. decide enablement — **done** (registry)
2. construct the adapter (`new XAdapter(tokenKey, allowed…)`)
3. `registerOutboundAdapter(x)` + `x.setHookEmitter(hooks)`
4. conditionally `approvalManager.registerSender(id, x)` when `chatApprovals`
5. register on the shared `MessageRouter` (a nested block per channel)

Steps 2–5 need runtime handles that live in `cli.ts`'s closure: `hooks`,
`chatApprovals`, `approvalManager`, `registerOutboundAdapter`, and the global
router. **That dependency threading is the whole difficulty** — not the
adapters themselves.

## Suggested shape

Give the registry an optional constructor slot and pass the handles once:

```ts
export interface ChannelRuntimeDeps {
  hooks: HookEmitter;
  approvalManager: ApprovalManager | null;
  chatApprovals: boolean;
  registerOutboundAdapter: (a: OutboundAdapter) => void;
  getRouter: () => MessageRouter;
  log: Logger;
}

export interface ChannelDeclaration {
  // …existing fields…
  /** Build + wire the adapter. Absent = still constructed inline in cli.ts. */
  start?(deps: ChannelRuntimeDeps, tokenEnvKey: string | null): Promise<void>;
}
```

Then `cli.ts` becomes a loop over `GATEWAY_CHANNELS.filter(isChannelEnabled)`
calling `start()`, with any channel lacking `start` left inline — so migration
is **one channel per PR**, and the loop and the inline blocks coexist safely.

## Order to migrate (easiest → hardest)

1. **sms / email** — simplest wiring, and email is the only channel actually
   enabled on this box, so a regression shows up immediately in the boot log
   (`Email registered on gateway`).
2. **slack / discord** — add approval-sender registration.
3. **whatsapp** — carries the Baileys/ToS warning; keep it firing only when the
   channel truly turns on, and keep the `else if (WHATSAPP_TOKEN)` diagnostic
   that explains *why* it is off (the registry cannot express that).
4. **irc / matrix / signal / imessage** — via `extraChannelEnv`, already
   registry-derived, so mostly mechanical.

## Traps found the hard way

- **Two gates for one channel.** Stage 1 made `gatewayFinalize` accept
  `DISCORD_BOT_TOKEN` while the adapter block still read `DISCORD_TOKEN`, so
  the router started with Discord silently absent — worse than the original
  bug because it looked healthy. Any channel change must move **both** the
  enablement check and the token key the adapter is handed
  (`resolveTokenEnvKey`).
- **Adapters take the key NAME, not the value** (`new DiscordAdapter('DISCORD_TOKEN', …)`).
- **Only `email` is enabled here.** The other eight are proven by unit test
  only; a live regression will not surface locally. Check the boot log line
  `Gateway channels enabled` after every deploy.
- **`pm2 restart --update-env` does not clear a var the daemon already has.**
  Verify with `tr '\0' '\n' < /proc/$(pm2 pid sudo-ai-v5)/environ | grep FLAG`.
- **Tests can read live production state.** `paths.ts` captures
  `PROJECT_ROOT`/`DATA_DIR`/`WORKSPACE_DIR` at module load and ESM hoists
  imports above top-level statements, so setting env at the top of a test file
  is too late. Use `vi.hoisted()` or `tests/helpers/isolated-home.ts` plus a
  dynamic import.

## Definition of done for stage 2

- `cli.ts` line count **measurably lower** (record before/after in the PR).
- Adding a channel touches **one file** (its declaration), not `cli.ts`.
- Boot log still shows the same enabled channels.
- Full suite green (1,088+ files), `tsc` + `check:arch` clean.

## Also open

- `COST_RATES` in `core/brain/costs.ts` is dead (nothing reads it; `estimateCost`
  delegates to the catalog) but still re-exported from `core/brain/index.ts`.
  Pinned at 35 rows by the ratchet. **Awaiting Frank's GO to delete the export.**
- Notional cost for a bare route key (`claude-oauth:messages`) falls to the
  default rate — a fabricated number. Budgets are unaffected (correctly $0).
- D4 follows: typed per-capability config, then **delete** the ghost-flag
  linter, the contradiction table, and `SUDO_ALLOW_CONTRADICTORY_CONFIG`.
