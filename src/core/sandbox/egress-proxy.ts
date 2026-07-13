/**
 * @file sandbox/egress-proxy.ts
 * @description Enforcing egress allowlist proxy for the sandbox `network:
 * 'allowlist'` mode (Spec 8 step 4).
 *
 * The docker backend runs allowlist-mode containers on an INTERNAL docker
 * network: no NAT, no default route, no external DNS (all three verified live
 * on this host's Docker 29). The ONLY reachable endpoint outside the container
 * is a host service bound to the network's gateway IP — this proxy. Every
 * outbound connection therefore passes through here, making the allowlist
 * enforced by construction, not advisory: a process that ignores HTTP(S)_PROXY
 * has no route out at all.
 *
 * Enforcement per request (CONNECT for TLS, absolute-form for plain HTTP):
 *   1. target hostname must match the allowlist (exact or `*.suffix` entry);
 *   2. target port must be 80/443 (configurable for tests);
 *   3. the hostname is resolved HOST-side and the RESOLVED IP is checked
 *      against the SSRF guard (private / loopback / link-local / metadata
 *      ranges all refused — an allowlisted name may not rebind into the LAN);
 *   4. the upstream socket connects to that same resolved IP (no second
 *      lookup, so no resolve-then-connect TOCTOU window).
 * Anything else gets a 403 and a warn log. DNS failure → refused (fail closed).
 *
 * One proxy instance per sandbox run, bound to the gateway IP on an ephemeral
 * port, closed in the backend's finally block. No third-party deps.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createLogger } from '../shared/logger.js';
import { SSRFGuard } from '../tools/builtin/browser/ssrf-guard.js';
import type { SSRFConfig } from '../tools/builtin/browser/ssrf-guard.js';

const log = createLogger('sandbox:egress-proxy');

/** Ports a sandboxed process may reach on an allowlisted host. */
const DEFAULT_ALLOWED_PORTS: ReadonlyArray<number> = [80, 443];

/** Cap tunnel lifetime so an abandoned CONNECT can't hold a socket forever. */
const TUNNEL_IDLE_TIMEOUT_MS = 120_000;

export interface EgressProxyOptions {
  /** Interface to bind — the sandbox network's gateway IP (or 127.0.0.1 in tests). */
  bindHost: string;
  /** Hostnames the sandbox may reach. `*.example.com` entries match subdomains. */
  allowedHosts: string[];
  /** Override the 80/443 port allowlist (tests use a local ephemeral port). */
  allowedPorts?: number[];
  /** Override SSRF guard blocks (tests allow loopback upstreams). */
  guardConfig?: Partial<SSRFConfig>;
}

