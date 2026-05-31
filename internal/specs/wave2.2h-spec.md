---
name: Wave 2.2h architect spec — LD_PRELOAD seccomp seal (.so constructor blocks execve after node startup)
description: Stacks a second BPF filter via a C shared library LD_PRELOAD constructor that denies execve/execveat inside the Node 22 bwrap sandbox. Closes the execve gap left open by Wave 2.2g. Zero C wrapper execve-chain. 3 builders (A/B/C). Kill-switch SUDO_EXEC_GATE_DISABLE=1. 48h staging soak gated.
type: project
originSessionId: 7427176e-b1cb-42ab-bdbd-97f5f4e943d0
---
# Wave 2.2h — execve-Deny Seal for tool.synthesize bwrap Child

**Date:** 2026-04-19
**Project:** SUDO-AI v4 at `/root/sudo-ai-v4`
**Baseline:** 3426 pass / 5 pre-existing bwrap flakes / 3 skipped (Wave 2.2g close state)
**Prod pm2:** `sudo-ai-v5` PID 1693148 :18900 (SUDO_TOOL_SYNTHESIZE_ENABLED unset)
**Staging pm2:** `sudo-ai-v5-staging` PID 1693198 :18901 (SUDO_TOOL_SYNTHESIZE_ENABLED=1, seccomp ON)

---

## 1. Scope

Adds a second BPF seccomp filter inside the bwrap child that denies execve (NR 59) and execveat (NR 322). Wave 2.2g filter allows execve because bwrap itself calls it to launch node; BPF cannot distinguish the first execve from a subsequent one. This wave closes that gap using LD_PRELOAD: a C shared library constructor runs inside the already-launched node process and installs a stacked filter that denies execve. Kernel AND semantics: both filters must ALLOW; 2.2g allows execve but 2.2h seal denies it — combined result is DENY for any execve from JS code.

