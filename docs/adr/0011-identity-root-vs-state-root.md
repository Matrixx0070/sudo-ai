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

## Root cause found AFTER the above was written — read this first

The TUI isolates `DATA_DIR` for one stated reason (`agent-loop-adapter.ts:71`):
*"to avoid SQLite lock contention with the running daemon … The daemon holds
audit.db / trust.db / veto-overrides.db open with write locks."*

That requirement is **half true, and the true half is an oversight**. Measured
`PRAGMA journal_mode`:

| db | mode |
|---|---|
| `audit.db` | `wal` — readers never block |
| `mind.db` | `wal` |
| **`trust.db`** | **`delete`** — rollback journal; writers block readers cross-process |
| **`veto-overrides.db`** | **`delete`** |

The cause is two omitted lines in one function in `loop.ts`:

```
442:  new Database(path.join(dataDir, 'trust.db'));           // no pragma
469:  new Database(path.join(dataDir, 'veto-overrides.db'));  // no pragma
492:  new Database(mindPath);
493:  try { fbDb.pragma('journal_mode = WAL'); } catch {}     // WAL, 24 lines later
```

`busy_timeout` is set in only four stores (`idempotency`, `prompt-report-store`,
`trace-store`, `llm/logging`) — none of these three.

So the causal chain for everything in this ADR is:

> two missing pragmas → cross-process lock contention → the TUI repoints
> `DATA_DIR` → `DATA_DIR` is also the credential root → credential resolution
> depends on import-graph topology → a stale token silently serves turns

**Consequence for this ADR.** Step 0 below (WAL + `busy_timeout` on the two
stores) may remove the *reason* the TUI and bench isolate `DATA_DIR` at all. If
their overrides can then be deleted, the identity/state conflation stops
mattering for in-process callers, and this ADR's scope shrinks from four callers
to the two where isolation is genuinely intentional — the eval sandbox (child
process, clean state by design) and tenancy (different principal). Those two
still need `identityPath()`; the TUI and bench may need nothing.

Do **not** treat that as settled: it is not proven that WAL removes the observed
contention, only that the named DBs lack the setting that would prevent it. Step
0 must measure before anything is deleted.

### The premise checks out — and the problem is bigger than the TUI

Measured against the live daemon (pid from `pm2 pid sudo-ai-v5`, via
`/proc/<pid>/fd`): all three DBs the comment names **are** held open. The
comment is accurate.

But the same measurement shows **54 open `.db` descriptors for only 20 distinct
files** — the daemon opens the same databases repeatedly, with no shared
connection ownership:

```
12x mind.db   9x audit.db   5x consciousness.db   3x trust.db   3x gateway.db
```

SQLite locks are **per connection, not per process**. In rollback-journal
(`delete`) mode a write takes an EXCLUSIVE lock, so **`trust.db` — 3 connections,
`delete` mode — lets the daemon contend with itself, today, with no TUI
involved.**

### Measured: the contention story is WRONG, the fix is still right

Ran two concurrent writer processes against scratch DBs, mirroring `loop.ts:442`
(plain `new Database()`, no explicit pragma), 300 transactions each:

| journal_mode | solo | 2 concurrent | SQLITE_BUSY |
|---|---|---|---|
| `delete` | **879 ms** | 926 / 1763 ms | **0** |
| `wal` | **2 ms** | 4 / 6 ms | **0** |

Corrections this forces:

- **No lock errors occur, in either mode.** better-sqlite3 defaults
  `busy_timeout = 5000`, so writers *wait* rather than fail. The earlier claim
  that these stores "have no busy_timeout" was wrong — they inherit the driver
  default.
- **Contention is not the dominant cost.** `delete` solo is already 879 ms with
  no concurrency at all. The overhead is rollback-journal fsync per
  transaction — **~440× slower per write than WAL** — not waiting on another
  process. (Writers do serialize: B finishes at ~2× solo. But SQLite serialises
  writers in WAL too, where it costs microseconds.)
