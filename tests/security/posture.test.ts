/**
 * F104/F106 — security posture introspection.
 */
import { describe, it, expect } from 'vitest';
import { collectWeakeningFlags, postureBannerLines, isSecurityStrict } from '../../src/core/security/posture.js';

describe('posture (F104/F106)', () => {
  it('clean env → no weakening flags, no banner lines', () => {
    expect(collectWeakeningFlags({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(postureBannerLines({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('reports each active =1 weakening flag with its effect', () => {
    const env = {
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

  it('ignores non-"1" values (0, empty, other strings)', () => {
    const env = {
      SUDO_SANDBOX_DISABLE: '0',
      SUDO_SIGNING_DISABLE: '',
      SUDO_ADMIN_API_DANGER: 'true',
    } as NodeJS.ProcessEnv;
    expect(collectWeakeningFlags(env)).toEqual([]);
  });

  it('covers the full footgun list from the F81 census', () => {
    const all = {
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

  it('isSecurityStrict only on exact "1"', () => {
    expect(isSecurityStrict({ SUDO_SECURITY_STRICT: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSecurityStrict({ SUDO_SECURITY_STRICT: 'yes' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSecurityStrict({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