Not in scope: arm64 support, seccomp arg-filtering, changes to synth-seccomp-filter.ts NR allowlist (execve NR 59 stays in 2.2g allowlist — it is still needed for bwrap's own execve before the seal loads).

**Empirically verified on this host (kernel 6.8.0-90-generic, bwrap 0.9.0, Node 22.22.1):**
- `strace -f -e execve /usr/bin/node --import=tsx/loader.mjs -e "..."` outputs exactly 1 execve (the bwrap-to-node exec). Zero internal execves from Node 22 during startup or tsx activation.
- LD_PRELOAD constructor with NNP + seccomp(DENY execve) installed before `main()` — node runs normally; `child_process.execSync('echo')` returns SIGSYS.
- execve-after-filter-install has NO grace window — fires SIGSYS immediately (exit 159, "Bad system call"). The C wrapper approach in the task prompt is architecturally incorrect and verified broken by empirical test.

---

## 2. D1 — Implementation Approach: LD_PRELOAD seal (NOT C wrapper)

**Chosen: C shared library (`synth-seccomp-seal.so`) loaded via `--setenv LD_PRELOAD` inside bwrap.**

**Why the C wrapper approach is broken:**
The task description suggested a wrapper binary that installs execve-deny then calls `execve("/usr/bin/node")`. This fails: `seccomp(SECCOMP_SET_MODE_FILTER)` takes effect immediately — the wrapper's own intended exec of node fires SIGSYS (exit 159). Verified empirically. There is no grace window.

**Why LD_PRELOAD is correct:**
1. bwrap execs node (execve allowed by 2.2g filter — this is bwrap's exec, before seal exists).
2. ld.so loads node runtime deps, then LD_PRELOAD libs.
3. Seal's `__attribute__((constructor))` fires: installs NNP + execve-deny filter on the already-live node process.
4. Node's `main()` continues normally — the constructor does not exec anything.
5. Any subsequent execve/execveat from JS → SIGSYS.

**Filter stacking:** Linux kernel ANDs multiple seccomp filters. 2.2g filter (bwrap-installed) allows execve. Seal filter denies execve. Combined: DENY execve inside node. No changes to synth-seccomp-filter.ts.

**LD_PRELOAD wiring in bwrap:** bwrap `--setenv VAR value` injects env vars inside the container independently of the parent's env scrub. The .so is bind-mounted read-only at `/sandbox/synth-seccomp-seal.so` via `--ro-bind`.

---

## 3. D2 — Build Toolchain

**Build script:** `/root/sudo-ai-v4/scripts/build-synth-seal.sh`

Content:
```bash
#\!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../src/core/tools/builtin/meta/synth-seccomp-seal.c"
OUT="$SCRIPT_DIR/../bin/synth-seccomp-seal.so"
if [[ "$(uname -s)" \!= "Linux" ]] || [[ "$(uname -m)" \!= "x86_64" ]]; then
  echo "[build-synth-seal] Skipping: not Linux x86_64 ($(uname -s)/$(uname -m))" >&2
  exit 0
fi
mkdir -p "$(dirname "$OUT")"
gcc -shared -fPIC -O2 -Wall -Wextra -o "$OUT" "$SRC"
echo "[build-synth-seal] Built: $OUT"
```

**`package.json` script additions (in "scripts" object):**
- `"build:seal": "bash scripts/build-synth-seal.sh"`
- `"postinstall": "pnpm build:seal || true"` (|| true = safe no-op on macOS)

`build:cli` unchanged — esbuild does not bundle the .so.

**Committed artifacts:**
- Source: `/root/sudo-ai-v4/src/core/tools/builtin/meta/synth-seccomp-seal.c`
- Compiled: `/root/sudo-ai-v4/bin/synth-seccomp-seal.so` (pre-built; CI re-runs build:seal on any .c change)

---

## 4. D3 — Binary Location and Sandbox Wiring

**Host path:** `/root/sudo-ai-v4/bin/synth-seccomp-seal.so`
**In-sandbox path (fixed):** `/sandbox/synth-seccomp-seal.so`

**bwrap arg additions in `buildSynthBwrapArgs` (conditional on `sealPath \!= null`):**
```
--ro-bind  <sealPath>  /sandbox/synth-seccomp-seal.so
--setenv   LD_PRELOAD  /sandbox/synth-seccomp-seal.so
```

**Runtime existence check:** If .so absent at host path and kill-switch unset → log warn, skip LD_PRELOAD injection, fail-open to 2.2g behavior. Do NOT throw or abort synthesis.

---

## 5. D4 — C Source: `synth-seccomp-seal.c` (complete spec for Builder A)

**File:** `/root/sudo-ai-v4/src/core/tools/builtin/meta/synth-seccomp-seal.c`

Required headers:
```c
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
```

Filter program (deny execve NR 59 and execveat NR 322, allow all else):
```c
static struct sock_filter _seal_filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 59, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 322, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
};
```

Constructor:
```c
__attribute__((constructor))
static void synth_seal_install(void) {
    struct sock_fprog prog = {
        .len    = (unsigned short)(sizeof(_seal_filter) / sizeof(_seal_filter[0])),
        .filter = _seal_filter,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return;
    syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog);
}
```

Hard constraints: NEVER call exit/abort/_exit. Fail silently (degrade to 2.2g posture).
Compile flags: `-shared -fPIC -O2 -Wall -Wextra`. No external deps beyond libc.

---

## 6. D5 — Kill-Switch

`SUDO_EXEC_GATE_DISABLE=1` — read from parent env. When set, `buildSynthBwrapArgs` omits `--ro-bind` and `--setenv LD_PRELOAD`. bwrap runs as Wave 2.2g. Default: unset (seal ON).

Independent of `SUDO_SECCOMP_DISABLE` and `SUDO_TOOL_SYNTHESIZE_ENABLED`.

---

## 7. D6 — SIGSYS Mapping

Seal fires SECCOMP_RET_KILL_PROCESS → SIGSYS. Existing handler in `tool-synthesize.ts` lines 741-749 maps `signal === 'SIGSYS'` to `{ errorCode: 'SECCOMP_VIOLATION', errorName: 'SandboxError', phase: 'exec' }`. No change needed.

---

## 8. File Boundary Map — Zero Overlap

| Builder | Files Owned | Touch Others? |
|---------|-------------|---------------|
| A | CREATE `src/core/tools/builtin/meta/synth-seccomp-seal.c` | NO |
|   | CREATE `bin/synth-seccomp-seal.so` (compiled artifact) | NO |
|   | CREATE `scripts/build-synth-seal.sh` | NO |
|   | MODIFY `package.json` (add `build:seal` + `postinstall`) | NO |
| B | MODIFY `src/core/tools/builtin/meta/tool-synthesize.ts` | NO |
| C | CREATE `tests/meta/synth-seal.test.ts` | NO |

`synth-bwrap-entry.cjs` — NOT touched. `synth-seccomp-filter.ts` — NOT touched.

GATE-0 interface (A publishes to team-memory/interfaces.md before B starts):
```
SEAL_HOST_PATH = /root/sudo-ai-v4/bin/synth-seccomp-seal.so
getSealPath(): string | null
  - returns SEAL_HOST_PATH if existsSync(SEAL_HOST_PATH) && SUDO_EXEC_GATE_DISABLE \!== '1'
  - returns null otherwise (fail-open)
```

---

## 9. Builder A Full Deliverables

1. `synth-seccomp-seal.c` — per D4 spec, zero warnings, zero errors.
2. `scripts/build-synth-seal.sh` — per D2 spec, chmod +x.
3. `package.json` — add `"build:seal"` and `"postinstall"` to scripts object.
4. Run `pnpm build:seal`, verify `bin/synth-seccomp-seal.so` is ELF 64-bit shared object.
5. Publish GATE-0 interface.

---

## 10. Builder B Full Deliverables

**Only file:** `src/core/tools/builtin/meta/tool-synthesize.ts`

**Change 1 — Add after existing `getSynthBpfFilter` block (~line 25):**
```typescript
const SEAL_HOST_PATH = pathResolve(__dirname, '../../../../../bin/synth-seccomp-seal.so');

export function getSealPath(): string | null {
  if (process.env['SUDO_EXEC_GATE_DISABLE'] === '1') return null;
  if (\!existsSync(SEAL_HOST_PATH)) {
    logger.warn({ path: SEAL_HOST_PATH }, 'synth-seccomp-seal.so not found — execve seal disabled (fail-open to 2.2g)');
    return null;
  }
  return SEAL_HOST_PATH;
}
```
Note: `existsSync` already imported at line 2. `pathResolve` already imported at line 4.

**Change 2 — `buildSynthBwrapArgs` signature (line 607), add export + sealPath param:**
```typescript
export function buildSynthBwrapArgs(quarantinePath: string, seccompFd?: number, sealPath?: string | null): string[]
```

**Change 3 — Inside `buildSynthBwrapArgs`, after `--ro-bind nodeModulesDir nodeModulesDir` push, before `'--'`:**
```typescript
if (sealPath) {
  args.push('--ro-bind', sealPath, '/sandbox/synth-seccomp-seal.so');
  args.push('--setenv', 'LD_PRELOAD', '/sandbox/synth-seccomp-seal.so');
}
```

**Change 4 — In `spawnBwrapSynth` (~line 679), replace existing `buildSynthBwrapArgs` call:**
```typescript
const sealPath = getSealPath();
const bwrapArgs = buildSynthBwrapArgs(quarantinePath, seccompFd, sealPath);
```

No other changes. SIGSYS handler at lines 741-749 unchanged.

---

## 11. Builder C Full Deliverables

**File:** `tests/meta/synth-seal.test.ts`

8 tests, < 5 seconds total, vitest describe/it/expect/vi.

- Test 1: execSync `ls -la /root/sudo-ai-v4/bin/synth-seccomp-seal.so` → contains `.so`. Skip if `SUDO_EXEC_GATE_DISABLE=1`.
- Test 2: `SUDO_EXEC_GATE_DISABLE=1` → `getSealPath()` returns `null`.
- Test 3: `existsSync` stubbed false → `getSealPath()` returns `null`.
- Test 4: `existsSync` stubbed true, kill-switch unset → `getSealPath()` returns string ending `synth-seccomp-seal.so`.
- Test 5: `buildSynthBwrapArgs('/tmp/fake.ts', undefined, '/test/seal.so')` → returned array contains `--ro-bind`, `/test/seal.so`, `--setenv`, `LD_PRELOAD`, `/sandbox/synth-seccomp-seal.so`.
- Test 6: `buildSynthBwrapArgs` with `sealPath = null` → no `--setenv` in returned array.
- Test 7: `buildSynthBwrapArgs` with `sealPath = undefined` → no `--setenv` in returned array.
- Test 8: Mock spawn to emit `close(null, 'SIGSYS')` → spawnBwrapSynth result has `errorCode === 'SECCOMP_VIOLATION'` and `errorName === 'SandboxError'`. (Re-validates Wave 2.2g handler after 2.2h wiring changes.)

---

## 12. Integration Gate

1. `pnpm run build:seal` → exit 0, `bin/synth-seccomp-seal.so` present, `file` shows ELF 64-bit LSB shared object.
2. `pnpm exec tsc --noEmit` → zero errors.
3. `pnpm vitest run tests/meta/synth-seal.test.ts` → 8/8 pass.
4. `pnpm vitest run` → 3426+ pass, ≤ 5 bwrap flakes, 0 new failures.
5. `git diff src/core/tools/builtin/meta/synth-bwrap-entry.cjs` → empty.
6. `git diff src/core/tools/builtin/meta/synth-seccomp-filter.ts` → empty.
7. `SUDO_EXEC_GATE_DISABLE=1 curl :18901/health` → 200 (kill-switch path works).

---

## 13. Security Gate (Opus R1) — Pre-Justified

| Finding | Disposition |
|---------|-------------|
| execve NR 59 in 2.2g allowlist | CORRECT — bwrap needs it; seal's stacked filter closes all subsequent execve |
| LD_PRELOAD via bwrap --setenv | CORRECT — bypasses parent env scrub; constructor fires before JS runs |
| Constructor fails silently | ACCEPTABLE — degrades to 2.2g posture; 2.2g syscall allowlist still active |
| .so bind-mounted read-only | CORRECT — --ro-bind prevents sandbox replacement |
| NNP before filter install | REQUIRED + CORRECT — child UID 65534, no caps; NNP precedes seccomp() |
| execveat (322) also denied | CORRECT — 2.2g already SIGSYS-denies 322; seal adds redundant layer |
| Filter stacking semantics | VERIFIED — kernel ANDs; 2.2g ALLOW + seal DENY = DENY |
| Node 22 zero internal execves | VERIFIED — strace confirmed before writing this spec |

---

## 14. Rollback Plan

Immediate (30 seconds):
```bash
SUDO_EXEC_GATE_DISABLE=1 pm2 restart sudo-ai-v5-staging --update-env
```
No code change. Returns to Wave 2.2g behavior.

Rollback triggers: any benign synth → SECCOMP_VIOLATION; node startup SIGSYS; p99 latency >10% worse than 2.2g baseline; `synth-seccomp-seal.so not found` warnings.

---

## 15. Staging Soak Criteria

- pm2 `sudo-ai-v5-staging`, `SUDO_TOOL_SYNTHESIZE_ENABLED=1`, both kill-switches unset.
- 48 hours minimum.
- All required: zero SECCOMP_VIOLATION for benign calls; zero fd write errors; zero missing-so warnings; p99 latency within 10%; ≥10 successful benign synth calls; 5 pre-existing flakes at same CI rate.
- Prod flip: `pm2 reload sudo-ai-v5 --update-env` with seccomp+seal ON, synthesize still OFF. Second 48h prod soak before enabling synthesize in prod.

---

## 16. Wave Execution Plan

```
GATE-0:  Builder A publishes SEAL_HOST_PATH + getSealPath() interface AND
         confirms pnpm build:seal produces bin/synth-seccomp-seal.so.

WAVE 1 (fully parallel, post GATE-0):
  Builder A — .c + build script + package.json + compile + commit .so
  Builder B — tool-synthesize.ts wiring (blocks on GATE-0 signature only)
  Builder C — synth-seal.test.ts (no blocking dep)

WAVE 2:  Integrator — build:seal + tsc + vitest + regression check
WAVE 3:  Security R1 (Opus)
WAVE 4:  Quality Engineer — 100% pass
WAVE 5:  DevOps — pm2 reload sudo-ai-v5-staging + 48h soak
WAVE 6:  DevOps — pm2 reload sudo-ai-v5 + 48h soak
```

Critical path: A finishes + .so built → Integrator → Security. B and C parallel with A.
Builder cycle estimate: ~20 minutes.

---

## 17. Blockers — None Found

- kernel 6.8.0-90-generic: seccomp(SECCOMP_SET_MODE_FILTER) + filter stacking confirmed.
- gcc 13.3.0 at `/usr/bin/gcc`: -shared -fPIC confirmed working.
- Headers present: `<sys/prctl.h>`, `<linux/seccomp.h>`, `<linux/filter.h>`, `<linux/audit.h>`.
- Constants confirmed: `AUDIT_ARCH_X86_64=0xC000003E`, `PR_SET_NO_NEW_PRIVS=38`, `__NR_execve=59`.
- Node 22.22.1: zero internal execves post-bwrap-entry (strace verified).
- End-to-end: LD_PRELOAD seal works — node starts normally, child_process.execSync → SIGSYS.
