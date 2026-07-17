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
] as const;

/** Return the subset of posture-weakening flags active in `env`. */
export function collectWeakeningFlags(env: NodeJS.ProcessEnv = process.env): WeakeningFlag[] {
  return WEAKENING_FLAGS.filter((w) => env[w.flag] === '1');
}

/** One log-ready line per active weakening flag; empty array = clean posture. */
export function postureBannerLines(env: NodeJS.ProcessEnv = process.env): string[] {
  return collectWeakeningFlags(env).map((w) => `${w.flag}=1 — ${w.effect}`);
}

/** F104: strict mode — SecurityGuard init failure becomes fatal. */
export function isSecurityStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SECURITY_STRICT'] === '1';
}
