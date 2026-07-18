# F97 stage a — legacy LLM stack inventory (2026-07-18)

Scope: everything that keeps `src/llm/legacy/` (1,951 lines) and the three
`src/core/brain/` re-export shims alive, and what each consumer needs from the
port. Produced by exhaustive import sweep (incl. same-directory relative and
dynamic `import()` forms — both missed by naive grep).

## Modules

| Module | Lines | Real role | Verdict |
|---|---|---|---|
| `legacy/claude-oauth-manager.ts` | 680 | OAuth token lifecycle (PKCE login, refresh single-flight, status). Not legacy logic — live auth state for the IR transport too. | **MOVE** → `src/llm/claude-oauth-manager.ts` (sibling of `xai-oauth-manager.ts`) |
| `legacy/custom-providers.ts` | 269 | Custom-provider registry: env registration, wire config (used by IR transport), plus ai-SDK instance construction (legacy-only half). | **MOVE** → `src/llm/custom-providers.ts`, drop the ai-SDK instance half once providers.ts dies |
| `legacy/providers.ts` | 1,002 (zero tests) | ai-SDK model factory: `initProviders`/`getModel`/`getModelWithKey`, vault key resolution, `attachBodyIdleTimeout`, `stripEmptyTextBlocks`. | **DELETE** after consumers port |
| `brain/providers.ts`, `brain/custom-providers.ts`, `brain/claude-oauth-manager.ts` | 3 shims | `export *` re-exports for pre-gw-refactor import paths. | **DELETE** |

## Consumers and required ports

| Consumer | Uses | Port |
|---|---|---|
| `src/core/brain/brain.ts` | `initProviders` (ctor, line 510), `getModel` (stream 1442, rotation 2174–2192), `getModelWithKey` (multi-key rotation), `isCustomProvider`; legacy fall-through after the IR seam (call ~1845, stream ~1354) | Make IR unconditional; delete fall-through + ai-SDK call path; keep custom-provider registration at boot; port key rotation via new transport `apiKeyOverride` |
| `src/llm/client.ts` | dynamic `getModel` in `chatIR` direct-fallback (line 345) + legacy vision path (~409–491) | Re-point direct path at in-process `callIR` (per #752 cutover recommendation: no external gateway) |
| `src/llm/transport.ts` | `getCustomProviderWireConfig` (line 86), dynamic `legacy/claude-oauth-manager` in `authHeaders` (line 252) | Import-path updates only (modules move out of legacy/) |
| coder tools ×5: `analyze.ts`, `arsenal.ts`, `arsenal-v2/index.ts`, `swarm.ts`, `codex.ts` | `getModel` + ai-SDK `streamText` directly (bypasses Brain); codex also `listAvailableProviders` | Port to `chatIR`/`streamIR` via `src/llm/client.ts` |
| `src/core/gateway/admin-claude-oauth-routes.ts` | `getClaudeOAuthManager`, `reinitProvider` (post-relogin provider rebuild) | Manager path update; `reinitProvider` obsolete — transport reads tokens per call |
| `src/cli.ts` (353), `src/cli/commands/claude-oauth.ts` (×6 dynamic) | `getClaudeOAuthManager` | Path update |
| `src/llm/shadow.ts` | `stripEmptyTextBlocks` | Move util (small, pure) |
| `src/core/brain/index.ts` barrel | re-exports `getProvider`/`getEnvKeyForProvider`/`ProviderName`/`listAvailableProviders` | Zero external consumers (verified — all matches are `getProviderApiKey` from client.ts) → drop re-exports |
| scripts ×5: `debug-claude-oauth`, `prod-oauth-step`, `test-claude-pkce`, `verify-prod-oauth`, `arsenal-v2-audit` | shims (manager + `initProviders`) | Path updates (arsenal-v2-audit's `initProviders` dies with providers.ts → re-point or retire script) |
| tests: `tests/brain/{claude-oauth-manager,custom-providers,oauth-body-idle,provider-vault-fallback,strip-empty-text-blocks}.test.ts`, `tests/unit/brain/brain-provider.test.ts`, `tests/llm/transport*.test.ts` | legacy internals | Move with their modules; providers.ts-only suites retire with it |

## Flags retired / behavior notes

- `LLM_IR_CALLERS` (prod: `health,consciousness`) — retired; IR becomes the only path. Gate logic: `brain-bridge.ts irCallersEnabled` + `mustUseIrTransport`.
- `LLM_DIRECT_FALLBACK` — the "legacy direct" arm of `chatIR` becomes the in-process `callIR` arm; external-gateway arm stays dead (claude-oauth subscription auth cannot ride external gateways).
- **Gap found**: the IR seam bypasses brain's multi-key rotation (`_generateWithKeyRotation` is legacy-path-only). Unconditional IR must add per-call key override to `CallIROptions` or rotation silently disappears for env-key providers.
- `reinitProvider` semantics change: legacy cached ai-SDK provider instances (rebuilt after oauth re-login); the transport resolves auth per call, so re-login is picked up automatically.
