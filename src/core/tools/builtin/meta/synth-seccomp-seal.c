/*
 * synth-seccomp-seal.c — LD_PRELOAD constructor that installs a stacked
 * seccomp BPF filter denying execve (NR 59) and execveat (NR 322) inside
 * the bwrap child process for tool.synthesize.
 *
 * Design: loaded via LD_PRELOAD inside the already-exec'd node process.
 * The constructor fires before main(), installing NNP + a KILL_PROCESS
 * filter. The baseline 2.2g filter (bwrap-installed) allows execve for bwrap's
 * own exec of node; this stacked filter denies all subsequent execve/execveat
 * from JS code. Kernel AND semantics: both must ALLOW; result is DENY.
 *
 * CRITICAL: Never call exit/abort/_exit. Fail silently — degrade to 2.2g.
 */

#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>

/*
 * BPF filter program:
 *   1. Load arch word (offset 4 in seccomp_data).
 *   2. If arch != AUDIT_ARCH_X86_64 → KILL_PROCESS (wrong arch, unexpected).
 *   3. Load syscall NR (offset 0 in seccomp_data).
 *   4. If NR == 59  (execve)   → KILL_PROCESS.
 *   5. If NR == 322 (execveat) → KILL_PROCESS.
 *   6. Otherwise               → ALLOW.
 */
static struct sock_filter _seal_filter[] = {
    /* Load architecture field */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 4),
    /* If arch == AUDIT_ARCH_X86_64, skip next instruction (continue), else KILL */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    /* Load syscall NR */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 0),
    /* If NR == 59 (execve), skip next → KILL */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 59, 1, 0),
    /* If NR == 322 (execveat), fall-through → KILL; else skip → ALLOW */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 322, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
};

__attribute__((constructor))
static void synth_seal_install(void) {
    struct sock_fprog prog = {
        .len    = (unsigned short)(sizeof(_seal_filter) / sizeof(_seal_filter[0])),
        .filter = _seal_filter,
    };
    /* NNP is required before unprivileged seccomp filter install */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return;
    /* Install filter — ignore return value; failure degrades to 2.2g posture */
    syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog);
}
