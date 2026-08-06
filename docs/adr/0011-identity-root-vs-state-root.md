# ADR 0011 — Separate the identity root from the state root

Status: **Proposed** (2026-08-06)
Supersedes nothing. Touches `core/shared/paths.ts`, `llm/*-manager.ts`,
`core/eval/*`, `core/tenancy`, `cli/commands/chat`.

## Problem

`DATA_DIR` is a single knob controlling two orthogonal concerns:

- **State** — 21 `.db` files, 6 `.jsonl` journals, 28 subdirectories of caches,
  run artifacts, backups. Tied to an *instance*. Isolating it is how we avoid
  SQLite lock contention with the pm2 daemon.
- **Identity** — OAuth tokens, device identity, signing keys. Tied to a
  *principal*. Isolating it means the agent stops being itself.

Four callers isolate `DATA_DIR`, and three of them want state-isolated but
identity-**shared**:

| caller | wants state isolated | wants identity isolated |
|---|---|---|
| TUI (`chat/agent-loop-adapter.ts:82`) | yes | **no** |
| bench (`eval/agent-bench-runner.ts:211`) | yes | **no** |
| eval sandbox (`eval/sandbox/eval-runner.ts:266`) | yes | **no** |
| tenant (`tenancy/tenant-manager.ts:149`) | yes | yes |

One knob cannot express that, so each caller invented a different workaround:

1. **The TUI and bench rely on module-load capture.** `paths.ts:38` reads
   `DATA_DIR` once at import and documents the workaround explicitly —
   *"overrides set later in-process (e.g. the TUI adapter's private dir)
   intentionally do not move this constant."* Correctness therefore depends on
   **import-graph topology**, which is invisible at the call site and unpinned
   by any test. Measured with a sentinel probe (import module → set
   `DATA_DIR=/tmp/SENTINEL` → load `paths.ts`):

   - `agent-bench-runner.js` → pre-captures the real `data/` (its static dep
     `logger.js` pulls `paths.ts`) — safe by accident.
   - `agent-loop-adapter.js` → **sentinel wins** (its static deps do not pull
     `paths.ts`) — unsafe by accident.

   The TUI is correct in production only because `App.tsx` imports
   `provider.ts`, which imports `constants.ts`, which imports `paths.ts`. That
   import survives today on a single value (`DEFAULT_SYSTEM`). Inline that
   constant and TypeScript erases the import, `paths.ts` is no longer
   pre-loaded, and credentials silently relocate to a stale directory. There is
   no error — just a different token and a quiet failover.

