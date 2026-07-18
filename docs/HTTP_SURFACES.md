# HTTP surface owners (F101, 2026-07-18)

One owner per surface. Anything not listed here that opens a port is a bug.

| Surface | Owner | Port | Notes |
|---|---|---|---|
| API + admin (`/v1/*`, `/api/*` allowlisted) | `src/core/gateway/server.ts` (+ `http-api.ts` and `gateway/*-routes.ts`) | `GATEWAY_PORT` 18900 | THE canonical listener (#759 unified auth). Route-owner guard 404s unallowlisted paths. `/v1/chat/completions`, `/v1/models`, `/v1/admin/*` live here. |
| Observability dashboard | `src/core/dashboard/dashboard-server.ts` | folded onto 18900 (GW-4) | **GW-4: served from the main gateway port by DEFAULT** (`SUDO_GATEWAY_UI_ON_MAIN` is on unless `=0`), mounted under `/__dashboard__/`. No standalone listener opens. `SUDO_DASHBOARD_PORT` is a **deprecated no-op** (logs a migration warning). `SUDO_DASHBOARD_STANDALONE=1` restores the legacy 18910 listener for rollback (one release). |
| Web chat UI | WebAdapter (`src/core/channels/web*`) | its own port | Chat SPA only — serves no `/v1` API (the boot line claiming an "OpenAI-compatible API on port 3001" was false and is removed). |

Deleted by F101 (dead third stack, zero live importers, live-verified nothing on :3001):
`src/core/api/{http-server,handlers,responses-api,rate-limiter,index,types}.ts`,
`src/core/api/admin/outcomes-router.ts`, `src/core/skills/tool-translator.ts`
(orphaned twin of the LIVE `src/core/security/tool-translator.ts`).

Kept: `src/core/api/admin-router.ts` + `src/core/api/admin/*.handler.ts` — the
opt-in (`SUDO_ADMIN_API=1`) `/api/admin/*` REST surface, attached to the
GATEWAY listener (cli.ts registerAdminHandlers mount), not to the deleted stack.

## Admin auth + namespace (GW-4)

`/v1/admin/*` is the **canonical** admin namespace. Both admin surfaces now
authenticate through the ONE unified resolver (`gateway/auth.ts`, requiring
`operator.admin`):

- `/v1/admin/*` (`gateway/admin-routes.ts`) — already on `authenticateHttp`.
- `/api/admin/*` (`api/admin/register.ts`) — GW-4 switched its gate from a
  bespoke per-surface Bearer compare to `authenticateHttp` + `hasScope('operator.admin')`,
  and deleted the redundant self-auth inside `admin-router.ts` `dispatch()`.
  The `/api/admin/*` **prefix is DEPRECATED** in favor of `/v1/admin/*` and logs
  a deprecation notice at mount.

Deferred (GW-4 deviation): physically merging the two route SETS is not done —
`/api/admin/*` (models/channels/tools/consciousness stubs) and `/v1/admin/*`
(audit/inspection/alignment/epistemic) are DIFFERENT surfaces, not aliases of one
another, so a 308 alias would misroute. Auth is unified; route consolidation is a
separate follow-up once the stub surface has live handlers.
