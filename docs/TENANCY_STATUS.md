# Tenancy (F92) — verdict: DEMOTE to documented library

**Verdict (2026-07-19, Phase 4.3):** DEMOTE. `src/core/tenancy/` is kept as a
standalone, tested library with **no runtime consumers**. It is NOT wired into
boot, and NOT deleted. Rescues beat deletions (F91 standard): the code has clean
bones and a fail-closed launcher, so it is preserved as a library rather than
thrown away.

## Reachability evidence (zero external consumers)

- `git grep -l "tenancy" src/ | grep -v "src/core/tenancy"` → **`src/llm/policy.ts` only**,
  and that is a **doc comment** (line 408: "…shared with self-build + tenancy…"),
  not an import.
- `git grep -n "core/tenancy" src/ | grep -v src/core/tenancy/` → **no matches.**
- Nothing imports `TenantManager`, `TenantFrontDoor`, or `defaultTenantLauncher`
  outside the directory. The whole dir is barrel-plus-tests, unimported.

## Why keep it (good bones)

- `tenant-launcher.ts` **refuses to run by default**: the default launcher spawns
  each tenant as the *same OS user* as the control plane with no uid/gid drop and
  no sandbox, so it throws unless the operator passes a real `TenantLauncher` or
  sets `SUDO_TENANCY_ALLOW_UNSAFE=1` to explicitly accept no isolation. This is
  the correct fail-closed posture for a security-relevant boundary.
- `tenant-manager.ts`, `front-door.ts`, `types.ts` are typed and cohesive.
- **21 passing tests** guard the library:
  `tests/tenancy/tenant-manager.test.ts` (8), `front-door.test.ts` (9),
  `launcher-fail-closed.test.ts` (4). These are retained.

## Status

- **No runtime consumers.** The module is a library only; nothing at boot uses it.
- To WIRE it later, a real consumer case must appear (a multi-tenant control
  plane that provides a real OS-isolation launcher — per-user provisioning or a
  container/sandbox boundary). Until then it stays parked as a documented library.
- To revisit as a DELETE: only if the multi-tenant direction is abandoned. Deleting
  now would discard the fail-closed launcher design and 21 tests for no gain.

## How to use (if wired)

```ts
import { TenantManager, defaultTenantLauncher } from '@/core/tenancy';
// defaultTenantLauncher THROWS unless SUDO_TENANCY_ALLOW_UNSAFE=1 or you pass a
// real isolation launcher — do not bypass this in production.
```
