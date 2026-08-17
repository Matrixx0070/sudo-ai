/**
 * @file builtin/system/host.ts
 * @description `system.host` — the agent's full view of the machine it runs on:
 * complete SYSTEM details (OS, kernel, CPU, memory, disk, network interfaces,
 * container/VM, uptime, install path, version) AND the GEO-IP LOCATION of where
 * SUDO-AI is installed (public IP → country/region/city/coords/ISP/timezone).
 *
 * Read-only. Geo lookup is best-effort over a public API and cached (the host's
 * IP/location rarely changes), so repeated calls are cheap and the tool degrades
 * to system-only detail if there is no egress.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const execFileAsync = promisify(execFile);
const log = createLogger('tool:system-host');

// --------------------------------------------------------------------------
// Geo-IP (cached — the host's public IP/location barely changes)
// --------------------------------------------------------------------------

interface Geo {
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
}

let geoCache: { at: number; data: Geo } | null = null;
const GEO_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lookupGeo(timeoutMs = 4000): Promise<Geo> {
  if (geoCache && Date.now() - geoCache.at < GEO_TTL_MS) return geoCache.data;
  // Primary: ip-api.com (no key, rich). Fallback: ipinfo.io (https, no key).
  try {
    const j = (await fetchJson(
      'http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,query',
      timeoutMs,
    )) as Record<string, unknown>;
    if (j['status'] === 'success') {
      const data: Geo = {
        ip: String(j['query'] ?? ''),
        city: String(j['city'] ?? ''),
        region: String(j['regionName'] ?? ''),
        country: String(j['country'] ?? ''),
        countryCode: String(j['countryCode'] ?? ''),
        lat: typeof j['lat'] === 'number' ? j['lat'] : undefined,
        lon: typeof j['lon'] === 'number' ? j['lon'] : undefined,
        timezone: String(j['timezone'] ?? ''),
        isp: String(j['isp'] ?? ''),
        org: String(j['org'] ?? ''),
        as: String(j['as'] ?? ''),
      };
      geoCache = { at: Date.now(), data };
      return data;
    }
  } catch (e) {
    log.debug({ err: String(e) }, 'geo: ip-api failed — trying ipinfo');
  }
  try {
    const j = (await fetchJson('https://ipinfo.io/json', timeoutMs)) as Record<string, unknown>;
    const loc = String(j['loc'] ?? '').split(',');
    const data: Geo = {
      ip: String(j['ip'] ?? ''),
      city: String(j['city'] ?? ''),
      region: String(j['region'] ?? ''),
      country: String(j['country'] ?? ''),
      countryCode: String(j['country'] ?? ''),
      lat: loc[0] ? Number(loc[0]) : undefined,
      lon: loc[1] ? Number(loc[1]) : undefined,
      timezone: String(j['timezone'] ?? ''),
      org: String(j['org'] ?? ''),
      as: String(j['org'] ?? ''),
    };
    geoCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    log.debug({ err: String(e) }, 'geo: ipinfo failed — no location');
    return {};
  }
}

// --------------------------------------------------------------------------
// System details
// --------------------------------------------------------------------------

async function prettyOs(): Promise<string> {
  try {
    const txt = await readFile('/etc/os-release', 'utf8');
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(txt);
    if (m) return m[1]!;
  } catch { /* not linux / no file */ }
  return `${os.type()} ${os.release()}`;
}

async function diskFor(dir: string): Promise<{ size: string; used: string; avail: string; usePct: string } | null> {
  try {
    const { stdout } = await execFileAsync('df', ['-h', '--output=size,used,avail,pcent', dir], { timeout: 3000 });
    const line = stdout.trim().split('\n').pop() ?? '';
    const [size, used, avail, usePct] = line.trim().split(/\s+/);
    if (size && used && avail && usePct) return { size, used, avail, usePct };
  } catch { /* df unavailable */ }
  return null;
}

async function detectContainer(): Promise<string> {
  try { await readFile('/.dockerenv'); return 'docker'; } catch { /* not docker */ }
  try {
    const cg = await readFile('/proc/1/cgroup', 'utf8');
    if (/kubepods/.test(cg)) return 'kubernetes';
    if (/docker|containerd/.test(cg)) return 'docker';
    if (/lxc/.test(cg)) return 'lxc';
  } catch { /* no cgroup */ }
  if (process.env['KUBERNETES_SERVICE_HOST']) return 'kubernetes';
  return 'bare-metal/VM';
}