export interface EgressProxyHandle {
  /** e.g. `http://172.20.0.1:38211` — export as HTTP_PROXY/HTTPS_PROXY. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Case-insensitive allowlist match. An exact entry matches only itself; a
 * `*.suffix` entry matches any subdomain of `suffix` (but not `suffix` itself —
 * add both when both are wanted). Plain-suffix substring tricks
 * (`evilgithub.com`, `github.com.evil.io`) do not match.
 */
export function hostAllowed(hostname: string, allowedHosts: ReadonlyArray<string>): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const raw of allowedHosts) {
    const entry = raw.toLowerCase().trim().replace(/\.$/, '');
    if (!entry) continue;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      if (suffix && host.endsWith(`.${suffix}`)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

interface TargetDecision {
  allowed: boolean;
  reason?: string;
  /** Resolved upstream IP — connect to THIS, never re-resolve. */
  ip?: string;
  family?: number;
}

async function decideTarget(
  hostname: string,
  port: number,
  opts: EgressProxyOptions,
  guard: SSRFGuard,
): Promise<TargetDecision> {
  const allowedPorts = opts.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!hostname) return { allowed: false, reason: 'empty target host' };
  if (!allowedPorts.includes(port)) {
    return { allowed: false, reason: `port ${port} not permitted (allowed: ${allowedPorts.join(',')})` };
  }
  if (!hostAllowed(hostname, opts.allowedHosts)) {
    return { allowed: false, reason: `host '${hostname}' not on egress allowlist` };
  }

  // Resolve host-side, then vet the RESOLVED IP — an allowlisted name must not
  // rebind into private/link-local/metadata space. checkIp (not checkUrl) so the
  // guard's own hostname allowlist can't skip the range checks.
  let ip: string;
  let family: number;
  try {
    const res = await lookup(hostname);
    if (!res.address) throw new Error('empty resolved address');
    ip = res.address;
    family = res.family;
  } catch {
    return { allowed: false, reason: `DNS resolution failed for '${hostname}' (refused fail-closed)` };
  }
  const ipCheck = guard.checkIp(ip);
  if (!ipCheck.allowed) {
    return { allowed: false, reason: `'${hostname}' resolves to blocked address ${ip}: ${ipCheck.reason}` };
  }
  return { allowed: true, ip, family };
}

function denyConnect(socket: Socket, reason: string): void {
  log.warn({ reason }, 'egress proxy refused CONNECT');
  socket.write(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n` +
      `egress allowlist: ${reason}\n`,
  );
  socket.destroy();
}

function denyRequest(res: ServerResponse, reason: string): void {
  log.warn({ reason }, 'egress proxy refused request');
  res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
  res.end(`egress allowlist: ${reason}\n`);
}

/**
 * Start the allowlist proxy. Rejects if the bind fails — callers treat that as
 * fail-closed (the sandbox run is refused, never downgraded to open network).
 */
export function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxyHandle> {
  const guard = new SSRFGuard({ allowedHosts: [], ...opts.guardConfig });
  const server: Server = createServer();

  // HTTPS: CONNECT host:port → vet → tunnel to the resolved IP.
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const [rawHost = '', rawPort = ''] = (req.url ?? '').split(':');
    const port = Number(rawPort) || 443;
    void decideTarget(rawHost, port, opts, guard).then((decision) => {
      if (clientSocket.destroyed) return;
      if (!decision.allowed || !decision.ip) {
        denyConnect(clientSocket, decision.reason ?? 'refused');
        return;
      }
      const upstream = netConnect({ host: decision.ip, port, family: decision.family });
      let established = false;
      upstream.once('connect', () => {
        established = true;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => upstream.destroy());
      clientSocket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => clientSocket.destroy());
      upstream.on('error', () => {
        // Pre-establishment failure gets an explicit 502 — silently dropping
        // the socket leaves proxy clients hanging until their own timeout.
        if (!established && !clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        }
        clientSocket.destroy();
      });
      clientSocket.on('error', () => upstream.destroy());
      upstream.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
      log.debug({ host: rawHost, ip: decision.ip, port }, 'egress tunnel opened');
    });
  });

  // Plain HTTP: absolute-form request → vet → forward to the resolved IP with
  // the original Host header (virtual hosting keeps working).
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      denyRequest(res, 'proxy requires absolute-form URLs');
      return;
    }
    if (target.protocol !== 'http:') {
      denyRequest(res, `unsupported protocol '${target.protocol}'`);
      return;
    }
    const port = Number(target.port) || 80;
    void decideTarget(target.hostname, port, opts, guard).then((decision) => {
      if (!decision.allowed || !decision.ip) {
        denyRequest(res, decision.reason ?? 'refused');
        return;
      }
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      const upstream = httpRequest(
        {
          host: decision.ip,
          family: decision.family,
          port,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...headers, host: target.host },
          timeout: TUNNEL_IDLE_TIMEOUT_MS,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { Connection: 'close' });
        res.end();
      });
      req.pipe(upstream);
    });
  });

  return new Promise<EgressProxyHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, opts.bindHost, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('egress proxy: could not determine bound port'));
        return;
      }
      const { port } = address;
      log.info(
        { bindHost: opts.bindHost, port, allowedHosts: opts.allowedHosts.length },
        'egress allowlist proxy listening',
      );
      resolve({
        url: `http://${opts.bindHost}:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            // closeAllConnections drops live tunnels so close() never hangs on
            // a long-lived keep-alive socket.
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
