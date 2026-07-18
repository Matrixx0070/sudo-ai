/**
 * GW-10: config-ambiguity rejection + flag lint.
 */
import { describe, it, expect } from 'vitest';
import {
  lintFlags,
  isContradictionOverride,
  CONTRADICTIONS,
} from '../../src/core/config/flag-lint.js';
import { collectWeakeningFlags } from '../../src/core/security/posture.js';
import manifestJson from '../../src/core/config/flag-manifest.json' with { type: 'json' };

const MANIFEST: string[] = (manifestJson as { flags: string[] }).flags;
const noFiles = { fileExists: () => false };
const allFiles = { fileExists: () => true };

describe('GW-10 ghost flags', () => {
  it('flags a SUDO_* env var that no code reads', () => {
    const env = { SUDO_TOTALLY_FAKE_GHOST_FLAG: '1' } as unknown as NodeJS.ProcessEnv;
    const { ghosts } = lintFlags(env, MANIFEST, allFiles);
    expect(ghosts).toContain('SUDO_TOTALLY_FAKE_GHOST_FLAG');
  });
  it('does NOT flag a known flag from the manifest', () => {
    expect(MANIFEST).toContain('SUDO_SECURITY_STRICT');
    const env = { SUDO_SECURITY_STRICT: '0' } as unknown as NodeJS.ProcessEnv;
    const { ghosts } = lintFlags(env, MANIFEST, allFiles);
    expect(ghosts).not.toContain('SUDO_SECURITY_STRICT');
  });
  it('ignores non-SUDO_ env vars', () => {
    const env = { PATH: '/x', HOME: '/y' } as unknown as NodeJS.ProcessEnv;
    expect(lintFlags(env, MANIFEST, allFiles).ghosts).toEqual([]);
  });
});

