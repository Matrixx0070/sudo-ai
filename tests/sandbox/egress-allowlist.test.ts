/**
 * Tests for the enforced egress allowlist (Spec 8 step 4).
 *
 * Covers: hostname matching (exact / wildcard / bypass attempts), the live
 * proxy's allow + deny paths (local upstream, no external network needed),
 * SSRF-guarded targets (metadata / private / loopback), argv wiring
 * (network:'allowlist' → internal egress network), the bwrap fail-closed
 * downgrade (allowlist → --unshare-net), and allowlist resolution precedence.
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { hostAllowed, startEgressProxy } from '../../src/core/sandbox/egress-proxy.js';
import type { EgressProxyHandle } from '../../src/core/sandbox/egress-proxy.js';
import {
  buildDockerArgs,
  DEFAULT_EGRESS_NETWORK,
  type DockerBackendConfig,
} from '../../src/core/sandbox/backends/docker-backend.js';
import { buildBwrapArgs } from '../../src/core/sandbox/sandbox-runner.js';
import { mergePolicy } from '../../src/core/sandbox/sandbox-policy.js';
import {
  DEFAULT_SANDBOX_POLICY,
  DEFAULT_EGRESS_ALLOWLIST,
  resolveEgressAllowlist,
} from '../../src/core/sandbox/sandbox-types.js';

// ---------------------------------------------------------------------------
// hostAllowed
// ---------------------------------------------------------------------------

describe('hostAllowed', () => {
  const list = ['example.com', '*.trusted.io', 'API.Upper.Case'];

  it('matches exact entries case-insensitively (and trailing-dot FQDNs)', () => {
    expect(hostAllowed('example.com', list)).toBe(true);
    expect(hostAllowed('EXAMPLE.COM', list)).toBe(true);
    expect(hostAllowed('example.com.', list)).toBe(true);
    expect(hostAllowed('api.upper.case', list)).toBe(true);
  });

  it('wildcard entries match subdomains only, not the bare suffix', () => {
    expect(hostAllowed('a.trusted.io', list)).toBe(true);
    expect(hostAllowed('deep.a.trusted.io', list)).toBe(true);
    expect(hostAllowed('trusted.io', list)).toBe(false);
  });

  it('refuses substring / suffix-forgery bypasses', () => {
    expect(hostAllowed('evilexample.com', list)).toBe(false);
    expect(hostAllowed('example.com.evil.io', list)).toBe(false);
    expect(hostAllowed('untrusted.io', list)).toBe(false);
    expect(hostAllowed('xtrusted.io', list)).toBe(false);
  });

  it('subdomains of an exact entry do not match', () => {
    expect(hostAllowed('sub.example.com', list)).toBe(false);
  });

  it('empty inputs never match', () => {
    expect(hostAllowed('', list)).toBe(false);
    expect(hostAllowed('example.com', [])).toBe(false);
    expect(hostAllowed('anything', ['', '*.'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// live proxy — local upstream, loopback allowed via guardConfig (tests only)
// ---------------------------------------------------------------------------

describe('egress proxy (live, local)', () => {
  let upstream: Server | undefined;
  let upstreamPort = 0;
  let proxy: EgressProxyHandle | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    upstream = undefined;
  });

  async function startUpstream(): Promise<void> {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('UPSTREAM_OK');
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
    const addr = upstream!.address();
    upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
  }

  /** Absolute-form GET through the proxy; resolves to {status, body}. */
  function viaProxy(proxyPort: number, targetUrl: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += String(c)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('forwards plain HTTP to an allowlisted host and refuses others', async () => {
    await startUpstream();
    // 127.0.0.1 (not 'localhost') — lookup('localhost') may resolve ::1 first
    // while the test upstream listens on v4 only; an IP-literal is deterministic.
    proxy = await startEgressProxy({
      bindHost: '127.0.0.1',
      allowedHosts: ['127.0.0.1'],
      allowedPorts: [upstreamPort],
      guardConfig: { blockLoopback: false },
    });

    const ok = await viaProxy(proxy.port, `http://127.0.0.1:${upstreamPort}/`);
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('UPSTREAM_OK');

    const denied = await viaProxy(proxy.port, `http://not-allowed.example:${upstreamPort}/`);
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('not on egress allowlist');
  });

  it('tunnels CONNECT to an allowlisted host and 403s a denied one', async () => {
    await startUpstream();
    proxy = await startEgressProxy({
      bindHost: '127.0.0.1',
      allowedHosts: ['127.0.0.1'],
      allowedPorts: [upstreamPort],
      guardConfig: { blockLoopback: false },
    });

    const connectStatus = (target: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const sock = netConnect(proxy!.port, '127.0.0.1', () => {
          sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        });
        sock.once('data', (chunk: Buffer) => {
          resolve(String(chunk).split('\r\n')[0] ?? '');
          sock.destroy();
        });
        sock.on('error', reject);
      });

    expect(await connectStatus(`127.0.0.1:${upstreamPort}`)).toContain('200');
    expect(await connectStatus(`denied.example:${upstreamPort}`)).toContain('403');
  });

  it('refuses ports outside the allowed set even for allowlisted hosts', async () => {
    proxy = await startEgressProxy({
      bindHost: '127.0.0.1',
      allowedHosts: ['localhost'],
      allowedPorts: [443],
      guardConfig: { blockLoopback: false },
    });
    const denied = await viaProxy(proxy.port, 'http://localhost:8080/');
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('port 8080 not permitted');
  });

  it('refuses allowlisted names that resolve to blocked ranges (default guard)', async () => {
    proxy = await startEgressProxy({
      bindHost: '127.0.0.1',
      // localhost IS allowlisted here — the RESOLVED-IP guard must still refuse
      // it (loopback), proving a DNS-rebound "allowed" name cannot reach the LAN.
      allowedHosts: ['localhost', '169.254.169.254'],
      allowedPorts: [80],
    });
    const loopback = await viaProxy(proxy.port, 'http://localhost:80/');
    expect(loopback.status).toBe(403);
    expect(loopback.body).toContain('blocked address');

    const metadata = await viaProxy(proxy.port, 'http://169.254.169.254:80/');
    expect(metadata.status).toBe(403);
  });

  it('refuses unresolvable hosts fail-closed', async () => {
    proxy = await startEgressProxy({
      bindHost: '127.0.0.1',
      allowedHosts: ['definitely-not-a-real-host.invalid'],
      allowedPorts: [80],
    });
    const denied = await viaProxy(proxy.port, 'http://definitely-not-a-real-host.invalid:80/');
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('DNS resolution failed');
  });
});