- **Therefore `DATA_DIR` isolation never addressed the real problem.** A private
  copy of `trust.db` is still in `delete` mode and still pays 2.9 ms/write. The
  isolation bought little and cost a credential-resolution hazard.

Re-run against a **copy of the real `data/trust.db`** (3.6 MB, 32,270 rows, 1
index, ext4 — the same filesystem as `data/`, so fsync behaviour matches):

| journal_mode | solo | 2 concurrent | per write | SQLITE_BUSY |
|---|---|---|---|---|
| `delete` | 838 ms | 857 / 881 ms | **2.79 ms** | 0 |
| `wal` | 4 ms | 7 / 23 ms | **0.01 ms** | 0 |

The real-data run sharpens the conclusion:

- **Concurrency costs 2–5%.** Two writer processes on the real DB finish in
  857/881 ms against an 838 ms solo baseline. The synthetic run's apparent 2×
  serialisation (1763 ms) did **not** reproduce — that was measurement noise.
- **Journal mode costs ~280×** — 2.79 ms vs 0.01 ms per write.

So the workaround and the problem are on different scales: `DATA_DIR` isolation
addresses the 5% effect, while the 280× effect sits untouched in both the shared
and the isolated copy. Step 0 (WAL) is the whole win; the isolation was never
load-bearing.

### Sizing it: the workaround costs far more than the problem

Measured the actual write rate from `trust_outcomes.ts` (ids are UUIDs, unique
per event, so row count **is** write count — no writes hidden by
`INSERT OR REPLACE`):

| | |
|---|---|
| writes, last 1 h | 94 |
| writes, last 24 h | 1,154 |
| writes, last 7 d | 4,287 |
| span | 2026-05-31 → 2026-08-06 (32,270 rows) |

At 2.79 ms vs 0.01 ms per write:

```
delete cost/day : 3.22 s
wal    cost/day : 0.012 s
SAVING FROM WAL : 3.21 s/day
```

**Step 0's throughput justification collapses.** Converting a live database the
daemon holds open needs a maintenance window; 3.2 seconds per day does not buy
one. Apply WAL opportunistically — it is two lines matching what `mind.db`
already does 24 lines later — but it is not a priority and must not be sold as
a performance fix.

The decisive conclusion is about the **workaround**, not the pragma:

> A 3-second-per-day inefficiency prompted a `DATA_DIR` override, which forked
> credential resolution, which let an 18-day-expired token silently serve turns
> while the UI named a model that never ran.

The isolation addresses ~5% of a 3.2 s/day cost and carries a credential
hazard. That is a clear net loss, and it is now measured rather than argued.

### Completeness: the third database has never been written

`veto-overrides.db` — the other `delete`-mode store, and the third database the
TUI comment names — holds **0 rows**, is 24 KB, and its mtime is
**2026-05-31 22:24**, its creation date. Nothing has written it in 67 days. The
daemon holds it open (confirmed via `/proc/<pid>/fd`), but an open connection
that never writes takes no exclusive lock, so it contributes **zero** contention.

Full accounting of the justification for isolating `DATA_DIR`:

| db | state | contention contributed |
|---|---|---|
| `audit.db` | already `wal` | none |
| `trust.db` | `delete`, 1,154 writes/day | 3.2 s/day total |
| `veto-overrides.db` | `delete`, **0 rows, never written** | none |

### Do not inherit the comment's framing — surveyed all 21 databases

The accounting above trusts `agent-loop-adapter.ts:71` to have named the right
databases. It did not. Surveying `PRAGMA journal_mode` across every DB in
`data/` finds **six** in `delete` mode, and the comment names the two harmless
ones while missing an active one:

| `delete`-mode db | size | writes/day | cost @ 2.79 ms |
|---|---|---|---|
| `trust.db` | 3.6 MB | 1,154 | 3.22 s/day |
| **`calibration.db`** | **1.5 MB** | **760** | **2.12 s/day** |
| `resolutions.db` | 20 KB | ~0 (last write Jun 29) | 0 |
| `veto-overrides.db` | 24 KB | 0 (never) | 0 |
| `billing.db`, `cron.db` | **0 bytes** | 0 | 0 |

`calibration.db` is written by `verify-gate.ts` on the **per-tool-call** path —
squarely in the AgentLoop the TUI runs — and appears nowhere in the comment that
justifies the isolation.

**Corrected total: 1,914 writes/day ≈ 5.34 s/day** across all `delete`-mode
stores, up from the 3.2 s/day figure derived from the comment's list.

The conclusion survives the correction: 5.3 seconds per day still does not
justify a workaround that forks credential resolution. Two of the six are 0-byte
files, and one has never been written in 67 days.

If WAL is ever applied opportunistically, apply it to `trust.db` **and
`calibration.db`** — the comment's list would have missed 40% of the real cost.

**Revised priority:**

1. **Delete the TUI's `DATA_DIR` override** (`agent-loop-adapter.ts:82`) — it
   buys ~0.16 s/day and costs correctness. Verify the TUI still runs cleanly
   against a shared `data/`; the numbers above say it will.
2. Keep `credentialPath()` **only** for the two callers whose isolation is
   genuine — the eval sandbox (child process) and tenancy (different principal).
   Steps 2-3 shrink accordingly; the TUI and bench need nothing.
3. WAL: opportunistic, unprioritised.

It also surfaces the next layer down, out of scope here: **the state layer has no
connection ownership model.** 12 connections to `mind.db` from one process is
not a tuning problem, it is a missing abstraction — and it is the reason
"isolate by pointing at a different directory" became the tool of choice for
every caller with a locking complaint.

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

/** Principal credentials — OAuth tokens, web-seat sessions, device identity, keys. */
export const CREDENTIAL_DIR: string =
  process.env['SUDO_CREDENTIAL_DIR'] ?? DATA_DIR

