---
name: Wave 2.2c Spec — UID drop + stdout cap + errorName clamp + synth-worker delete + staging flip
version: 1.0
date: 2026-04-19
author: Architect
status: READY
---

# Wave 2.2c Architecture Spec

## KILL-SWITCH FLIP GATE — READ FIRST

SUDO_TOOL_SYNTHESIZE_ENABLED stays OFF in production until Wave 2.2g ships seccomp.
This wave flips the kill-switch ON in the staging pm2 app only (port 18901).
Production env block is UNTOUCHED.

Compensating controls active in staging when kill-switch goes ON:
- bwrap --unshare-net (network namespace sealed)
- bwrap --cap-drop ALL (all Linux capabilities dropped)
- bwrap --unshare-pid/ipc/uts (full namespace isolation)
- process.env scrubbed inside sandbox before any synthesized import
- AST static analysis (31-entry BANNED_MODULES + propName bans + ctor bans)
- ALLOWED_MODULES allowlist (only path/crypto/buffer pass import gate)
- UID/GID drop to nobody:nogroup (65534:65534) inside bwrap child (in-process, this wave)
- stdout byte cap (SIGKILL at >1MB, this wave)
- errorName clamped to 32 chars, stripped to [A-Za-z0-9_] (this wave)

Security gap EXPLICITLY DEFERRED to Wave 2.2g: seccomp BPF syscall filter.
Rationale: Node 22 + V8 + libuv exercise ~80+ distinct syscalls. Hand-crafted BPF
allowlist is brittle — missing one syscall silently crashes V8 at startup. A BPF
generator via libseccomp (distro package, not npm) is Wave 2.2g scope.


## Decision Log

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Seccomp | B — defer to 2.2g | BPF allowlist for Node runtime ~80 syscalls; fragile by hand; strong compensating controls present |
| D2 | UID/GID remap | Y — process.setgid/setuid in synth-bwrap-entry.cjs BEFORE env scrub | bwrap --uid requires --unshare-user; kernel 6.8 blocks --unshare-user+--unshare-pid+--proc/proc (empirically proven Wave 2.2b R1/R2 — HARD RULE). In-script drop via bwrap setuid-root is structurally equivalent. DO NOT add --uid/--gid flags to bwrap argv. |
| D3 | Kill-switch flip scope | Separate apps[1] entry in ecosystem.config.cjs | apps[0] env_staging forces a switch (can't run prod+staging simultaneously); apps[1] sudo-ai-v5-staging on port 18901 runs alongside prod on 18900 |
| D4 | QE test scope | Builder 1 adds 2 smoke tests for own deliverables; full QE extension at Step 6 | Prevents contract-before-impl race between builders |
| D5 | spawnRealWorker sync | Builder 1 owns both buildSynthBwrapArgs AND spawnRealWorker — flags must stay identical | Prevents test helper masking production flag regressions |


## Scope: 5 Tasks

| Task | Owner | Parallel? |
|---|---|---|
| T1 — stdout byte cap + 2 smoke tests | Builder 1 (senior) | Parallel with T2+T3 |
| T2 — UID/GID drop + errorName clamp + delete synth-worker.cjs | Builder 2 (backend) | Parallel with T1+T3 |
| T3 — staging pm2 apps[1] block | Builder 3 (devops) | Parallel with T1+T2 |
| T4 — Integration verify | Integrator | After T1+T2+T3 complete |
| T5 — QE full test suite extension | Quality Engineer | After T4 + Security approved |


## FILE BOUNDARY MAP — ZERO OVERLAP

Builder 1 owns exclusively:
  /root/sudo-ai-v4/src/core/tools/builtin/meta/tool-synthesize.ts
  /root/sudo-ai-v4/tests/meta/meta-tools.test.ts  [spawnRealWorker helper L1407-L1505 + 2 smoke appends only]

Builder 2 owns exclusively:
  /root/sudo-ai-v4/src/core/tools/builtin/meta/synth-bwrap-entry.cjs
  DELETE: /root/sudo-ai-v4/src/core/tools/builtin/meta/synth-worker.cjs

Builder 3 owns exclusively:
  /root/sudo-ai-v4/ecosystem.config.cjs

Quality Engineer (Step 6) owns exclusively:
  /root/sudo-ai-v4/tests/meta/meta-tools.test.ts  [new Wave 2.2c describe block APPENDED at bottom — no other edits]


## TASK 1 — stdout byte cap (Builder 1)

### /root/sudo-ai-v4/src/core/tools/builtin/meta/tool-synthesize.ts

Current spawnBwrapSynth: L658-L735. stdoutChunks is uncapped Buffer[].

Add module-level constant (near other constants, before spawnBwrapSynth):
  const STDOUT_MAX_BYTES = 1_048_576;

Add inside spawnBwrapSynth, immediately before stdoutChunks declaration:
  let stdoutByteCount = 0;

Replace the existing child.stdout 'data' handler (currently: stdoutChunks.push(chunk)):

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutByteCount += chunk.length;
    if (stdoutByteCount > STDOUT_MAX_BYTES) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      promiseResolve({
        ok: false,
        errorCode: 'STDOUT_OVERFLOW',
        errorName: 'SandboxError',
        phase: 'exec',
      });
      return;
    }
    stdoutChunks.push(chunk);
  });