// ---------------------------------------------------------------------------
// argv wiring + fail-closed downgrades + resolution precedence
// ---------------------------------------------------------------------------

describe('network:allowlist wiring', () => {
  const config: DockerBackendConfig = { bin: 'docker', image: 'sudo-ai-sandbox:latest' };
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

  afterAll(() => {
    delete process.env['SUDO_SANDBOX_EGRESS_ALLOWLIST'];
    delete process.env['SUDO_DOCKER_EGRESS_NETWORK'];
  });

  it('docker argv uses the internal egress network for allowlist mode', () => {
    const policy = { ...DEFAULT_SANDBOX_POLICY, network: 'allowlist' as const };
    const args = buildDockerArgs({ command: 'true', workspaceDir: '/tmp/ws', policy }, env, config);
    expect(args[args.indexOf('--network') + 1]).toBe(DEFAULT_EGRESS_NETWORK);
  });

  it('bwrap treats allowlist as no-network (fail closed, never host)', () => {
    const policy = { ...DEFAULT_SANDBOX_POLICY, network: 'allowlist' as const };
    const args = buildBwrapArgs('true', '/tmp/ws', policy, () => true, (p: string) => p);
    expect(args).toContain('--unshare-net');
  });

  it('mergePolicy carries allowedEgressHosts (override wins, base preserved)', () => {
    const base = { ...DEFAULT_SANDBOX_POLICY, allowedEgressHosts: ['a.example'] };
    expect(mergePolicy(base, {}).allowedEgressHosts).toEqual(['a.example']);
    expect(mergePolicy(base, { allowedEgressHosts: ['b.example'] }).allowedEgressHosts).toEqual([
      'b.example',
    ]);
  });

  it('resolveEgressAllowlist precedence: policy > env > default', () => {
    delete process.env['SUDO_SANDBOX_EGRESS_ALLOWLIST'];
    expect(resolveEgressAllowlist({})).toEqual([...DEFAULT_EGRESS_ALLOWLIST]);

    process.env['SUDO_SANDBOX_EGRESS_ALLOWLIST'] = ' one.example , two.example ';
    expect(resolveEgressAllowlist({})).toEqual(['one.example', 'two.example']);

    expect(resolveEgressAllowlist({ allowedEgressHosts: ['pol.example'] })).toEqual(['pol.example']);
  });
});
