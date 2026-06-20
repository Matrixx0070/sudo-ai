/**
 * @file diagnostic-peer.ts
 * @description Predicate identifying "diagnostic" peers whose conversation turns
 * should NOT be persisted to the daily activity log (workspace/memory/<date>.md).
 *
 * The daily log is prefetched verbatim into every prompt as the "## Today"
 * system message, so anything written here re-surfaces in the model context on
 * every subsequent turn. Loopback / localhost web clients are almost always
 * local probes, health checks, or manual testing against the gateway — their
 * turns pollute that injection without representing real user context (exactly
 * how a batch of shell-probe diagnostics ended up echoed back into prompts).
 *
 * Gated behind SUDO_SKIP_DIAGNOSTIC_DAILY_LOG so default behaviour is
 * byte-identical: with the flag off, nothing is ever skipped. An explicit
 * allowlist (SUDO_DIAGNOSTIC_PEERS, comma-separated) can mark additional peer
 * IDs as diagnostic — e.g. a known test harness address that is not loopback.
 */

/** Canonical loopback / localhost identifiers (lower-cased). */
const LOOPBACK = new Set<string>([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '0.0.0.0',
  'localhost',
]);

/** True when the opt-in skip flag is enabled. Env passed in for testability. */
export function diagnosticDailyLogSkipEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SKIP_DIAGNOSTIC_DAILY_LOG'] === '1';
}

/** Parse SUDO_DIAGNOSTIC_PEERS into a lower-cased set of extra diagnostic peers. */
function extraDiagnosticPeers(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env['SUDO_DIAGNOSTIC_PEERS'];
  if (!raw) return new Set();
  return new Set(
    raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0),
  );
}

/**
 * True if `peerId` denotes a loopback/localhost client, or is explicitly listed
 * in SUDO_DIAGNOSTIC_PEERS. Pure aside from reading env (injectable for tests).
 *
 * Normalises common transport forms: an IPv4 `host:port` (e.g.
 * "127.0.0.1:54822") is reduced to its host; IPv4-mapped IPv6 and bare IPv6
 * loopback are matched directly. Bare IPv6 (which legitimately contains colons)
 * is never port-stripped.
 */
export function isDiagnosticPeer(
  peerId: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!peerId) return false;
  let id = String(peerId).trim().toLowerCase();
  if (id.length === 0) return false;
  // Strip a trailing :port only for IPv4 host:port (never for IPv6).
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(id)) {
    id = id.slice(0, id.lastIndexOf(':'));
  }
  if (LOOPBACK.has(id)) return true;
  return extraDiagnosticPeers(env).has(id);
}

/**
 * Combined gate for daily-log call sites: returns true when the turn should be
 * SKIPPED — i.e. the opt-in flag is enabled AND the peer is diagnostic.
 */
export function shouldSkipDailyLog(
  peerId: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return diagnosticDailyLogSkipEnabled(env) && isDiagnosticPeer(peerId, env);
}
