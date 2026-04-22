/**
 * system.network — Network diagnostics and firewall management.
 * All commands use execFile; firewall mutations require confirmation.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.network');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PortInfo {
  protocol: string;
  localAddress: string;
  state: string;
  process: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSsOutput(stdout: string): PortInfo[] {
  const lines = stdout.split('\n').filter(Boolean).slice(1); // skip header
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      protocol: parts[0] ?? '',
      state: parts[1] ?? '',
      localAddress: parts[4] ?? '',
      process: parts[6] ?? '',
    };
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function listPorts(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing open ports');
  const { stdout } = await runCmd('ss', ['-tulpn'], { signal: ctx.signal });
  const ports = parseSsOutput(stdout);
  return { success: true, output: `${ports.length} listening socket(s)`, data: { ports } };
}

async function listConnections(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing network connections');
  const { stdout, exitCode } = await runCmd(
    'ss',
    ['-tupn'],
    { signal: ctx.signal, allowFailure: true },
  );
  if (exitCode !== 0) {
    // Fallback: try netstat
    const { stdout: ns } = await runCmd('netstat', ['-tupn'], { signal: ctx.signal, allowFailure: true });
    return { success: true, output: 'Network connections (netstat)', data: { raw: ns } };
  }
  const connections = parseSsOutput(stdout);
  return { success: true, output: `${connections.length} active connection(s)`, data: { connections } };
}

async function firewallStatus(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Checking firewall status');
  const { stdout, exitCode } = await runCmd('ufw', ['status', 'verbose'], { signal: ctx.signal, allowFailure: true });
  if (exitCode !== 0) {
    return { success: false, output: 'ufw is not available or not configured', data: {} };
  }
  const enabled = /Status: active/.test(stdout);
  const rules = stdout
    .split('\n')
    .filter((l) => /^\d|ALLOW|DENY|LIMIT/.test(l))
    .map((l) => l.trim());
  return { success: true, output: `Firewall ${enabled ? 'active' : 'inactive'}`, data: { enabled, rules, raw: stdout } };
}

async function firewallAllow(port: string, protocol: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, port, protocol }, 'Adding firewall allow rule');
  const rule = protocol ? `${port}/${protocol}` : port;
  await runCmd('ufw', ['allow', rule], { signal: ctx.signal });
  return { success: true, output: `Firewall rule added: allow ${rule}`, data: { port, protocol, rule } };
}

async function dnsLookup(host: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, host }, 'DNS lookup');
  const { stdout, exitCode } = await runCmd('dig', ['+short', host], { signal: ctx.signal, allowFailure: true });
  if (exitCode !== 0 || !stdout) {
    const { stdout: ns } = await runCmd('nslookup', [host], { signal: ctx.signal, allowFailure: true });
    return { success: true, output: ns, data: { host, result: ns } };
  }
  const records = stdout.split('\n').filter(Boolean);
  return { success: true, output: `${host} -> ${records.join(', ')}`, data: { host, records } };
}

async function ping(host: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, host }, 'Pinging host');
  const { stdout, exitCode } = await runCmd(
    'ping',
    ['-c', '4', '-W', '3', host],
    { signal: ctx.signal, allowFailure: true },
  );
  const reachable = exitCode === 0;
  const statsMatch = /rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(stdout);
  return {
    success: reachable,
    output: reachable ? `${host} reachable (avg ${statsMatch?.[2] ?? '?'}ms)` : `${host} unreachable`,
    data: { host, reachable, avgMs: statsMatch ? parseFloat(statsMatch[2] ?? '0') : null, raw: stdout },
  };
}

async function curlTest(host: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, host }, 'HTTP test via curl');
  const { stdout, exitCode } = await runCmd(
    'curl',
    ['-o', '/dev/null', '-s', '-w', '%{http_code}|%{time_total}|%{size_download}', '--max-time', '10', host],
    { signal: ctx.signal, allowFailure: true },
  );
  if (exitCode !== 0) {
    return { success: false, output: `curl failed for ${host}`, data: { host } };
  }
  const [httpCode, timeTotal, sizeDownload] = stdout.split('|');
  const code = parseInt(httpCode ?? '0', 10);
  return {
    success: code >= 200 && code < 400,
    output: `${host} → HTTP ${code} in ${timeTotal}s`,
    data: { host, httpCode: code, timeTotal: parseFloat(timeTotal ?? '0'), sizeBytes: parseInt(sizeDownload ?? '0', 10) },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const networkTool: ToolDefinition = {
  name: 'system.network',
  description: 'Network diagnostics: list open ports, connections, firewall rules, DNS lookup, ping, HTTP test.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: ports | connections | firewall-status | firewall-allow | dns-lookup | ping | curl-test',
      required: true,
      enum: ['ports', 'connections', 'firewall-status', 'firewall-allow', 'dns-lookup', 'ping', 'curl-test'],
    },
    port: { type: 'string', description: 'Port number or range (for firewall-allow)' },
    host: { type: 'string', description: 'Hostname or IP address' },
    protocol: { type: 'string', description: 'Protocol: tcp | udp', enum: ['tcp', 'udp'] },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const port = params['port'] as string | undefined;
    const host = params['host'] as string | undefined;
    const protocol = params['protocol'] as string | undefined;

    try {
      switch (op) {
        case 'ports':            return listPorts(ctx);
        case 'connections':      return listConnections(ctx);
        case 'firewall-status':  return firewallStatus(ctx);
        case 'firewall-allow': {
          if (!port) return { success: false, output: 'firewall-allow requires port', data: {} };
          return firewallAllow(port, protocol ?? '', ctx);
        }
        case 'dns-lookup': {
          if (!host) return { success: false, output: 'dns-lookup requires host', data: {} };
          return dnsLookup(host, ctx);
        }
        case 'ping': {
          if (!host) return { success: false, output: 'ping requires host', data: {} };
          return ping(host, ctx);
        }
        case 'curl-test': {
          if (!host) return { success: false, output: 'curl-test requires host', data: {} };
          return curlTest(host, ctx);
        }
        default:
          return { success: false, output: `Unknown operation: ${op}`, data: {} };
      }
    } catch (err) {
      return handleNotInstalled(err, 'ss/ufw/curl') as ToolResult;
    }
  },
};
