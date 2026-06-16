/**
 * @file host-gate.ts
 * @description Q3 — DNS-rebinding / SSRF defense at the gateway boundary.
 *
 * Validates the incoming `Host:` header against an allowlist of hostnames
 * before any route handler fires. Closes the attack vector where an attacker
 * sets up `evil.com` → DNS-resolves to `127.0.0.1`, tricks a victim's browser
 * (already authenticated to the local gateway) into fetching `evil.com:18900`,
 * and rides the cookies/session to internal services. The Host header on
 * those cross-origin requests carries the attacker's domain, so mismatching
 * it 403s before any route is dispatched.
 *
 * Same defense pattern as `checkHostHeader` in dashboard-server.ts
 * (GHSA-ppp5-vxwm-4cf7 precedent). Re-implemented here rather than imported
 * to keep the gateway/ → dashboard/ layer boundary clean.
 *
 * Default ON. Kill-switch: SUDO_SSRF_HOST_GATE=0.
 * Extension: SUDO_SSRF_ALLOWED_HOSTS=h1,h2 (comma-separated hostnames; no port
 * needed — comparison is hostname-only after port stripping).
 *
 * Out of scope: federation peer hosts. Operators running federation must
 * extend SUDO_SSRF_ALLOWED_HOSTS or set SUDO_SSRF_HOST_GATE=0.
 */

const DEFAULT_ALLOWED_HOSTS: ReadonlyArray<string> = ['127.0.0.1', 'localhost', '::1'];

/** Flag check at call time (not module load) so tests can toggle the env. */
export function isHostGateEnabled(): boolean {
  return process.env['SUDO_SSRF_HOST_GATE'] !== '0';
}

/**
 * Resolve the effective allowlist: defaults + comma-separated env extension.
 * Empty extension is fine; whitespace-only entries are dropped.
 */
export function getAllowlist(): ReadonlyArray<string> {
  const raw = process.env['SUDO_SSRF_ALLOWED_HOSTS'] || '';
  const extras = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...DEFAULT_ALLOWED_HOSTS, ...extras];
}

/**
 * Returns true if the Host header is acceptable. Port is stripped before
 * comparison — the bound port is fixed at the listener level; only the
 * hostname is what's at risk of DNS rebinding.
 *
 * IPv6 brackets handled: `[::1]:18900` strips to `[::1]` (note: NOT `::1`).
 * Callers can either include `[::1]` in the allowlist OR pass the bracketed
 * form via SUDO_SSRF_ALLOWED_HOSTS. DEFAULT_ALLOWED_HOSTS includes the
 * un-bracketed `::1` and we strip brackets explicitly below so both forms
 * match.
 */
export function isHostAllowed(hostHeader: string | undefined): boolean {
  if (typeof hostHeader !== 'string') return false;
  const trimmed = hostHeader.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();

  let host: string;
  if (lower.startsWith('[')) {
    // IPv6: take through the closing ']' and then strip the brackets so
    // the bare-ip form (`::1`) in DEFAULT_ALLOWED_HOSTS matches.
    const closingBracket = lower.indexOf(']');
    host = closingBracket >= 0 ? lower.slice(1, closingBracket) : lower;
  } else {
    const colonIdx = lower.lastIndexOf(':');
    host = colonIdx >= 0 ? lower.slice(0, colonIdx) : lower;
  }

  return getAllowlist().includes(host);
}
