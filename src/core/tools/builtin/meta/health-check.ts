/**
 * meta.health-check — SUDO-AI comprehensive self-diagnostics tool.
 *
 * Runs system, database, API key, service, tool, disk, process, and config
 * checks and returns a formatted health report with OK / WARN / CRITICAL
 * status per section.
 *
 * Actions:
 *   full       — Run ALL checks and return comprehensive report
 *   system     — CPU, memory, disk usage
 *   databases  — Check mind.db, consciousness.db, knowledge.db exist and are readable
 *   api-keys   — Verify required API key environment variables are set
 *   services   — Check ports 3000, 3001, 3002 are responding
 *   tools      — Count registered tools from the tool registry
 *   disk       — Detailed disk usage of project root and data/
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

const logger = createLogger('meta.health-check');

const PROJECT_ROOT = path.resolve('/root/sudo-ai-v4');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'sudo-ai.json5');

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type Status = 'OK' | 'WARN' | 'CRITICAL';

interface CheckResult {
  status: Status;
  summary: string;
  details?: Record<string, unknown>;
}

function validatePort(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return fallback;
  return n;
}

function worstStatus(statuses: Status[]): Status {
  if (statuses.includes('CRITICAL')) return 'CRITICAL';
  if (statuses.includes('WARN')) return 'WARN';
  return 'OK';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkSystem(): CheckResult {
  const cpuCount = os.cpus().length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const freeMemGB = (freeMem / (1024 ** 3)).toFixed(1);
  const totalMemGB = (totalMem / (1024 ** 3)).toFixed(1);

  let diskPct = 'unknown';
  try {
    const dfOut = execSync('df -h / | tail -1', { encoding: 'utf8', timeout: 5000 });
    const parts = dfOut.trim().split(/\s+/);
    diskPct = parts[4] ?? 'unknown'; // e.g. "45%"
  } catch { /* ignore */ }

  const memUsedPct = ((1 - freeMem / totalMem) * 100).toFixed(0);
  const status: Status =
    Number(memUsedPct) > 95 || (diskPct !== 'unknown' && parseInt(diskPct) > 95)
      ? 'CRITICAL'
      : Number(memUsedPct) > 85 || (diskPct !== 'unknown' && parseInt(diskPct) > 85)
        ? 'WARN'
        : 'OK';

  return {
    status,
    summary: `${cpuCount} CPUs, ${freeMemGB}/${totalMemGB} GB free, ${diskPct} disk used`,
    details: { cpuCount, totalMem, freeMem, diskPct },
  };
}

function checkDatabases(): CheckResult {
  const dbNames = ['mind.db', 'consciousness.db', 'knowledge.db'];
  const results: string[] = [];
  let missing = 0;

  for (const name of dbNames) {
    const dbPath = path.join(DATA_DIR, name);
    if (existsSync(dbPath)) {
      try {
        const size = statSync(dbPath).size;
        results.push(`${name} (${formatBytes(size)})`);
      } catch {
        results.push(`${name} (unreadable)`);
        missing++;
      }
    } else {
      results.push(`${name} MISSING`);
      missing++;
    }
  }

  const status: Status = missing === dbNames.length ? 'CRITICAL' : missing > 0 ? 'WARN' : 'OK';
  return { status, summary: results.join(', '), details: { missing } };
}

function checkApiKeys(): CheckResult {
  const keys: Record<string, string> = {
    XAI_API_KEY: 'XAI_API_KEY',
    OPENAI_API_KEY: 'OPENAI_API_KEY',
    GEMINI_API_KEY: 'GEMINI_API_KEY',
    TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  };

  const parts: string[] = [];
  let missingCount = 0;

  for (const [envVar, label] of Object.entries(keys)) {
    const present = !!process.env[envVar]?.trim();
    parts.push(`${label} ${present ? '\u2713' : '\u2717 missing'}`);
    if (!present) missingCount++;
  }

  const status: Status = missingCount >= 3 ? 'CRITICAL' : missingCount > 0 ? 'WARN' : 'OK';
  return { status, summary: parts.join(', '), details: { missingCount } };
}

