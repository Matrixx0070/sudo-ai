/**
 * GW-3: retire fail-open escape hatches.
 *  3a — SUDO_GATEWAY_UNIFIED_AUTH=0 restores legacy semantics for
 *       loopback-direct requests ONLY; proxied/non-loopback still denied.
 *  3b — SecurityGuard strict is the default (isSecurityStrict) + posture entry.
 *  3c — Kairos restart writes an audit row BEFORE exec, honors dry-run, and
 *       registers restart authority in the posture banner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { authenticateHttp } from '../../src/core/gateway/auth.js';
import {
  collectWeakeningFlags,
  isSecurityStrict,
  postureBannerLines,
} from '../../src/core/security/posture.js';
import { performGuardedRestart } from '../../src/core/consciousness/kairos.js';

function mkReq(opts: { bearer?: string; remote?: string; headers?: Record<string, string> } = {}): IncomingMessage {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  return { headers, socket: { remoteAddress: opts.remote ?? '127.0.0.1' } } as unknown as IncomingMessage;
}

const ENV_KEYS = [
  'GATEWAY_TOKEN',
  'SUDO_GATEWAY_UNIFIED_AUTH',
  'SUDO_SECURITY_STRICT',
  'SUDO_KAIROS',
  'SUDO_KAIROS_AUTONOMOUS',
] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('GW-3a unified-auth kill-switch no longer opens exposed surfaces', () => {
  it('legacy-open works for a loopback-direct request when no secret is set', () => {
    process.env['SUDO_GATEWAY_UNIFIED_AUTH'] = '0';
    const p = authenticateHttp(mkReq({ remote: '127.0.0.1' }));
    expect(p.ok).toBe(true);
    expect(p.reason).toContain('legacy-open-loopback');
  });

  it('DENIES a proxied request (forwarded header) even with the flag set', () => {
    process.env['SUDO_GATEWAY_UNIFIED_AUTH'] = '0';
    const p = authenticateHttp(mkReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } }));
    expect(p.ok).toBe(false);
  });

  it('DENIES a non-loopback request even with the flag set', () => {
    process.env['SUDO_GATEWAY_UNIFIED_AUTH'] = '0';
    const p = authenticateHttp(mkReq({ remote: '8.8.8.8' }));
    expect(p.ok).toBe(false);
  });

  it('legacy token still validated on loopback-direct when secret is set', () => {
    process.env['SUDO_GATEWAY_UNIFIED_AUTH'] = '0';
    process.env['GATEWAY_TOKEN'] = 'sekret';
    expect(authenticateHttp(mkReq({ remote: '127.0.0.1', bearer: 'sekret' })).ok).toBe(true);
    expect(authenticateHttp(mkReq({ remote: '127.0.0.1', bearer: 'wrong' })).ok).toBe(false);
    // even a valid token from a proxied request is denied under the flag
    expect(
      authenticateHttp(mkReq({ remote: '127.0.0.1', bearer: 'sekret', headers: { 'x-real-ip': '8.8.8.8' } })).ok,
    ).toBe(false);
  });
});

describe('GW-3b SecurityGuard strict by default', () => {
  it('isSecurityStrict defaults to true (fatal) and only 0 disables it', () => {
    expect(isSecurityStrict()).toBe(true);
    process.env['SUDO_SECURITY_STRICT'] = '1';
    expect(isSecurityStrict()).toBe(true);
    process.env['SUDO_SECURITY_STRICT'] = '0';
    expect(isSecurityStrict()).toBe(false);
  });

  it('SUDO_SECURITY_STRICT=0 registers as a posture-weakening flag', () => {
    expect(collectWeakeningFlags().some((f) => f.flag === 'SUDO_SECURITY_STRICT')).toBe(false);
    process.env['SUDO_SECURITY_STRICT'] = '0';
    const flags = collectWeakeningFlags();
    expect(flags.some((f) => f.flag === 'SUDO_SECURITY_STRICT')).toBe(true);
  });
});

describe('GW-3c Kairos restart governance', () => {
  it('writes the audit row BEFORE executing, and executes when not dry-run', () => {
    const order: string[] = [];
    const executed = performGuardedRestart('ram', 'systemctl restart sudo-ai', {
      audit: () => order.push('audit'),
      exec: () => order.push('exec'),
      dryRun: false,
    });
    expect(executed).toBe(true);
    expect(order).toEqual(['audit', 'exec']);
  });

  it('dry-run audits but never execs', () => {
    const order: string[] = [];
    const executed = performGuardedRestart('ram', 'systemctl restart sudo-ai', {
      audit: () => order.push('audit'),
      exec: () => order.push('exec'),
      dryRun: true,
    });
    expect(executed).toBe(false);
    expect(order).toEqual(['audit']);
  });

  it('registers restart authority in the posture banner (default on)', () => {
    // default: SUDO_KAIROS unset, SUDO_KAIROS_AUTONOMOUS unset → active
    expect(postureBannerLines().some((l) => l.includes('Kairos restart authority active'))).toBe(true);
  });

  it('drops the Kairos posture entry when disabled or observe-only', () => {
    process.env['SUDO_KAIROS'] = '0';
    expect(collectWeakeningFlags().some((f) => f.flag === 'SUDO_KAIROS')).toBe(false);
    delete process.env['SUDO_KAIROS'];
    process.env['SUDO_KAIROS_AUTONOMOUS'] = '0';
    expect(collectWeakeningFlags().some((f) => f.flag === 'SUDO_KAIROS')).toBe(false);
  });
});
