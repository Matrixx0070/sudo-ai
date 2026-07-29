/**
 * One-time cookie-import login: cookie normalization across formats, essential-
 * cookie detection, and the import guard rails (needs sso + UA + a passing probe
 * before it persists a session).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseCookieInput,
  essentialCookies,
  importGrokWebSession,
} from '../../src/llm/grok-web-login.js';

describe('parseCookieInput', () => {
  it('passes through a raw Cookie header', () => {
    expect(parseCookieInput('sso=abc; cf_clearance=xyz')).toBe('sso=abc; cf_clearance=xyz');
  });
  it('collapses newlines/whitespace in a header', () => {
    expect(parseCookieInput('sso=abc;\n  cf_clearance=xyz')).toBe('sso=abc; cf_clearance=xyz');
  });
  it('converts a JSON cookie-export array, filtering by domain', () => {
    const json = JSON.stringify([
      { name: 'sso', value: 'abc', domain: '.grok.com' },
      { name: 'other', value: '1', domain: '.example.com' },
      { name: 'cf_clearance', value: 'xyz', domain: 'grok.com' },
    ]);
    expect(parseCookieInput(json)).toBe('sso=abc; cf_clearance=xyz');
  });
  it('parses Netscape cookies.txt', () => {
    const txt = '# Netscape\ngrok.com\tTRUE\t/\tTRUE\t0\tsso\tabc\ngrok.com\tTRUE\t/\tTRUE\t0\tcf_clearance\txyz';
    expect(parseCookieInput(txt)).toBe('sso=abc; cf_clearance=xyz');
  });
});

describe('essentialCookies', () => {
  it('detects sso + cf_clearance + count', () => {
    expect(essentialCookies('sso=a; cf_clearance=b; foo=c')).toEqual({
      sso: true,
      cf_clearance: true,
      count: 3,
    });
  });
  it('flags a missing sso', () => {
    expect(essentialCookies('cf_clearance=b').sso).toBe(false);
  });
});

const fakeManager = (existing: unknown = null) => {
  const saved: unknown[] = [];
  return {
    mgr: {
      loadSession: () => existing,
      saveSession: (s: unknown) => saved.push(s),
    } as never,
    saved,
  };
};

describe('importGrokWebSession', () => {
  it('refuses input without an sso cookie (never installs a dead session)', async () => {
    const { mgr, saved } = fakeManager();
    const r = await importGrokWebSession(
      { cookie: 'cf_clearance=b', userAgent: 'UA' },
      { manager: mgr, bridge: (async () => ({ ok: true })) as never },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/sso/);
    expect(saved).toHaveLength(0);
  });

  it('refuses when no userAgent is available (cf_clearance is UA-bound)', async () => {
    const { mgr } = fakeManager();
    const r = await importGrokWebSession(
      { cookie: 'sso=a; cf_clearance=b' },
      { manager: mgr, verify: false },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/userAgent/);
  });

  it('does not save when the live probe fails', async () => {
    const { mgr, saved } = fakeManager();
    const bridge = vi.fn(async () => ({ ok: false, errorClass: 'relogin' }));
    const r = await importGrokWebSession(
      { cookie: 'sso=a; cf_clearance=b', userAgent: 'UA' },
      { manager: mgr, bridge: bridge as never },
    );
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('normalizes, verifies, and persists a good session', async () => {
    const { mgr, saved } = fakeManager();
    const bridge = vi.fn(async (req: { op: string }) =>
      req.op === 'probe' ? { ok: true, quota: {} } : { ok: false },
    );
    const r = await importGrokWebSession(
      { cookie: 'sso=a; cf_clearance=b', userAgent: 'UA/1.0' },
      { manager: mgr, bridge: bridge as never },
    );
    expect(r).toMatchObject({ ok: true, verified: true, essential: { sso: true, cf_clearance: true } });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ cookie: 'sso=a; cf_clearance=b', userAgent: 'UA/1.0' });
  });

  it('reuses the existing session UA when none is supplied', async () => {
    const { mgr, saved } = fakeManager({ userAgent: 'EXISTING-UA' });
    const bridge = vi.fn(async () => ({ ok: true, quota: {} }));
    await importGrokWebSession(
      { cookie: 'sso=a' },
      { manager: mgr, bridge: bridge as never },
    );
    expect((saved[0] as { userAgent: string }).userAgent).toBe('EXISTING-UA');
  });
});
