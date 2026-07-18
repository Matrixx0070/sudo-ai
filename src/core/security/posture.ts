/**
 * Security posture introspection (F104/F106, docs/CORE_ROADMAP.md).
 *
 * A single place that knows which env flags WEAKEN the security posture when
 * active, so boot can announce them loudly instead of each subsystem silently
 * degrading. Pure + injectable env for tests.
 */

export interface WeakeningFlag {
  /** Env var name. */
  flag: string;
  /** What protection is lost while it is active. */
  effect: string;
  /**
   * GW-3: the env VALUE that activates this flag. Default '1'. Kill-switches
   * that weaken when turned OFF use their off-value here (e.g. '0').
   */
  activeWhen?: string;
  /**
   * GW-3: for flags whose "active" condition spans multiple env vars (e.g.
   * Kairos = enabled AND autonomous), a custom predicate overrides activeWhen.
   */
  predicate?: (env: NodeJS.ProcessEnv) => boolean;
}

/** Every flag that, when set to '1', disables or bypasses a protection. */
const WEAKENING_FLAGS: ReadonlyArray<WeakeningFlag> = [
  { flag: 'SUDO_SANDBOX_DISABLE', effect: 'sandbox bypassed — raw execFile for owner turns (untrusted turns still fail closed)' },
  { flag: 'SUDO_SANDBOX_ALLOW_UNCONFINED', effect: 'macOS Seatbelt confinement bypass allowed' },
  { flag: 'SUDO_SECURITY_AUDIT_DISABLE', effect: 'OSV dependency vulnerability audit disabled' },
  { flag: 'SUDO_SIGNING_DISABLE', effect: 'artifact signing disabled' },
  { flag: 'SUDO_KEY_ROTATION_DISABLE', effect: 'signing-key rotation disabled' },
  { flag: 'SUDO_FED_SIGN_DISABLE', effect: 'federation audit-chain signing disabled' },
  { flag: 'SUDO_DASHBOARD_INSECURE', effect: 'dashboard GET auth skipped on loopback' },
  { flag: 'SUDO_TENANCY_ALLOW_UNSAFE', effect: 'tenants may launch without OS isolation' },
  { flag: 'SUDO_SELFBUILD_ALLOW_PROTECTED', effect: 'self-build may write PROTECTED_PATHS' },
  { flag: 'SUDO_MCP_ALLOW_PRIVATE_HOSTS', effect: 'MCP connectors may reach private/loopback hosts (SSRF guard off)' },
  { flag: 'SUDO_ADMIN_API_DANGER', effect: 'dangerous admin API endpoints enabled' },
  { flag: 'SUDO_ALLOW_CONTRADICTORY_CONFIG', effect: 'GW-10 config-contradiction gate bypassed — daemon boots on known-bad flag combos' },
  // GW-3 fail-open-closure flags: kill-switches that weaken when set to their
  // off-value, plus Kairos' default-active restart authority.
  {
    flag: 'SUDO_GATEWAY_UNIFIED_AUTH',
    effect:
      'unified-auth kill-switch — legacy semantics restored for LOOPBACK-DIRECT requests only (proxied/non-loopback still denied)',
    activeWhen: '0',
  },
  {
    flag: 'SUDO_SECURITY_STRICT',
    effect: 'SecurityGuard init failure is NON-fatal — daemon may run without hardening',
    activeWhen: '0',
  },
  {
    flag: 'SUDO_KAIROS',
    effect:
      'Kairos restart authority active — 5-min daemon may execSync + systemctl restart (SUDO_KAIROS=0 disables, SUDO_KAIROS_AUTONOMOUS=0 observe-only, SUDO_KAIROS_DRY_RUN=1 no-op)',
    predicate: (env: NodeJS.ProcessEnv): boolean =>
      env['SUDO_KAIROS'] !== '0' && env['SUDO_KAIROS_AUTONOMOUS'] !== '0',
  },
] as const;

/** Return the subset of posture-weakening flags active in `env`. */
export function collectWeakeningFlags(env: NodeJS.ProcessEnv = process.env): WeakeningFlag[] {
  return WEAKENING_FLAGS.filter((w) =>
    w.predicate ? w.predicate(env) : env[w.flag] === (w.activeWhen ?? '1'),
  );
}

/** One log-ready line per active weakening flag; empty array = clean posture. */
export function postureBannerLines(env: NodeJS.ProcessEnv = process.env): string[] {
  return collectWeakeningFlags(env).map((w) => `${w.flag}=1 — ${w.effect}`);
}

/**
 * GW-3b: strict is now the DEFAULT. A SecurityGuard init failure is FATAL
 * unless SUDO_SECURITY_STRICT=0 is explicitly set (which registers as a
 * posture-weakening flag above). Returns true = strict/fatal.
 */
export function isSecurityStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SECURITY_STRICT'] !== '0';
}