The settled guard MUST be checked before the kill to prevent double-resolve racing
with the close handler. No other changes to this file. NO --uid/--gid flags added here.

### /root/sudo-ai-v4/tests/meta/meta-tools.test.ts (Builder 1 scope)

spawnRealWorker (L1407-L1505): NO changes required this wave. buildSynthBwrapArgs
receives no new flags so the mirror stays current.

Append 2 smoke tests after the last existing describe block:

  describe('Wave 2.2c — smoke: stdout overflow cap', () => {
    it('W22c-STDOUT: >1MB stdout triggers STDOUT_OVERFLOW errorCode', async () => {
      // quarantine: export async function execute() {
      //   process.stdout.write(Buffer.alloc(1_048_577, 0x78));
      // }
      // assert: result.ok === false
      // assert: result.errorCode === 'STDOUT_OVERFLOW'
    });
  });

  describe('Wave 2.2c — smoke: UID drop in sandbox', () => {
    it('W22c-UID: execute() does not throw when getuid() === 65534', async () => {
      // quarantine: export async function execute() {
      //   if (process.getuid() \!== 65534) throw new Error('UID_WRONG');
      // }
      // assert: result.ok === true
    });
  });


## TASK 2 — UID/GID drop + errorName clamp + delete synth-worker.cjs (Builder 2)

### /root/sudo-ai-v4/src/core/tools/builtin/meta/synth-bwrap-entry.cjs

HARD RULE FROM KERNEL CONSTRAINT: Do NOT add --uid or --gid flags to bwrap argv
anywhere in the codebase. bwrap --uid requires --unshare-user. Kernel 6.8 blocks
--unshare-user + --unshare-pid + --proc /proc → "Can't mount proc... Operation not
permitted". This was empirically proven in Wave 2.2b R1/R2 and is a permanent hard rule.
UID drop must be done in-process inside synth-bwrap-entry.cjs.

Change 1 — clampErrorName helper:
Insert after the 'use strict'; line, before the const { pathToFileURL } = require line:

  function clampErrorName(n) {
    const raw = (n \!= null && typeof n === 'string') ? n
                : (n \!= null ? String(n) : 'Error');
    return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 32) || 'Error';
  }

Change 2 — UID/GID drop:
Insert at the TOP of the async function run(), BEFORE the env scrub loop (currently L62):

  // Wave 2.2c: drop to nobody:nogroup (65534:65534) before synthesized code runs.
  // setgid MUST precede setuid — CAP_SETGID is lost once UID drops from 0 to 65534.
  // try/catch: graceful no-op when bwrap not setuid-root (e.g., nested test context).
  try { process.setgid(65534); } catch (_e) { /* non-root or no privilege */ }
  try { process.setuid(65534); } catch (_e) { /* non-root or no privilege */ }

Change 3 — errorName at 3 sites:
  Site 1 (L77 area, in import catch):
    OLD: errorName: (importErr && importErr.name) ? String(importErr.name) : 'Error',
    NEW: errorName: clampErrorName(importErr && importErr.name),

  Site 2 (L110 area, in execErr catch):
    OLD: errorName: (execErr && execErr.name) ? String(execErr.name) : 'Error',
    NEW: errorName: clampErrorName(execErr && execErr.name),

  Site 3 (L129 area, in run().catch handler):
    OLD: errorName: (unexpectedErr && unexpectedErr.name) ? String(unexpectedErr.name) : 'Error',
    NEW: errorName: clampErrorName(unexpectedErr && unexpectedErr.name),

