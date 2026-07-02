/**
 * Unit tests for guarded-fetch.ts — P0 #1 SSRF tool-fetch routing.
 *
 * toolFetch is the single entry point every builtin tool uses instead of the
 * global fetch. It must:
 * - reject internal / cloud-metadata / private-IP targets (via safeFetch → domain-validator)
 * - reject non-http(s) protocols
 * - forward RequestInit and return the Response for allowed hosts
 * - bypass the guard only when SUDO_TOOL_FETCH_GUARD_DISABLE=1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toolFetch } from '../../src/core/security/guarded-fetch.js';

const DISABLE = 'SUDO_TOOL_FETCH_GUARD_DISABLE';

describe('guarded-fetch: toolFetch', () => {
  const realFetch = globalThis.fetch;
  const prevDisable = process.env[DISABLE];

  beforeEach(() => {
    delete process.env[DISABLE];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (prevDisable === undefined) delete process.env[DISABLE];
    else process.env[DISABLE] = prevDisable;
    vi.restoreAllMocks();
  });

  it('blocks the AWS cloud-metadata IP and never calls the network', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(toolFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/blocked/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks private / loopback / link-local ranges', async () => {
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://10.0.0.5/',
      'http://192.168.1.1/admin',
      'http://[::1]/',
    ]) {
      await expect(toolFetch(url)).rejects.toThrow();
    }
  });

  it('blocks non-http(s) protocols', async () => {
    await expect(toolFetch('file:///etc/passwd')).rejects.toThrow();
    await expect(toolFetch('ftp://example.com/x')).rejects.toThrow();
  });

  it('allows a public host and forwards RequestInit + returns the Response', async () => {
    const resp = new Response('ok', { status: 200 });
    const spy = vi.fn(async () => resp);
    globalThis.fetch = spy as unknown as typeof fetch;

    const init: RequestInit = { method: 'POST', headers: { 'x-test': '1' } };
    const out = await toolFetch('https://api.example.com/v1/thing', init);

    expect(out).toBe(resp);
    expect(spy).toHaveBeenCalledTimes(1);
    // safeFetch forces manual redirect handling; the caller's options survive.
    const [, passedInit] = spy.mock.calls[0] as [string, RequestInit];
    expect(passedInit.method).toBe('POST');
    expect(passedInit.redirect).toBe('manual');
  });

  it('bypasses the guard when SUDO_TOOL_FETCH_GUARD_DISABLE=1', async () => {
    process.env[DISABLE] = '1';
    const resp = new Response('raw', { status: 200 });
    const spy = vi.fn(async () => resp);
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await toolFetch('http://169.254.169.254/latest/meta-data/');
    expect(out).toBe(resp);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
