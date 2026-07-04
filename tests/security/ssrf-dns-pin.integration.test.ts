/**
 * Integration tests for ssrf-dns-pin.ts — NO mocks.
 *
 * These lock the cross-version contract flagged in review: Node 22's bundled
 * global `fetch` (its own internal undici) must honor an `Agent` from the npm
 * `undici` dependency passed as `dispatcher`, AND the address returned from
 * `connect.lookup` must be the address actually dialed (the pin). If a future
 * Node/undici bump breaks that duck-typed handshake, CI fails here instead of
 * silently disabling SSRF pinning.
 *
 * We also exercise `pinnedLookup` against real `node:dns` + real
 * `validateDomain` using IP-literal hostnames (which resolve to themselves with
 * no network I/O), so the actual guard logic runs unmocked.
 */

import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { pinnedLookup, SSRFBlockedAddressError } from '../../src/core/security/ssrf-dns-pin.js';

type UndiciInit = RequestInit & { dispatcher?: Agent };

// A tiny loopback server that echoes a marker so we can prove the socket
// actually reached it.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('pinned-ok');
});
const listening = new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('ssrf-dns-pin integration: real fetch + npm-undici Agent + connect.lookup', () => {
  it('dials exactly the address returned by connect.lookup (the pin)', async () => {
    const port = await listening;
    // A lookup that pins to the loopback server regardless of the hostname —
    // this stands in for "resolved + validated to this address". undici's
    // connect calls lookup with all:true and expects the LookupAddress[] shape
    // (same branch our real pinnedLookup returns).
    const pinTo127: LookupFunction = (_h, _o, cb) =>
      (cb as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
        { address: '127.0.0.1', family: 4 },
      ]);
    const agent = new Agent({ connect: { lookup: pinTo127 } });

    // Hostname is a non-resolvable name; only the pinned address makes this work,
    // proving global fetch honored the Agent + the returned address was dialed.
    const res = await fetch(`http://pin-target.invalid:${port}/`, {
      dispatcher: agent,
      signal: AbortSignal.timeout(4000),
    } as UndiciInit);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pinned-ok');
    await agent.close();
  });

  it('fails the connection closed when connect.lookup errors', async () => {
    const port = await listening;
    const rejectLookup: LookupFunction = (_h, _o, cb) =>
      cb(new SSRFBlockedAddressError('evil.example', '169.254.169.254', 'metadata'), '', undefined);
    const agent = new Agent({ connect: { lookup: rejectLookup } });

    await expect(
      fetch(`http://evil.example:${port}/`, {
        dispatcher: agent,
        signal: AbortSignal.timeout(4000),
      } as UndiciInit),
    ).rejects.toThrow();
    await agent.close();
  });
});

describe('ssrf-dns-pin integration: pinnedLookup unmocked (IP literals, no network)', () => {
  function run(host: string): Promise<{ err: Error | null; address: unknown; family?: number }> {
    return new Promise((resolve) => {
      pinnedLookup(host, { all: false } as never, ((err, address, family) => {
        resolve({ err, address, family });
      }) as never);
    });
  }

  it('allows a public IP literal (dns.lookup returns it, validateDomain passes)', async () => {
    const out = await run('93.184.216.34');
    expect(out.err).toBeNull();
    expect(out.address).toBe('93.184.216.34');
  });

  it('blocks the loopback IP literal via the real guard', async () => {
    const out = await run('127.0.0.1');
    expect(out.err).toBeInstanceOf(SSRFBlockedAddressError);
  });

  it('blocks the IPv6 loopback literal via the real guard', async () => {
    const out = await run('::1');
    expect(out.err).toBeInstanceOf(SSRFBlockedAddressError);
  });
});