Change 4 — remove stale synth-worker.cjs reference at L41 comment block:
  OLD: * Mirrors the proxy pattern in loader.ts:259-281 and synth-worker.cjs.
  NEW: * Mirrors the proxy pattern in loader.ts:259-281.

### DELETE /root/sudo-ai-v4/src/core/tools/builtin/meta/synth-worker.cjs

Zero live references. Wave 2.2b kept for rollback; 2.2b is APPROVED and deployed.
Command: rm /root/sudo-ai-v4/src/core/tools/builtin/meta/synth-worker.cjs
Verification: grep -r 'synth-worker' /root/sudo-ai-v4/src/ → must return zero lines


## TASK 3 — Staging pm2 apps[1] (Builder 3)

### /root/sudo-ai-v4/ecosystem.config.cjs

The existing apps[0] entry for sudo-ai-v5 is UNTOUCHED. Append a second apps entry.

Full apps[1] definition:

  {
    name: 'sudo-ai-v5-staging',
    namespace: 'default',
    script: 'pnpm',
    args: 'cli',
    interpreter: 'none',
    cwd: CWD,

    instances: 1,
    exec_mode: 'fork',
    autorestart: false,
    max_restarts: 3,
    min_uptime: '10s',
    restart_delay: 3000,

    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file: path.join(CWD, 'data/logs/sudo-ai-v5-staging-out.log'),
    error_file: path.join(CWD, 'data/logs/sudo-ai-v5-staging-err.log'),
    merge_logs: false,

    env: {
      NODE_ENV: 'staging',
      GATEWAY_PORT: '18901',
      CLAUDE_PROXY_PORT: '3004',
      WEB_CHAT_ENABLED: 'true',
      WEB_CHAT_TOKEN: 'QIf2WPVie96Ar2CCmMsPoiTItD1XgtQvTB_Ggdx-dAQ',
      WEB_CHAT_ALLOWED_ORIGINS: 'http://127.0.0.1:18901,http://localhost:18901',
      SUDOAPI_GATEWAY_URL: 'https://sudoapi.shop',
      DATA_DIR: path.join(CWD, 'data-staging'),
      SUDO_TOOL_SYNTHESIZE_ENABLED: '1',
    },
  },

CRITICAL: After adding apps[1], grep the file and confirm SUDO_TOOL_SYNTHESIZE_ENABLED
appears ONLY in the new staging env block, NOT in apps[0] env (L58-L85).

DevOps activation: pm2 start /root/sudo-ai-v4/ecosystem.config.cjs --only sudo-ai-v5-staging


## TASK 4 — Integration (Integrator, Step 4)

All 9 checks must pass before Security review begins:

1. tsc --noEmit from /root/sudo-ai-v4 → zero TypeScript errors
2. grep -r 'synth-worker' /root/sudo-ai-v4/src/ → zero results
3. grep 'clampErrorName' /root/sudo-ai-v4/src/core/tools/builtin/meta/synth-bwrap-entry.cjs → matches
4. grep 'STDOUT_OVERFLOW' /root/sudo-ai-v4/src/core/tools/builtin/meta/tool-synthesize.ts → matches
5. grep 'STDOUT_MAX_BYTES' /root/sudo-ai-v4/src/core/tools/builtin/meta/tool-synthesize.ts → matches
6. grep 'sudo-ai-v5-staging' /root/sudo-ai-v4/ecosystem.config.cjs → matches
7. grep 'SUDO_TOOL_SYNTHESIZE_ENABLED' /root/sudo-ai-v4/ecosystem.config.cjs → appears ONLY in staging block
8. ls /root/sudo-ai-v4/src/core/tools/builtin/meta/synth-worker.cjs → must NOT exist (exit non-zero)
9. pnpm test (from /root/sudo-ai-v4) → 3394/3394 pass (pre-QE baseline)


## TASK 5 — QE Test Suite Extension (Step 6)

QE appends a single new describe block at the end of:
  /root/sudo-ai-v4/tests/meta/meta-tools.test.ts
DO NOT modify any existing tests or the spawnRealWorker helper.

Required test cases (minimum 7):

