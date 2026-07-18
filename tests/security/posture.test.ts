/**
 * F104/F106 + GW-3 — security posture introspection.
 *
 * GW-3 added flags that activate on a NON-default value (kill-switches, via
 * activeWhen) and one default-ACTIVE flag (Kairos restart authority, via a
 * predicate). So the "clean" baseline now must explicitly disable Kairos.
 */
import { describe, it, expect } from 'vitest';
import { collectWeakeningFlags, postureBannerLines, isSecurityStrict } from '../../src/core/security/posture.js';

/** A truly-quiet env: Kairos disabled so nothing is flagged. */
const QUIET = { SUDO_KAIROS: '0' } as NodeJS.ProcessEnv;

describe('posture (F104/F106 + GW-3)', () => {
  it('quiet env (Kairos off) → no weakening flags, no banner lines', () => {
    expect(collectWeakeningFlags(QUIET)).toEqual([]);
    expect(postureBannerLines(QUIET)).toEqual([]);
  });

  it('reports each active =1 weakening flag with its effect', () => {
    const env = {
      SUDO_KAIROS: '0',
      SUDO_SANDBOX_DISABLE: '1',
      SUDO_FED_SIGN_DISABLE: '1',
      SUDO_DASHBOARD_INSECURE: '1',
    } as NodeJS.ProcessEnv;
    const flags = collectWeakeningFlags(env).map((w) => w.flag);
    expect(flags).toEqual(['SUDO_SANDBOX_DISABLE', 'SUDO_FED_SIGN_DISABLE', 'SUDO_DASHBOARD_INSECURE']);
    const lines = postureBannerLines(env);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('SUDO_SANDBOX_DISABLE=1 — ');
  });

  it('ignores non-activating values for =1 flags', () => {
    const env = {
      SUDO_KAIROS: '0',
      SUDO_SANDBOX_DISABLE: '0',
      SUDO_SIGNING_DISABLE: '',
      SUDO_ADMIN_API_DANGER: 'true',
    } as NodeJS.ProcessEnv;
    expect(collectWeakeningFlags(env)).toEqual([]);
  });

  it('covers the full footgun list from the F81 census', () => {
    const all = {
      SUDO_KAIROS: '0',
      SUDO_SANDBOX_DISABLE: '1',
      SUDO_SANDBOX_ALLOW_UNCONFINED: '1',
      SUDO_SECURITY_AUDIT_DISABLE: '1',
      SUDO_SIGNING_DISABLE: '1',
      SUDO_KEY_ROTATION_DISABLE: '1',
      SUDO_FED_SIGN_DISABLE: '1',
      SUDO_DASHBOARD_INSECURE: '1',
      SUDO_TENANCY_ALLOW_UNSAFE: '1',
      SUDO_SELFBUILD_ALLOW_PROTECTED: '1',
      SUDO_MCP_ALLOW_PRIVATE_HOSTS: '1',
      SUDO_ADMIN_API_DANGER: '1',
    } as NodeJS.ProcessEnv;
    expect(collectWeakeningFlags(all)).toHaveLength(11);
  });

  // -- GW-3 additions -------------------------------------------------------

  it('GW-3b: isSecurityStrict is default-true (fatal); only "0" disables it', () => {
    expect(isSecurityStrict({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isSecurityStrict({ SUDO_SECURITY_STRICT: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSecurityStrict({ SUDO_SECURITY_STRICT: 'yes' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSecurityStrict({ SUDO_SECURITY_STRICT: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('GW-3a/3b: kill-switches flag when set to their off-value', () => {
    const env = {
      SUDO_KAIROS: '0',
      SUDO_GATEWAY_UNIFIED_AUTH: '0',
      SUDO_SECURITY_STRICT: '0',
    } as NodeJS.ProcessEnv;
    const flags = collectWeakeningFlags(env).map((w) => w.flag);
    expect(flags).toContain('SUDO_GATEWAY_UNIFIED_AUTH');
    expect(flags).toContain('SUDO_SECURITY_STRICT');
  });

  it('GW-3c: Kairos restart authority is flagged by default (enabled + autonomous)', () => {
    expect(collectWeakeningFlags({} as NodeJS.ProcessEnv).some((f) => f.flag === 'SUDO_KAIROS')).toBe(true);
    // observe-only or disabled → not flagged
    expect(
      collectWeakeningFlags({ SUDO_KAIROS_AUTONOMOUS: '0' } as NodeJS.ProcessEnv).some((f) => f.flag === 'SUDO_KAIROS'),
    ).toBe(false);
    expect(collectWeakeningFlags({ SUDO_KAIROS: '0' } as NodeJS.ProcessEnv).some((f) => f.flag === 'SUDO_KAIROS')).toBe(
      false,
    );
  });
});
