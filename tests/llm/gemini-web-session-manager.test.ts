/**
 * @file gemini-web-session-manager.test.ts
 * Headless tests for the file-backed Gemini web session holder — no browser, no
 * network. A mock fetch routes INIT/GENERATE/ROTATE so the full generate + rotate +
 * needs-relogin flow is exercised against a temp 0600 session file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GeminiWebSessionManager,
  cookieHeaderFrom,
  parse1PSIDTS,
  type SessionFetch,
} from '../../src/llm/gemini-web-session-manager.js';
import { GEMINI_ENDPOINTS, GeminiAuthError } from '../../src/llm/gemini-web-mint.js';

const APP_HTML = `x={"cfb2h":"boq_x","SNlM0e":"TOKEN_1","FdrFJe":"-sid","TuX5cc":"en"};`;
const APP_HTML_2 = `x={"cfb2h":"boq_x","SNlM0e":"TOKEN_2","FdrFJe":"-sid","TuX5cc":"en"};`;

function frameBody(text: string): string {
  const inner = [null, ['CID', 'RID'], null, null, [['RCID', [text]]]];
  const part = [['wrb.fr', null, JSON.stringify(inner)]];
  const payload = JSON.stringify(part);
  return `)]}'\n${payload.length}\n${payload}\n`;
}

function res(status: number, body: string, setCookie: string[] = []) {
  return { status, text: async () => body, headers: { getSetCookie: () => setCookie } };
}

let tmp = '';
function newManager(fetchImpl: SessionFetch): GeminiWebSessionManager {
  tmp = path.join(os.tmpdir(), `gemini-sess-${process.pid}-${Date.now()}.json`);
  return new GeminiWebSessionManager({ storePath: tmp, fetchImpl });
}
afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp);
});

describe('pure helpers', () => {
  it('cookieHeaderFrom joins non-empty pairs', () => {
    expect(cookieHeaderFrom({ __Secure_1PSID: 'a', X: '', Y: 'b' })).toBe('__Secure_1PSID=a; Y=b');
  });
  it('parse1PSIDTS extracts the fresh value', () => {
    const set = ['NID=1; Path=/', '__Secure-1PSIDTS=NEWTS123; Domain=.google.com; Secure; HttpOnly'];
    expect(parse1PSIDTS(set)).toBe('NEWTS123');
    expect(parse1PSIDTS(['NID=1'])).toBeNull();
  });
});

describe('generate (headless, from file)', () => {
  it('mints from file cookies and returns the reply', async () => {
    const mgr = newManager(async (url) => {
      if (url === GEMINI_ENDPOINTS.INIT) return res(200, APP_HTML);
      if (url.startsWith(GEMINI_ENDPOINTS.GENERATE)) return res(200, frameBody('pong'));
      throw new Error(`unexpected url ${url}`);
    });
    mgr.saveFromCookies({ '__Secure-1PSID': 'psid', '__Secure-1PSIDTS': 'ts' }, 'UA/1');
    const reply = await mgr.generate('say pong');
    expect(reply.text).toBe('pong');
    expect(reply.cid).toBe('CID');
    expect(reply.rcid).toBe('RCID');
  });

  it('rotates 1PSIDTS and retries when the token is initially unavailable', async () => {
    let initCalls = 0;
    const mgr = newManager(async (url) => {
      if (url === GEMINI_ENDPOINTS.INIT) {
        initCalls++;
        // First scrape fails (logged-out-looking HTML); after rotate it succeeds.
        return initCalls === 1 ? res(200, '<html>no token</html>') : res(200, APP_HTML_2);
      }
      if (url === GEMINI_ENDPOINTS.ROTATE_COOKIES) {
        return res(200, '', ['__Secure-1PSIDTS=FRESH; Domain=.google.com']);
      }
      if (url.startsWith(GEMINI_ENDPOINTS.GENERATE)) return res(200, frameBody('pong'));
      throw new Error(`unexpected url ${url}`);
    });
    mgr.saveFromCookies({ '__Secure-1PSID': 'psid', '__Secure-1PSIDTS': 'stale' }, 'UA/1');
    const reply = await mgr.generate('say pong');
    expect(reply.text).toBe('pong');
    // The rotate must have persisted the fresh 1PSIDTS to the file.
    const saved = JSON.parse(readFileSync(tmp, 'utf8'));
    expect(saved.cookies['__Secure-1PSIDTS']).toBe('FRESH');
  });

  it('marks needs-relogin when the login is dead (no token after rotate)', async () => {
    const mgr = newManager(async (url) => {
      if (url === GEMINI_ENDPOINTS.INIT) return res(200, '<html>logged out</html>');
      if (url === GEMINI_ENDPOINTS.ROTATE_COOKIES) return res(200, '', []);
      throw new Error(`unexpected url ${url}`);
    });
    mgr.saveFromCookies({ '__Secure-1PSID': 'dead' }, 'UA/1');
    await expect(mgr.generate('hi')).rejects.toBeInstanceOf(GeminiAuthError);
    expect(mgr.status().needsRelogin).toBe(true);
  });

  it('auto-recovers a dead session via the reauth hook (no re-login thrown)', async () => {
    let live = false;
    const mgr = newManager(async (url) => {
      if (url === GEMINI_ENDPOINTS.INIT) return live ? res(200, APP_HTML) : res(200, '<html>logged out</html>');
      if (url === GEMINI_ENDPOINTS.ROTATE_COOKIES) return res(200, '', []);
      if (url.startsWith(GEMINI_ENDPOINTS.GENERATE)) return res(200, frameBody('pong'));
      throw new Error(`unexpected url ${url}`);
    });
    // Browserless re-mint: supplies fresh cookies and restores the (mock) login.
    mgr.setReauthHook(async () => {
      live = true;
      return { '__Secure-1PSID': 'fresh', '__Secure-1PSIDTS': 'ts' };
    });
    mgr.saveFromCookies({ '__Secure-1PSID': 'dead' }, 'UA/1');
    const reply = await mgr.generate('hi');
    expect(reply.text).toBe('pong');
    expect(mgr.status().needsRelogin).toBeFalsy();
  });

  it('still marks needs-relogin when the reauth hook cannot recover', async () => {
    const mgr = newManager(async (url) => {
      if (url === GEMINI_ENDPOINTS.INIT) return res(200, '<html>logged out</html>');
      if (url === GEMINI_ENDPOINTS.ROTATE_COOKIES) return res(200, '', []);
      throw new Error(`unexpected url ${url}`);
    });
    mgr.setReauthHook(async () => null); // hook present but yields nothing
    mgr.saveFromCookies({ '__Secure-1PSID': 'dead' }, 'UA/1');
    await expect(mgr.generate('hi')).rejects.toBeInstanceOf(GeminiAuthError);
    expect(mgr.status().needsRelogin).toBe(true);
  });

  it('throws when there is no session file', async () => {
    const mgr = newManager(async () => res(200, ''));
    // no saveFromCookies -> no file
    await expect(mgr.generate('hi')).rejects.toBeInstanceOf(GeminiAuthError);
  });

  it('throws a clear error when 200 yields no candidates (index drift)', async () => {
    const mgr = newManager(async (url) => {
      if (url === GEMINI_ENDPOINTS.INIT) return res(200, APP_HTML);
      if (url.startsWith(GEMINI_ENDPOINTS.GENERATE)) return res(200, ')]}\'\n2\n[]\n');
      throw new Error(`unexpected url ${url}`);
    });
    mgr.saveFromCookies({ '__Secure-1PSID': 'psid' }, 'UA/1');
    await expect(mgr.generate('hi')).rejects.toThrow(/reply indices may have drifted/);
  });
});

describe('status', () => {
  it('reports disconnected with no file, connected after capture', async () => {
    const mgr = newManager(async () => res(200, ''));
    expect(mgr.status().connected).toBe(false);
    mgr.saveFromCookies({ '__Secure-1PSID': 'x' }, 'UA/1');
    expect(mgr.status()).toMatchObject({ connected: true, cookieCount: 1 });
  });
});