W22c-1: stdout overflow resolves before timeout
  - write 1_048_577 bytes in execute(); assert result.ok===false, errorCode==='STDOUT_OVERFLOW'
  - assert completes in < 5000ms

W22c-2: errorName non-alphanumeric chars stripped
  - throw with name='exfil:AAAAAA'; assert result.errorName==='exfilAAAAAA'

W22c-3: errorName truncated to <=32 chars
  - throw with name='X'.repeat(100); assert result.errorName.length <= 32

W22c-4: UID === 65534 (verified via throw)
  - execute() throws Error('UID_WRONG') if process.getuid() \!== 65534
  - assert result.ok === true

W22c-5: GID === 65534 (verified via throw)
  - execute() throws Error('GID_WRONG') if process.getgid() \!== 65534
  - assert result.ok === true

W22c-6: synth-worker.cjs deleted (filesystem assertion)
  - assert fs.existsSync('/root/sudo-ai-v4/src/core/tools/builtin/meta/synth-worker.cjs') === false

W22c-7: STDOUT_OVERFLOW settled guard prevents double-resolve
  - write >1MB then hold for 2s; assert final result is STDOUT_OVERFLOW (not timeout rejection)

Target total: 3394 + 2 (Builder 1) + 7 (QE) = 3403 pass. Zero regressions.


## SECURITY GATES (Step 5)

Security Engineer adversarially checks:

1. setgid ORDER: must precede setuid. If inverted, setgid silently fails (CAP_SETGID gone).
2. try/catch on both: graceful no-op in non-root test contexts.
3. clampErrorName: 'exfil:' + process.pid → colon stripped → only numeric PID survives.
   Confirm no secret value reachable via this channel.
4. settled guard in stdout handler: double-resolve impossible with close handler.
5. ecosystem.config.cjs: SUDO_TOOL_SYNTHESIZE_ENABLED absent from apps[0] env — verified by grep.
6. DATA_DIR isolation: data/ (prod) vs data-staging/ (staging) — no SQLite contention.
7. CLAUDE_PROXY_PORT 3004: verify no existing process owns port 3004 on this host.

VETO triggers: (a) setuid before setgid, (b) kill-switch appears in apps[0] env,
(c) double-resolve possible in overflow handler, (d) errorName channel can carry actual secret.


## PERFORMANCE GATE (Step 7)

Baseline: p99 = 273ms (Wave 8F soak, 150 req).
spawnBwrapSynth not on hot path (prod kill-switch OFF).
Assert: 50 req to /health on port 18900, p99 < 300ms. No regression.


## DEVOPS DEPLOYMENT (Step 10)

After Security APPROVED + Quality 100% pass:

1. pnpm build:cli from /root/sudo-ai-v4
2. pm2 reload sudo-ai-v5 --update-env → curl :18900/health → 200
3. mkdir -p /root/sudo-ai-v4/data-staging
4. pm2 start /root/sudo-ai-v4/ecosystem.config.cjs --only sudo-ai-v5-staging
5. curl http://127.0.0.1:18901/health → 200
6. pm2 env <staging-id> | grep SUDO_TOOL_SYNTHESIZE_ENABLED → '1'
7. pm2 env <prod-id> | grep SUDO_TOOL_SYNTHESIZE_ENABLED → (empty — must not appear)


## ACCEPTANCE CRITERIA SUMMARY

Builder 1 DONE when:
  - STDOUT_MAX_BYTES constant defined; stdoutByteCount counter added
  - data handler kills + resolves STDOUT_OVERFLOW before timeout, settled guard present
  - spawnRealWorker unchanged (no --uid/--gid — not this builder's task)
  - 2 smoke tests appended (W22c-STDOUT, W22c-UID)

Builder 2 DONE when:
  - clampErrorName helper defined at top of synth-bwrap-entry.cjs
  - process.setgid(65534) called before process.setuid(65534), both try/catch, before env scrub
  - All 3 errorName sites use clampErrorName()
  - Stale synth-worker comment at L41 removed
  - synth-worker.cjs deleted; grep confirms zero src/ references

Builder 3 DONE when:
  - apps[1] sudo-ai-v5-staging block present with port 18901, data-staging, kill-switch ON
  - apps[0] production env block has no SUDO_TOOL_SYNTHESIZE_ENABLED key
