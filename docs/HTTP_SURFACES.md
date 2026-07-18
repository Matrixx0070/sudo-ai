# HTTP surface owners (F101, 2026-07-18)

One owner per surface. Anything not listed here that opens a port is a bug.

| Surface | Owner | Port | Notes |
|---|---|---|---|
| API + admin (`/v1/*`, `/api/*` allowlisted) | `src/core/gateway/server.ts` (+ `http-api.ts` and `gateway/*-routes.ts`) | `GATEWAY_PORT` 18900 | THE canonical listener (#759 unified auth). Route-owner guard 404s unallowlisted paths. `/v1/chat/completions`, `/v1/models`, `/v1/admin/*` live here. |
| Observability dashboard | `src/core/dashboard/dashboard-server.ts` | `SUDO_DASHBOARD_PORT` 18910 | Second listener; folds onto the gateway under `/__dashboard__/` via `SUDO_GATEWAY_UI_ON_MAIN=1`. Remaining F101 tail: complete the fold + reconcile its `/api/admin/*` fleet routes with `/v1/admin/*`, then retire the port. |
| Web chat UI | WebAdapter (`src/core/channels/web*`) | its own port | Chat SPA only — serves no `/v1` API (the boot line claiming an "OpenAI-compatible API on port 3001" was false and is removed). |

Deleted by F101 (dead third stack, zero live importers, live-verified nothing on :3001):
`src/core/api/{http-server,handlers,responses-api,rate-limiter,index,types}.ts`,
`src/core/api/admin/outcomes-router.ts`, `src/core/skills/tool-translator.ts`
(orphaned twin of the LIVE `src/core/security/tool-translator.ts`).

Kept: `src/core/api/admin-router.ts` + `src/core/api/admin/*.handler.ts` — the
opt-in (`SUDO_ADMIN_API=1`) `/api/admin/*` REST surface, attached to the
GATEWAY listener (cli.ts registerAdminHandlers mount), not to the deleted stack.