describe('GW-10 contradictions', () => {
  it('unified-auth off with token set', () => {
    const env = { SUDO_GATEWAY_UNIFIED_AUTH: '0', GATEWAY_TOKEN: 'x' } as unknown as NodeJS.ProcessEnv;
    const ids = lintFlags(env, MANIFEST, allFiles).contradictions.map((c) => c.id);
    expect(ids).toContain('unified-auth-off-with-token');
  });
  it('sandbox disabled with untrusted inbound', () => {
    const env = { SUDO_SANDBOX_DISABLE: '1', WEBHOOKS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;
    const ids = lintFlags(env, MANIFEST, allFiles).contradictions.map((c) => c.id);
    expect(ids).toContain('sandbox-disabled-with-untrusted-inbound');
  });
  it('sandbox disabled WITHOUT inbound is fine', () => {
    const env = { SUDO_SANDBOX_DISABLE: '1' } as unknown as NodeJS.ProcessEnv;
    const ids = lintFlags(env, MANIFEST, allFiles).contradictions.map((c) => c.id);
    expect(ids).not.toContain('sandbox-disabled-with-untrusted-inbound');
  });
  it('secrets-ref file missing WARNS (not a boot-refusal) — MEDIUM-2', () => {
    const env = {
      MY_CRED_REF: JSON.stringify({ source: 'file', id: '/nope/secret.txt' }),
    } as unknown as NodeJS.ProcessEnv;
    const missing = lintFlags(env, MANIFEST, noFiles);
    // NOT a contradiction any more (must not brick boot mid-migration)…
    expect(missing.contradictions.map((c) => c.id)).not.toContain('secrets-ref-missing-file');
    // …but a loud warning naming the offending _REF and its path.
    const warn = missing.warnings.find((w) => w.startsWith('secrets-ref-missing-file:'));
    expect(warn).toBeDefined();
    expect(warn).toContain('MY_CRED_REF');
    expect(warn).toContain('/nope/secret.txt');
    // present → neither contradiction nor warning
    const present = lintFlags(env, MANIFEST, allFiles);
    expect(present.contradictions.map((c) => c.id)).not.toContain('secrets-ref-missing-file');
    expect(present.warnings.some((w) => w.startsWith('secrets-ref-missing-file:'))).toBe(false);
  });
  it('secrets-ref check skipped when SUDO_SECRETS_REF=0 (no warn, no refuse)', () => {
    const env = {
      SUDO_SECRETS_REF: '0',
      MY_CRED_REF: JSON.stringify({ source: 'file', id: '/nope/secret.txt' }),
    } as unknown as NodeJS.ProcessEnv;
    const res = lintFlags(env, MANIFEST, noFiles);
    expect(res.contradictions.map((c) => c.id)).not.toContain('secrets-ref-missing-file');
    expect(res.warnings.some((w) => w.startsWith('secrets-ref-missing-file:'))).toBe(false);
  });
  it('web-chat exposed without token', () => {
    const env = {
      WEB_CHAT_ENABLED: 'true',
      SUDO_GATEWAY_BIND: '0.0.0.0',
    } as unknown as NodeJS.ProcessEnv;
    const ids = lintFlags(env, MANIFEST, allFiles).contradictions.map((c) => c.id);
    expect(ids).toContain('web-chat-no-token-exposed');
    // with token OR loopback bind → fine
    const withTok = { ...env, WEB_CHAT_TOKEN: 't' } as unknown as NodeJS.ProcessEnv;
    expect(lintFlags(withTok, MANIFEST, allFiles).contradictions.map((c) => c.id)).not.toContain(
      'web-chat-no-token-exposed',
    );
    const loop = { WEB_CHAT_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;
    expect(lintFlags(loop, MANIFEST, allFiles).contradictions.map((c) => c.id)).not.toContain(
      'web-chat-no-token-exposed',
    );
  });
  it('a clean env has zero contradictions', () => {
    const env = { GATEWAY_TOKEN: 'x' } as unknown as NodeJS.ProcessEnv;
    expect(lintFlags(env, MANIFEST, allFiles).contradictions).toEqual([]);
  });
  it('every contradiction rule has a stable id', () => {
    // secrets-ref-missing-file was DOWNGRADED to a warning (MEDIUM-2) — no longer here.
    expect(CONTRADICTIONS.map((c) => c.id).sort()).toEqual(
      [
        'sandbox-disabled-with-untrusted-inbound',
        'unified-auth-off-with-token',
        'web-chat-no-token-exposed',
      ].sort(),
    );
  });
});

describe('GW-10 auth precedence warning', () => {
  it('warns when token and secret differ', () => {
    const env = { GATEWAY_TOKEN: 'a', GATEWAY_SECRET: 'b' } as unknown as NodeJS.ProcessEnv;
    expect(lintFlags(env, MANIFEST, allFiles).warnings.length).toBe(1);
  });
  it('no warning when they match or one is unset', () => {
    expect(lintFlags({ GATEWAY_TOKEN: 'a', GATEWAY_SECRET: 'a' } as unknown as NodeJS.ProcessEnv, MANIFEST, allFiles).warnings).toEqual([]);
    expect(lintFlags({ GATEWAY_TOKEN: 'a' } as unknown as NodeJS.ProcessEnv, MANIFEST, allFiles).warnings).toEqual([]);
  });
});

describe('GW-10 override + posture', () => {
  it('isContradictionOverride reads the flag', () => {
    expect(isContradictionOverride({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isContradictionOverride({ SUDO_ALLOW_CONTRADICTORY_CONFIG: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('override registers as a posture-weakening flag', () => {
    const flags = collectWeakeningFlags({
      SUDO_KAIROS: '0',
      SUDO_ALLOW_CONTRADICTORY_CONFIG: '1',
    } as NodeJS.ProcessEnv).map((f) => f.flag);
    expect(flags).toContain('SUDO_ALLOW_CONTRADICTORY_CONFIG');
  });
});