function checkPort(port: number, label: string, timeoutMs: number = 3000): Promise<{ port: number; label: string; ok: boolean }> {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/`, { timeout: timeoutMs }, res => {
      res.resume(); // drain
      resolve({ port, label, ok: true });
    });
    req.on('error', () => resolve({ port, label, ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ port, label, ok: false });
    });
  });
}

async function checkServices(): Promise<CheckResult> {
  const portDefs: Array<{ port: number; label: string }> = [];
  const gatewayPort = validatePort(process.env['GATEWAY_PORT'], 18800);
  portDefs.push({ port: gatewayPort, label: 'SUDO-AI (gateway)' });

  const results = await Promise.all(portDefs.map(p => checkPort(p.port, p.label)));
  const parts = results.map(r => `:${r.port} ${r.ok ? '\u2713' : '\u2717'} ${r.label}`);
  const downCount = results.filter(r => !r.ok).length;

  const status: Status = downCount === results.length ? 'CRITICAL' : downCount > 0 ? 'WARN' : 'OK';
  return { status, summary: parts.join(', '), details: { downCount } };
}

function checkProcess(): CheckResult {
  const pid = process.pid;
  const uptimeSec = process.uptime();
  const mem = process.memoryUsage();

  let uptimeStr: string;
  if (uptimeSec < 60) uptimeStr = `${Math.round(uptimeSec)}s`;
  else if (uptimeSec < 3600) uptimeStr = `${Math.round(uptimeSec / 60)}m`;
  else uptimeStr = `${(uptimeSec / 3600).toFixed(1)}h`;

  const rssStr = formatBytes(mem.rss);
  const status: Status = mem.rss > 2 * 1024 ** 3 ? 'WARN' : 'OK';

  return {
    status,
    summary: `PID ${pid}, uptime ${uptimeStr}, RSS ${rssStr}`,
    details: { pid, uptimeSec, rss: mem.rss, heapUsed: mem.heapUsed },
  };
}

function checkConfig(): CheckResult {
  if (!existsSync(CONFIG_FILE)) {
    return { status: 'CRITICAL', summary: 'sudo-ai.json5 NOT FOUND' };
  }
  try {
    // Use json5 package for proper parsing (handles comments, trailing commas, etc.)
    const JSON5 = _require('json5') as { parse: (s: string) => unknown };
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    JSON5.parse(raw);
    return { status: 'OK', summary: 'sudo-ai.json5 valid' };
  } catch {
    return { status: 'WARN', summary: 'sudo-ai.json5 exists but failed to parse' };
  }
}

function checkDisk(): CheckResult {
  const parts: string[] = [];
  try {
    const projectSize = execSync(`du -sh ${PROJECT_ROOT} 2>/dev/null | cut -f1`, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    parts.push(`project: ${projectSize}`);
  } catch {
    parts.push('project: unknown');
  }
  try {
    const dataSize = execSync(`du -sh ${DATA_DIR} 2>/dev/null | cut -f1`, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    parts.push(`data/: ${dataSize}`);
  } catch {
    parts.push('data/: unknown');
  }

  let dfInfo = '';
  try {
    const dfOut = execSync('df -h / | tail -1', { encoding: 'utf8', timeout: 5000 });
    const cols = dfOut.trim().split(/\s+/);
    dfInfo = `total ${cols[1] ?? '?'}, free ${cols[3] ?? '?'}, ${cols[4] ?? '?'} used`;
  } catch { /* ignore */ }

  const summary = dfInfo ? `${parts.join(', ')} | ${dfInfo}` : parts.join(', ');
  return { status: 'OK', summary };
}

function checkTools(ctx: ToolContext): CheckResult {
  try {
    // Attempt to read tool count from config if registry info is available
    const config = ctx.config as Record<string, unknown> | undefined;
    const registry = config?.['toolRegistry'] as { tools?: Map<string, unknown> | Record<string, unknown>; size?: number } | undefined;
    if (registry?.size !== undefined) {
      return { status: 'OK', summary: `${registry.size} tools registered`, details: { count: registry.size } };
    }
    if (registry?.tools) {
      const count = registry.tools instanceof Map ? registry.tools.size : Object.keys(registry.tools).length;
      return { status: 'OK', summary: `${count} tools registered`, details: { count } };
    }
    // Fallback: count .ts files in builtin directories
    const builtinDir = path.resolve(PROJECT_ROOT, 'src/core/tools/builtin');
    const countOutput = execSync(
      `find ${builtinDir} -name "*.ts" ! -name "index.ts" ! -name "*.test.ts" | wc -l`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    return { status: 'OK', summary: `~${countOutput} tool files found (runtime count unavailable)`, details: { fileCount: Number(countOutput) } };
  } catch (err) {
    return { status: 'WARN', summary: 'Could not determine tool count' };
  }
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

function formatReport(sections: Record<string, CheckResult>): string {
  const now = new Date().toISOString();
  const lines: string[] = [
    `SUDO-AI Health Report \u2014 ${now}`,
    '\u2550'.repeat(46),
  ];

  const statuses: Status[] = [];
  for (const [label, result] of Object.entries(sections)) {
    const padded = (label + ':').padEnd(12);
    lines.push(`${padded}${result.status.padEnd(4)}| ${result.summary}`);
    statuses.push(result.status);
  }

  const overall = worstStatus(statuses);
  const issueCount = statuses.filter(s => s !== 'OK').length;
  lines.push('');
  lines.push(
    issueCount === 0
      ? `Overall: ${overall}`
      : `Overall: ${overall} (${issueCount} issue${issueCount > 1 ? 's' : ''})`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const healthCheckTool: ToolDefinition = {
  name: 'meta.health-check',
  description:
    'Run comprehensive self-diagnostics on SUDO-AI. Check system resources, databases, API keys, ' +
    'running services, registered tools, disk usage, process info, and config validity. ' +
    'Returns a formatted health report with OK / WARN / CRITICAL status per section.',
  category: 'meta',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Which diagnostic to run.',
      enum: ['full', 'system', 'databases', 'api-keys', 'services', 'tools', 'disk'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = (params['action'] as string | undefined) ?? 'full';
    logger.info({ session: ctx.sessionId, action }, 'meta.health-check invoked');

    try {
      switch (action) {
        case 'system': {
          const r = checkSystem();
          return { success: true, output: `System: ${r.status} | ${r.summary}`, data: r };
        }

        case 'databases': {
          const r = checkDatabases();
          return { success: true, output: `Databases: ${r.status} | ${r.summary}`, data: r };
        }

        case 'api-keys': {
          const r = checkApiKeys();
          return { success: true, output: `API Keys: ${r.status} | ${r.summary}`, data: r };
        }

        case 'services': {
          const r = await checkServices();
          return { success: true, output: `Services: ${r.status} | ${r.summary}`, data: r };
        }

        case 'tools': {
          const r = checkTools(ctx);
          return { success: true, output: `Tools: ${r.status} | ${r.summary}`, data: r };
        }

        case 'disk': {
          const r = checkDisk();
          return { success: true, output: `Disk: ${r.status} | ${r.summary}`, data: r };
        }

        case 'full': {
          const [system, databases, apiKeys, services, processInfo, config, disk, tools] =
            await Promise.all([
              checkSystem(),
              checkDatabases(),
              checkApiKeys(),
              checkServices(),
              checkProcess(),
              checkConfig(),
              checkDisk(),
              checkTools(ctx),
            ]);

          const sections: Record<string, CheckResult> = {
            System: system,
            Databases: databases,
            'API Keys': apiKeys,
            Services: services,
            Process: processInfo,
            Config: config,
            Disk: disk,
            Tools: tools,
          };

          const report = formatReport(sections);
          const overall = worstStatus(Object.values(sections).map(s => s.status));

          return {
            success: true,
            output: report,
            data: {
              pid: process.pid,
              overall,
              sections,
              timestamp: new Date().toISOString(),
            },
          };
        }

        default:
          return { success: false, output: `Unknown action: ${action}. Use one of: full, system, databases, api-keys, services, tools, disk.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.health-check error');
      return { success: false, output: `Health check error: ${msg}` };
    }
  },
};
