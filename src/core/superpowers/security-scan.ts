/**
 * super.security-scan — Scan for vulnerabilities.
 *
 * Modes: code (hardcoded secrets / SQLi / XSS / eval), deps (npm audit),
 *        network (open ports via ss), all (combines all three).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('super.security-scan');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Code scan
// ---------------------------------------------------------------------------

const CODE_PATTERNS: Array<{ regex: RegExp; severity: Finding['severity']; category: string; message: string }> = [
  { regex: /(['"`])(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\1\s*[:=]\s*['"`][^'"`]{6,}/i, severity: 'critical', category: 'hardcoded-secret', message: 'Possible hardcoded secret/credential detected.' },
  { regex: /eval\s*\(/,                                                  severity: 'high',     category: 'eval-usage',       message: 'eval() usage detected — potential code injection.' },
  { regex: /new\s+Function\s*\(/,                                        severity: 'high',     category: 'dynamic-function', message: 'new Function() detected — potential code injection.' },
  { regex: /exec\s*\(\s*['"`][^'"`]*\$\{/,                              severity: 'high',     category: 'cmd-injection',    message: 'Shell exec with template literal — possible command injection.' },
  { regex: /innerHTML\s*=/,                                              severity: 'medium',   category: 'xss',              message: 'innerHTML assignment — potential XSS.' },
  { regex: /document\.write\s*\(/,                                       severity: 'medium',   category: 'xss',              message: 'document.write() — potential XSS.' },
  { regex: /SELECT\s+.+\s+FROM\s+.+\s+WHERE\s+.+\+\s*(?:req|body|params|query)/i, severity: 'critical', category: 'sql-injection', message: 'String-concatenated SQL query — possible SQL injection.' },
  { regex: /process\.env\.\w+\s*\|\|\s*['"`][^'"`]{8,}/,               severity: 'low',      category: 'env-fallback',     message: 'Env var with hardcoded fallback — may expose secrets in logs.' },
];

const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.jsx', '.tsx', '.py', '.php', '.rb']);
const MAX_FILE_SIZE = 500 * 1024; // 500 KB

async function collectFiles(dir: string, files: string[] = []): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return files; }

  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) await collectFiles(full, files);
    else if (info.isFile() && SCAN_EXTENSIONS.has(extname(entry))) files.push(full);
  }
  return files;
}

async function scanCode(scanPath: string): Promise<Finding[]> {
  const files = await collectFiles(scanPath);
  const findings: Finding[] = [];

  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info || info.size > MAX_FILE_SIZE) continue;
    const source = await readFile(file, 'utf8').catch(() => '');
    const lines = source.split('\n');
    lines.forEach((line, idx) => {
      for (const { regex, severity, category, message } of CODE_PATTERNS) {
        if (regex.test(line)) {
          findings.push({ severity, category, message, location: `${file}:${idx + 1}` });
        }
      }
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Dependency scan
// ---------------------------------------------------------------------------

async function scanDeps(scanPath: string, signal?: AbortSignal): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    const { stdout } = await execFileAsync('npm', ['audit', '--json'], {
      cwd: scanPath, signal, maxBuffer: 8 * 1024 * 1024,
    }).catch((e: unknown) => {
      const err = e as { stdout?: string };
      return { stdout: err.stdout ?? '{}' };
    });

    const audit = JSON.parse(stdout) as {
      vulnerabilities?: Record<string, { severity: string; name: string }>;
    };

    const severityMap = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low' } as const;
    for (const [, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
      const severity: Finding['severity'] = severityMap[vuln.severity as keyof typeof severityMap] ?? 'info';
      findings.push({ severity, category: 'npm-vulnerability', message: `${vuln.name} has a ${vuln.severity} vulnerability.` });
    }
  } catch (err) {
    logger.warn({ err }, 'npm audit failed or no package.json');
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Network scan
// ---------------------------------------------------------------------------

async function scanNetwork(signal?: AbortSignal): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp'], { signal, maxBuffer: 4 * 1024 * 1024 });
    const lines = stdout.split('\n').slice(1).filter(Boolean);
    for (const line of lines) {
      const m = line.match(/(\d+\.\d+\.\d+\.\d+|\[::\]):(\d+)/);
      if (m) {
        const addr = m[1]; const port = m[2];
        const isPublic = addr === '0.0.0.0' || addr === '[::]';
        findings.push({
          severity: isPublic ? 'medium' : 'info',
          category: 'open-port',
          message: `Port ${port} listening on ${addr}${isPublic ? ' (publicly exposed)' : ''}`,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'ss command failed');
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const securityScanTool: ToolDefinition = {
  name: 'super.security-scan',
  description: 'Scan for security vulnerabilities: code patterns (secrets/SQLi/XSS/eval), npm dependencies, or open network ports.',
  category: 'superpowers',
  timeout: 120_000,
  parameters: {
    path: { type: 'string', description: 'Directory to scan (defaults to workingDir).', default: '.' },
    scanType: {
      type: 'string',
      description: 'What to scan.',
      required: true,
      enum: ['code', 'deps', 'network', 'all'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const scanPath = (params['path'] as string | undefined) ?? ctx.workingDir;
    const scanType = params['scanType'] as string;

    logger.info({ session: ctx.sessionId, scanPath, scanType }, 'Security scan started');

    const findings: Finding[] = [];

    try {
      if (scanType === 'code' || scanType === 'all') findings.push(...await scanCode(scanPath));
      if (scanType === 'deps' || scanType === 'all') findings.push(...await scanDeps(scanPath, ctx.signal));
      if (scanType === 'network' || scanType === 'all') findings.push(...await scanNetwork(ctx.signal));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Security scan error');
      return { success: false, output: `Security scan failed: ${msg}` };
    }

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) bySeverity[f.severity]++;

    const summary = `Found ${findings.length} finding(s): critical=${bySeverity.critical} high=${bySeverity.high} medium=${bySeverity.medium} low=${bySeverity.low} info=${bySeverity.info}`;
    logger.info({ scanType, findingCount: findings.length }, 'Security scan complete');

    return {
      success: true,
      output: summary,
      data: { scanPath, scanType, findings, summary: bySeverity },
    };
  },
};