export function credentialPath(...segments: string[]): string
```

**Naming — why `SUDO_CREDENTIAL_DIR` and not `SUDO_IDENTITY_DIR`.** The obvious
name is already taken by an unrelated subsystem: `agent/alignment-seed.ts:92`
`resolveIdentityDir()` reads `SUDO_IDENTITY_DIR` as the directory holding the
operator identity-ANCHOR DOCUMENTS (`core-identity.md`, `values.json`,
`hard-prohibitions.yaml`; default `<root>/config`, shipped since F108). It was
already in `flag-manifest.json` under that meaning, which is why a manifest
regeneration did not flag the clash. Reusing it makes one subsystem silently
reconfigure the other, in **both** directions — measured on the first cut of
this change, three fresh processes:

| `SUDO_IDENTITY_DIR` | alignment anchor dir | anchor present | credential root |
|---|---|---|---|
| unset | `<root>/config` | (n/a here) | `<root>/data` |
| `/tmp/pc-config` (its **own** meaning) | `/tmp/pc-config` | **true** | **`/tmp/pc-config`** ← every OAuth store moves → "no usable token" |
| `<root>/data` (the pin this ADR **prescribes**) | **`<root>/data`** | **false** | `<root>/data` ← anchor lost → `DEGRADED_SEED` ≈0.51, below the 0.6 min-align gate → governance gates fail closed |

That is exactly the class of bug this ADR exists to remove, so the credential
root is named `SUDO_CREDENTIAL_DIR` / `CREDENTIAL_DIR` / `credentialPath()`.
`SUDO_IDENTITY_DIR` keeps its original alignment-anchor meaning, untouched.
Both directions are pinned by `tests/core/shared/credential-root.test.ts`, each
with its own discriminator (the knob is shown to move its *own* subsystem in the
same run, so "the other did not move" cannot pass vacuously).

Note the default is `DATA_DIR`, **not** `PROJECT_ROOT/data`. Defaulting to the
project root would silently repoint staging (`ecosystem.config.cjs:846` sets
`DATA_DIR=data-staging` at process start) at *production* credentials. Identity
must follow a `DATA_DIR` set **before the process starts** — that is a
deployment decision — and must ignore one reassigned **mid-process**, which is
only ever a state-isolation request.

Rules:

- **An in-process caller that isolates state must pin identity first:**

  ```ts
  process.env['SUDO_CREDENTIAL_DIR'] ??= DATA_DIR; // pin the real root
  process.env['DATA_DIR'] = myPrivateStateDir;     // then isolate state
  ```

  This is correct under either import order, which is what makes it a design
  rather than another accident:
  - `paths.ts` already loaded → `CREDENTIAL_DIR` captured the real root. ✅
  - `paths.ts` not yet loaded → the explicit pin is read when it loads. ✅

- Isolating **credentials** is a separate deliberate act: set `SUDO_CREDENTIAL_DIR`
  to something else. Only multi-principal callers (tenancy) do this.

The two-line pin replaces "you must have imported an unrelated module first"
with a local, greppable, testable statement of intent at the isolation site.
- All identity sites resolve through `credentialPath()`. The hardcoded
  `'data/…'` literals are folded in, fixing them for staging/tenant as a
  side effect.

## Tradeoffs

- **Two roots instead of one** — more surface. Justified because the two have
  different lifetimes, different isolation policies, and different blast radii;
  they were already separate in practice, just unnamed and enforced by accident.
- **`SUDO_CREDENTIAL_DIR` is a new env var.** Mitigated by being the *only* new
  knob, and by absorbing the existing ad-hoc `SUDO_SIGNER_KEY_DIR`.
- **Migration touches 11 files.** All mechanical, each independently verifiable.

## Consequences

Removes, rather than adds:

- The module-load-capture workaround in `paths.ts` stops being load-bearing for
  identity. The "intentionally do not move this constant" comment describes a
  SCAFFOLD; this deletes the reason for it.
- **`eval-runner.ts:231-236` credential seeding is deleted**, along with its
  documented accepted risk of racing the host token store. The child sets
  `DATA_DIR` and inherits `SUDO_CREDENTIAL_DIR`.
- The `SUDO_EVAL_SEED_CREDS` flag is deleted with it.
- Four hardcoded `'data/…'` credential literals stop being wrong under staging.

New failure modes are loud, not silent: a caller that isolates identity by
mistake gets "no usable token" immediately, rather than a quiet failover to a
different model — which is exactly how this was found (a stale token in
`~/.sudo-ai/tui-data/` dated 2026-07-18, 18 days expired, silently in use under
a probe entry point).

## Migration (each step ships independently, behaviour-neutral until step 4)

0. **Fix the root cause first.** Add `journal_mode = WAL` + `busy_timeout` to
   `loop.ts:442` (`trust.db`) and `loop.ts:469` (`veto-overrides.db`), matching
   what line 493 already does for `mind.db`. Then **measure** whether the TUI
   still contends with the daemon on a shared `data/`. If it does not, delete
   the `DATA_DIR` override at `agent-loop-adapter.ts:82` and re-measure the
   bench runner's. Every later step shrinks or disappears in proportion.
   Converting a live DB the daemon holds open needs a maintenance window —
   treat as an operational change, not a code-only one.

1. Add `CREDENTIAL_DIR` + `credentialPath()`, defaulting to today's value. **Zero**
   behaviour change. Add the sentinel test: identity does NOT follow a late
   `DATA_DIR` override.
2. Move the 7 `DATA_DIR`-based identity sites to `identityPath()`. Behaviour
   identical; intent now explicit.
3. Fold in the 4 hardcoded `'data/…'` literals. Fixes staging/tenant reads.
4. `eval-runner`: pass `SUDO_CREDENTIAL_DIR` to the child; **delete** the seeding
   block and `SUDO_EVAL_SEED_CREDS`.
5. `tenant-manager`: set `SUDO_CREDENTIAL_DIR` explicitly alongside `DATA_DIR`,
   making tenant identity isolation intentional rather than incidental.
6. Interim guard (may land first, independently): static `paths.ts` import in
   `agent-loop-adapter.ts` so the TUI is safe before step 2 lands.

## Open question for Frank

Step 5 changes nothing functionally today but makes tenant credential isolation
explicit. Confirm that a tenant must **never** inherit the owner's OAuth tokens
— the current code achieves this only as a side effect of `ENV_PASSTHROUGH`.

## Implementation status

**Steps 1–3 executed (2026-08-06).** Steps 0, 4, 5 remain open — they change
behaviour (or need a maintenance window) and belong in separately reviewed
changes.

- Step 1 — `CREDENTIAL_DIR` + `credentialPath()` added to `core/shared/paths.ts`,
  defaulting to `DATA_DIR`. Pinned by `tests/core/shared/credential-root.test.ts`
  (fresh-process sentinel protocol; every case carries a discriminator so a pass
  cannot be vacuous).
- Steps 2–3 — **15 sites** migrated (see the reconciliation below). Resolved
  paths verified unchanged under the default root and under a pre-start
  `DATA_DIR=data-staging`; the ex-hardcoded `data/…` literals now follow the
  root, which was the point.
- `xai-*` and `grok-*` stores reach `credentialPath` through
  `llm/grok-runtime.ts`, the extraction seam, per the rule in that file.

### Re-derived site list — the first pass under-counted

The list at the top of this ADR came from one grep and named 11 sites. Deriving
it a second, independent way — the eval sandbox's own credential seeds
(`eval-runner.ts:231`), what `security-audit.ts` guards, a `find` over
`data/*.json` + `data/keys/` filtered on mode `0600`, and an enumeration of
**every** `path.join(DATA_DIR, …)` / `dataPath(…)` in `src/` — found **three
more credential sites that the first migration missed**:

| missed site | store | evidence it is a credential |
|---|---|---|
| `llm/gemini-web-session-manager.ts:59` | `gemini-web-session.json` | captured Google account cookies (`__Secure-1PSID`) — on disk, 0600 |
| `llm/grok-web-session-manager.ts:37` | `grok-web-session.json` | grok.com cookie + statsigId — on disk, 0600 |
| `llm/grok-voice-session.ts:29` | *same* `grok-web-session.json` | a **second, independent** literal for the same store |

They were missed because the first derivation pattern-matched on `oauth` /
`token` / `key` names; a *web-seat session* is a credential that carries neither
word. Both stores exist in the live `data/` at 0600 and both would have been
stranded by any state isolation — precisely the failure this ADR is about.

Full reconciliation (15 sites, 12 distinct stores):

| store | site(s) | status |
|---|---|---|
| `claude-oauth.json` | `llm/claude-oauth-manager.ts`, `cli/commands/doctor.ts` | migrated (first pass) |
| `xai-oauth.json` | `llm/xai-oauth-manager.ts`, `security-audit.ts` | migrated (first pass) |
| `xai-apikey.json` | `llm/xai-apikey-manager.ts` | migrated (first pass) |
| `gemini-gpsoauth-seed.json` | `llm/gemini-gpsoauth-reauth.ts` | migrated (first pass) |
| `keys/` | `security/artifact-signer.ts`, `security/signer.ts` | migrated (first pass; absorbs `SUDO_SIGNER_KEY_DIR`) |
| `device-identity.json` | `core/fleet/device-identity.ts`, `cli.ts` | migrated (first pass) |
| `youtube-oauth.json` | `core/youtube/auth.ts` | migrated (first pass; was hardcoded) |
| `oauth-creds.json` | `security/security-audit.ts` | migrated (first pass; was hardcoded) |
| `xai-oauth.json`, `oauth.json` (reset targets) | `core/onboard/onboard.ts` | migrated (first pass; kept RELATIVE, see below) |
| **`gemini-web-session.json`** | `llm/gemini-web-session-manager.ts` | **migrated in this revision** |
| **`grok-web-session.json`** | `llm/grok-web-session-manager.ts`, `llm/grok-voice-session.ts` | **migrated in this revision** |

Behaviour-neutrality was re-verified for all 15 after the additions: under an
unset `DATA_DIR` and under a pre-start `DATA_DIR=<root>/data-staging`, every
resolved path is byte-identical to the expression it replaced (the two
ex-hardcoded literals diverge under staging — that is the intended fix). With
`SUDO_CREDENTIAL_DIR=<root>/data` + `DATA_DIR=/tmp/private-state`, state moves
and all twelve stores stay put.

**Deviation from step 3 — `onboard.ts` reset targets stay RELATIVE.** The ADR
listed `onboard.ts:191` alongside the other hardcoded literals, but its contract
differs: every reset target is passed through `assertNotFrozen()` (which matches
PROTECTED_PATHS on relative POSIX paths) and then `path.join(deps.rootDir, rel)`.
An absolute `credentialPath()` would defeat both — silently bypassing the
frozen-path guard on a destructive path. The targets now track the credential
root *relatively*; if it is outside the project root, no safe relative
expression exists, so the credential targets are omitted and reset deletes
nothing rather than deleting the wrong file.

**Correction found during migration — `cli.ts` device identity.** The call site
read `process.env['DATA_DIR'] ?? '/tmp'`, so with `DATA_DIR` unset the device
keypair landed in world-writable `/tmp`. That leak is real:
`/tmp/device-identity.json` exists, dated 2026-06-14. It now resolves to
`CREDENTIAL_DIR`. Behaviour is identical wherever `DATA_DIR` is set — prod and
staging both set it in `ecosystem.config.cjs`.

**Credential-adjacent sites deliberately NOT migrated** (surfaced by re-deriving
the list; each needs its own decision, none is a `DATA_DIR`-vs-credential bug):

| site | why not |
|---|---|
| `api/admin/security-helpers.ts:19` `api-tokens.json` | gateway API tokens — instance auth, not principal identity |
| `tools/builtin/system/credential-manager.ts:38-40` vault + salt + hmac | user-managed secret vault; own lifecycle |
| `security/key-rotation-store.ts:29` `data/keys/key-rotation.db` | a **db** (state) that happens to live under `keys/`; hardcoded, and out of scope here |
| `brain/claude-token-manager.ts:18` `/root/.claude/.credentials.json` | external CLI's store, outside any sudo-ai root |
| `security/vault-credentials.ts:33` `workspace/vault` | already has its own `SUDO_CRED_VAULT_DIR` override |
| `gdrive/changes.ts:22` `changes-token.json` | a sync cursor, not a credential |
| `gdrive/auth.ts` `oauthTokenFile` | already has its own `GDRIVE_OAUTH_TOKEN_FILE` override; no `DATA_DIR` default |
| `core/channels/whatsapp.ts:53` `data/whatsapp-auth` | a **config-declared** path (`channels.json5` `sessionPath`), not a `paths.ts` resolution — moving it is a config migration |
| `scripts/prod-oauth-step.ts:16` `dataPath('claude-oauth.json')` | a manual operator script, run with default env; left as state-rooted deliberately so it can never write into an isolated credential root by surprise |

**Unrelated fragility noticed, not fixed here:** `alignment-seed.ts:92` reads
its var with `??`, so `SUDO_IDENTITY_DIR=''` resolves the anchor dir to `''`
rather than the default. It fails safe (no anchor → `DEGRADED_SEED`) and is
outside this change's scope.