2. **The eval sandbox copies secrets.** `eval-runner.ts:231-236` re-seeds
   `claude-oauth.json`, `xai-oauth.json`, `gemini-gpsoauth-seed.json` into the
   run dir, because a child process captures the isolated `DATA_DIR` at startup
   and would otherwise have no brain at all (its comment: *"live-proven: every
   claude-oauth profile fails 'no usable token'"*). The copy carries a
   documented accepted risk — a refresh inside the run races the host store.
   Both the copy and the risk exist only because identity cannot be addressed
   separately.

3. **Four sites gave up and hardcoded `data/`** — `onboard.ts:191`,
   `youtube/auth.ts:44`, `security-audit.ts:129-130` — ignoring `DATA_DIR`
   entirely, so they read the wrong file under staging or a tenant.

The identity surface is small and already inconsistent — 11 sites across three
resolution styles:

```
dataPath('claude-oauth.json')                 claude-oauth-manager.ts:80
path.join(DATA_DIR, 'xai-oauth.json')         xai-oauth-manager.ts:69
path.join(DATA_DIR, 'xai-apikey.json')        xai-apikey-manager.ts:27
path.join(DATA_DIR, 'gemini-gpsoauth-seed…')  gemini-gpsoauth-reauth.ts:21
path.join(DATA_DIR, 'keys')                   artifact-signer.ts:58
process.env['SUDO_SIGNER_KEY_DIR'] ?? …       signer.ts:48      <-- the idea, unnamed
path.join(DATA_DIR, 'claude-oauth.json')      doctor.ts:175
'data/xai-oauth.json'                         onboard.ts:191    <-- ignores DATA_DIR
'data/youtube-oauth.json'                     youtube/auth.ts:44
'data/xai-oauth.json', 'data/oauth-creds.json' security-audit.ts:129-130
DATA_DIR/device-identity.json                 fleet/device-identity.ts
```

`signer.ts:48` already invented a private identity-root override. The concept
exists; it is just unnamed and applied once.

## Alternatives

**A. Do nothing.** Production is currently correct. Rejected: correctness rests
on an import that a routine refactor removes, with silent failure and no test.
Two turns of investigation this session produced three wrong conclusions
precisely because the behaviour is invisible.

**B. Make every isolating caller self-protecting** (add a static `paths.ts`
import to the TUI adapter). One line, fixes today's instance. Rejected as the
*primary* fix: it makes the invariant "every future caller must remember to
import an unrelated module first," which is the same trap with a longer fuse.
Worth doing as an interim guard, not as the design.

**C. Seed credentials into every isolated dir** (generalise the eval-runner
copy). Rejected: multiplies copies of long-lived rotating secrets across
directories, and multiple processes refreshing the same rotating refresh token
is a known outage mode in this repo. Copying secrets to fix a path problem is
the wrong axis.

**D. Name the second root.** Adopted.

## Decision

Introduce an explicit **identity root**, distinct from the state root.

```ts
// core/shared/paths.ts
/** Instance state — dbs, journals, caches. Isolate freely. */
export const DATA_DIR: string        // unchanged

/** Principal identity — OAuth tokens, device identity, signing keys. */
export const IDENTITY_DIR: string =
  process.env['SUDO_IDENTITY_DIR'] ?? DATA_DIR

export function identityPath(...segments: string[]): string
```

Note the default is `DATA_DIR`, **not** `PROJECT_ROOT/data`. Defaulting to the
project root would silently repoint staging (`ecosystem.config.cjs:846` sets
`DATA_DIR=data-staging` at process start) at *production* credentials. Identity
must follow a `DATA_DIR` set **before the process starts** — that is a
deployment decision — and must ignore one reassigned **mid-process**, which is
only ever a state-isolation request.

Rules:

- **An in-process caller that isolates state must pin identity first:**

  ```ts
  process.env['SUDO_IDENTITY_DIR'] ??= DATA_DIR;   // pin the real root
  process.env['DATA_DIR'] = myPrivateStateDir;     // then isolate state
  ```

  This is correct under either import order, which is what makes it a design
  rather than another accident:
  - `paths.ts` already loaded → `IDENTITY_DIR` captured the real root. ✅
  - `paths.ts` not yet loaded → the explicit pin is read when it loads. ✅

- Isolating **identity** is a separate deliberate act: set `SUDO_IDENTITY_DIR`
  to something else. Only multi-principal callers (tenancy) do this.

The two-line pin replaces "you must have imported an unrelated module first"
with a local, greppable, testable statement of intent at the isolation site.
- All 11 identity sites resolve through `identityPath()`. The hardcoded
  `'data/…'` literals are folded in, fixing them for staging/tenant as a
  side effect.

## Tradeoffs

- **Two roots instead of one** — more surface. Justified because the two have
  different lifetimes, different isolation policies, and different blast radii;
  they were already separate in practice, just unnamed and enforced by accident.
- **`SUDO_IDENTITY_DIR` is a new env var.** Mitigated by being the *only* new
  knob, and by absorbing the existing ad-hoc `SUDO_SIGNER_KEY_DIR`.
- **Migration touches 11 files.** All mechanical, each independently verifiable.

## Consequences

Removes, rather than adds:

- The module-load-capture workaround in `paths.ts` stops being load-bearing for
  identity. The "intentionally do not move this constant" comment describes a
  SCAFFOLD; this deletes the reason for it.
- **`eval-runner.ts:231-236` credential seeding is deleted**, along with its
  documented accepted risk of racing the host token store. The child sets
  `DATA_DIR` and inherits `SUDO_IDENTITY_DIR`.
- The `SUDO_EVAL_SEED_CREDS` flag is deleted with it.
- Four hardcoded `'data/…'` credential literals stop being wrong under staging.

New failure modes are loud, not silent: a caller that isolates identity by
mistake gets "no usable token" immediately, rather than a quiet failover to a
different model — which is exactly how this was found (a stale token in
`~/.sudo-ai/tui-data/` dated 2026-07-18, 18 days expired, silently in use under
a probe entry point).

## Migration (each step ships independently, behaviour-neutral until step 4)

1. Add `IDENTITY_DIR` + `identityPath()`, defaulting to today's value. **Zero**
   behaviour change. Add the sentinel test: identity does NOT follow a late
   `DATA_DIR` override.
2. Move the 7 `DATA_DIR`-based identity sites to `identityPath()`. Behaviour
   identical; intent now explicit.
3. Fold in the 4 hardcoded `'data/…'` literals. Fixes staging/tenant reads.
4. `eval-runner`: pass `SUDO_IDENTITY_DIR` to the child; **delete** the seeding
   block and `SUDO_EVAL_SEED_CREDS`.
5. `tenant-manager`: set `SUDO_IDENTITY_DIR` explicitly alongside `DATA_DIR`,
   making tenant identity isolation intentional rather than incidental.
6. Interim guard (may land first, independently): static `paths.ts` import in
   `agent-loop-adapter.ts` so the TUI is safe before step 2 lands.

## Open question for Frank

Step 5 changes nothing functionally today but makes tenant credential isolation
explicit. Confirm that a tenant must **never** inherit the owner's OAuth tokens
— the current code achieves this only as a side effect of `ENV_PASSTHROUGH`.