function localIPv4(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`${a.address}`);
    }
  }
  return out;
}

async function gitCommit(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 2000 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

// --------------------------------------------------------------------------
// Tool
// --------------------------------------------------------------------------

export const hostTool: ToolDefinition = {
  name: 'system.host',
  description:
    'See the full machine you are installed on: complete system details (OS, kernel, CPU, RAM, disk, network interfaces, container/VM, uptime, install path, version) AND the geo-IP location of where SUDO-AI runs (public IP, country, region, city, coordinates, ISP, timezone). Use this to answer "where are you running", "what server is this", or for environment-aware decisions.',
  category: 'system',
  safety: 'readonly',
  timeout: 12_000,
  parameters: {
    geo: { type: 'boolean', required: false, description: 'Include the geo-IP location lookup (default true).' },
  },
  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const wantGeo = params['geo'] !== false;
    const installDir = process.cwd();
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const gib = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}GiB`;

    const [pretty, disk, container, commit, geo] = await Promise.all([
      prettyOs(),
      diskFor(installDir),
      detectContainer(),
      gitCommit(installDir),
      wantGeo ? lookupGeo() : Promise.resolve<Geo>({}),
    ]);

    const system = {
      hostname: os.hostname(),
      os: pretty,
      kernel: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu: cpus[0]?.model?.trim() ?? 'unknown',
      cpuCores: cpus.length,
      loadAvg: os.loadavg().map((n) => n.toFixed(2)).join(' '),
      memory: `${gib(usedMem)} / ${gib(totalMem)} used (${Math.round((usedMem / totalMem) * 100)}%)`,
      hostUptime: `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
      node: process.version,
      pid: process.pid,
      user: (() => { try { return os.userInfo().username; } catch { return 'unknown'; } })(),
      installDir,
      ...(commit ? { commit } : {}),
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'unknown'; } })(),
      container,
      ...(disk ? { disk: `${disk.used} / ${disk.size} used (${disk.usePct}), ${disk.avail} free` } : {}),
      localIPs: localIPv4(),
    };

    const lines: string[] = [];
    lines.push('🖥️ **Host / system**');
    lines.push(`• ${system.hostname} — ${system.os} (${system.kernel}, ${system.arch})`);
    lines.push(`• CPU: ${system.cpu} ×${system.cpuCores} · load ${system.loadAvg}`);
    lines.push(`• RAM: ${system.memory} · uptime ${system.hostUptime}`);
    if (system.disk) lines.push(`• Disk (${installDir}): ${system.disk}`);
    lines.push(`• Env: ${system.container} · node ${system.node} · tz ${system.timezone}`);
    lines.push(`• Install: ${installDir}${commit ? ` @ ${commit}` : ''} · user ${system.user}`);
    if (system.localIPs.length) lines.push(`• Local IPs: ${system.localIPs.join(', ')}`);

    if (wantGeo) {
      if (geo.ip) {
        lines.push('');
        lines.push('🌍 **Geo-IP location** (where SUDO-AI is installed)');
        lines.push(`• Public IP: ${geo.ip}`);
        lines.push(`• Location: ${[geo.city, geo.region, geo.country].filter(Boolean).join(', ')}`);
        if (geo.lat != null && geo.lon != null) lines.push(`• Coordinates: ${geo.lat}, ${geo.lon}`);
        if (geo.isp || geo.org) lines.push(`• Network: ${[geo.isp, geo.org].filter(Boolean).join(' · ')}`);
        if (geo.as) lines.push(`• AS: ${geo.as}`);
        if (geo.timezone) lines.push(`• Timezone: ${geo.timezone}`);
      } else {
        lines.push('');
        lines.push('🌍 Geo-IP: unavailable (no egress or lookup failed)');
      }
    }

    return { success: true, output: lines.join('\n'), data: { system, ...(wantGeo ? { geo } : {}) } };
  },
};

/** Test seam: clear the geo cache. */
export function __resetGeoCacheForTest(): void {
  geoCache = null;
}
