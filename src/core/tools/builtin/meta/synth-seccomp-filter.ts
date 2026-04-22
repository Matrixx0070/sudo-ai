// Pure-Node cBPF assembler for the tool.synthesize bwrap child.
// Targets x86_64 (AUDIT_ARCH_X86_64 = 0xC000003E). Compiled once, cached, never written to disk.
// Exports: compileSynthBpfFilter(): Buffer  |  _resetFilterCache(): void (test-only)

// cBPF opcode constants
const BPF_LD  = 0x00, BPF_W = 0x00, BPF_ABS = 0x20;
const BPF_JMP = 0x05, BPF_JEQ = 0x10, BPF_RET = 0x06, BPF_K = 0x00;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW        = 0x7fff0000;
const SECCOMP_DATA_NR_OFFSET   = 0; // offset of nr   field in seccomp_data
const SECCOMP_DATA_ARCH_OFFSET = 4; // offset of arch field in seccomp_data
const AUDIT_ARCH_X86_64        = 0xC000003E;

// Allowlist — conservative, per Wave 2.2g spec §3.
// SIGSYS-denied (do NOT add): 83 88 112 101 165 166 155 161 125 126 321 298 317 322
const ALLOWED_NRS: readonly number[] = [
  // Memory
  9, 10, 11, 12, 25, 26, 28,
  // Threading
  24, 56, 131, 186, 202, 204, 218, 234, 273, 274, 334, 435,
  // IO / VFS
  0, 1, 3, 4, 5, 6, 8, 16, 17, 18, 19, 20, 21, 22, 33,
  72, 79, 80, 81, 85, 89, 137, 138, 217, 257, 262, 267,
  292, 293, 295, 296, 327, 328, 332,
  // IO Async / epoll
  213, 232, 233, 281, 291, 425, 426, 427, 441,
  // Polling
  7, 23, 270, 271,
  // Signals
  13, 14, 15, 62, 127, 128, 200, 289,
  // Process / Identity (setuid family ALLOWED — returns EPERM; entry.cjs try/catch)
  // execve ALLOWED in 2.2g: bwrap uses it; Wave 2.2h closes via C wrapper
  39, 59, 60, 61, 95, 97, 98, 99,
  102, 104, 105, 106, 107, 108, 110,
  113, 114, 117, 118, 119, 120,
  157, 231, 247,
  // Time
  35, 96, 228, 229, 230,
  // Network (AF_NETLINK + AF_UNIX; --unshare-net removes AF_INET/AF_INET6)
  41, 42, 44, 45, 46, 47, 51, 53, 54, 55,
  // Misc
  63, 158, 290, 302, 318, 324, 424, 434,
];

// Build the raw cBPF byte program.
// Layout:
//   [0]        LD  W ABS [ARCH_OFFSET]
//   [1]        JEQ AUDIT_ARCH_X86_64, jt=1, jf=0
//   [2]        RET KILL_PROCESS            (wrong arch)
//   [3]        LD  W ABS [NR_OFFSET]
//   [4..4+n-1] JEQ nr[idx], jt=(n-idx), jf=0
//   [4+n]      RET KILL_PROCESS            (not in allowlist)
//   [4+n+1]    RET ALLOW
function _compile(): Buffer {
  const nrs: number[] = [...new Set(ALLOWED_NRS)].sort((a, b) => a - b);
  const n = nrs.length;

  if (n > 255) {
    throw new Error(
      `BPF allowlist has ${n} entries — exceeds uint8 jt cap of 255. Refactor to chained JA blocks.`,
    );
  }

  const total = n + 6; // 4 header + n JEQs + 2 footer
  const buf   = Buffer.allocUnsafe(total * 8);
  let i = 0;

  function emit(code: number, jt: number, jf: number, k: number): void {
    buf.writeUInt16LE(code,    i * 8);
    buf.writeUInt8(jt,         i * 8 + 2);
    buf.writeUInt8(jf,         i * 8 + 3);
    buf.writeUInt32LE(k >>> 0, i * 8 + 4); // >>> 0 forces unsigned 32-bit
    i++;
  }

  emit(BPF_LD  | BPF_W | BPF_ABS, 0, 0, SECCOMP_DATA_ARCH_OFFSET); // [0] load arch
  emit(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, AUDIT_ARCH_X86_64);        // [1] arch check
  emit(BPF_RET | BPF_K,           0, 0, SECCOMP_RET_KILL_PROCESS);  // [2] wrong arch
  emit(BPF_LD  | BPF_W | BPF_ABS, 0, 0, SECCOMP_DATA_NR_OFFSET);   // [3] load NR

  // [4..4+n-1]: jt = n - idx  (ALLOW is at 4+n+1; relative = (4+n+1)-(4+idx)-1 = n-idx)
  for (let idx = 0; idx < n; idx++) {
    emit(BPF_JMP | BPF_JEQ | BPF_K, n - idx, 0, nrs[idx]);
  }

  emit(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS); // [4+n]   not allowed
  emit(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW);        // [4+n+1] matched

  if (i !== total) {
    throw new Error(`BPF instruction count mismatch — jump arithmetic bug: wrote ${i}, expected ${total}`);
  }

  return buf;
}

// Cache
let _cachedFilter: Buffer | null = null;

/** Returns the compiled cBPF seccomp filter (cached after first call; never written to disk). */
export function compileSynthBpfFilter(): Buffer {
  if (_cachedFilter) return _cachedFilter;
  _cachedFilter = _compile();
  return _cachedFilter;
}

/** Resets the compiled filter cache. FOR TEST USE ONLY. */
export function _resetFilterCache(): void {
  _cachedFilter = null;
}
