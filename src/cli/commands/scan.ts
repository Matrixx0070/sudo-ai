/**
 * @file cli/commands/scan.ts
 * @description sudo-ai scan — environment security audit.
 *
 * Checks:
 *   - GATEWAY_TOKEN strength (>= 32 chars)
 *   - LLM API keys configured
 *   - Config directory permissions (not world-readable)
 *   - data/ directory permissions (not world-writable)
 *   - Vault directory presence
 *   - Port bind address (warn if 0.0.0.0 in config)
 *   - Env var leak patterns in log files
 *   - Approval allowlist configuration
 *
 * Output: table of check | PASS/WARN/FAIL | detail
 * --json: { checks: Array<{name, status, detail}>; score: number }
 * Exit: 0 if all PASS, 1 if any FAIL.
 *
 * SECURITY: Uses spawnSync with array args only (no execSync shell interpolation).
 * NEVER reads config/.env directly — uses process.env only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScanStatus = 'PASS' | 'WARN' | 'FAIL';

export interface ScanCheck {
  name: string;
  status: ScanStatus;
  detail: string;
}

export interface ScanOptions {
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkGatewayToken(): ScanCheck {
  const name = 'GATEWAY_TOKEN strength';
  const token = process.env['GATEWAY_TOKEN'] ?? '';
  if (!token) {
    return { name, status: 'FAIL', detail: 'GATEWAY_TOKEN is not set — API is unauthenticated' };
  }
  if (token.length < 32) {
    return {
      name,
      status: 'FAIL',
      detail: `Token is only ${token.length} chars (minimum 32 required)`,
    };
  }
  return { name, status: 'PASS', detail: `Token length: ${token.length} chars` };
}

function checkEnvApiKeys(): ScanCheck {
  const name = 'LLM API keys configured';
  const keys = ['XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  const present = keys.filter((k) => !!process.env[k]);

  if (present.length === 0) {
    return { name, status: 'FAIL', detail: 'No LLM API keys set in environment' };
  }
  return { name, status: 'PASS', detail: `Found: ${present.join(', ')}` };
}

function checkConfigPermissions(projectRoot: string): ScanCheck {
  const name = 'Config directory permissions';
  const configDir = path.join(projectRoot, 'config');

  if (!fs.existsSync(configDir)) {
    return { name, status: 'WARN', detail: `config/ directory not found` };
  }

  try {
    const stat = fs.statSync(configDir);
    const mode = stat.mode & 0o777;
    const worldReadable = (mode & 0o004) !== 0;
    if (worldReadable) {
      return {
        name,
        status: 'WARN',
        detail: `config/ is world-readable (${mode.toString(8)}). Suggest: chmod 750 config/`,
      };
    }
    return { name, status: 'PASS', detail: `Permissions: ${mode.toString(8)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'WARN', detail: `Cannot stat config/: ${msg}` };
  }
}

function checkDataDirPermissions(projectRoot: string): ScanCheck {
  const name = 'data/ directory permissions';
  const dataDir = path.join(projectRoot, 'data');

  if (!fs.existsSync(dataDir)) {
    return { name, status: 'WARN', detail: 'data/ directory not found' };
  }

  try {
    const stat = fs.statSync(dataDir);
    const mode = stat.mode & 0o777;
    const worldWritable = (mode & 0o002) !== 0;
    if (worldWritable) {
      return {
        name,
        status: 'FAIL',
        detail: `data/ is world-writable (${mode.toString(8)}). Run: chmod 750 data/`,
      };
    }
    return { name, status: 'PASS', detail: `Permissions: ${mode.toString(8)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'WARN', detail: `Cannot stat data/: ${msg}` };
  }
}

function checkVaultPresence(projectRoot: string): ScanCheck {
  const name = 'Vault directory';
  const vaultDir = path.join(projectRoot, 'workspace', 'vault');
  const altVault = path.join(projectRoot, 'data', 'vault');

  if (fs.existsSync(vaultDir) || fs.existsSync(altVault)) {
    return { name, status: 'PASS', detail: 'Vault directory found' };
  }
  return {
    name,
    status: 'WARN',
    detail: 'No vault directory found (workspace/vault or data/vault)',
  };
}

function checkPortBindAddress(projectRoot: string): ScanCheck {
  const name = 'Gateway bind address (0.0.0.0 check)';
  const configPath = path.join(projectRoot, 'config', 'sudo-ai.json5');
  if (!fs.existsSync(configPath)) {
    return { name, status: 'WARN', detail: 'Config file not found — cannot verify bind address' };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    if (content.includes('0.0.0.0')) {
      return {
        name,
        status: 'WARN',
        detail: 'Gateway may bind to 0.0.0.0 (all interfaces). Consider 127.0.0.1 for local-only',
      };
    }
    return { name, status: 'PASS', detail: 'No 0.0.0.0 binding detected in config' };
  } catch {
    return { name, status: 'WARN', detail: 'Could not read config file' };
  }
}

function checkEnvLeaks(projectRoot: string): ScanCheck {
  const name = 'Env var leaks in log files';
  const sensitivePatterns = ['_API_KEY', '_SECRET', '_PASSWORD', '_TOKEN', 'PRIVATE_KEY'];
  const logDir = path.join(projectRoot, 'data', 'logs');
  const found: string[] = [];

  if (!fs.existsSync(logDir)) {
    return { name, status: 'PASS', detail: 'No log directory found — nothing to scan' };
  }

  for (const pattern of sensitivePatterns) {
    // spawnSync with array args — no shell interpolation (constraint L9)
    const result = spawnSync(
      'grep',
      ['-rl', '--include=*.log', pattern, logDir],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (result.status === 0 && result.stdout.trim()) {
      const files = result.stdout.trim().split('\n').slice(0, 2);
      found.push(`${pattern} in ${files.join(', ')}`);
    }
  }

  if (found.length > 0) {
    return {
      name,
      status: 'WARN',
      detail: found.slice(0, 2).join('; '),
    };
  }
  return { name, status: 'PASS', detail: 'No sensitive patterns found in log files' };
}

function checkApprovalAllowlist(projectRoot: string): ScanCheck {
  const name = 'Approval allowlist configured';
  const approvalsDir = path.join(projectRoot, 'workspace', 'approvals');

  if (!fs.existsSync(approvalsDir)) {
    return {
      name,
      status: 'WARN',
      detail: 'No workspace/approvals directory — domain allowlist not configured',
    };
  }

  try {
    const files = fs.readdirSync(approvalsDir);
    if (files.length === 0) {
      return { name, status: 'WARN', detail: 'Approvals directory is empty — no domains approved' };
    }
    return { name, status: 'PASS', detail: `${files.length} approval file(s) found` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'WARN', detail: `Cannot read approvals dir: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function computeScore(checks: ScanCheck[]): number {
  if (checks.length === 0) return 100;
  const passes = checks.filter((c) => c.status === 'PASS').length;
  return Math.round((passes / checks.length) * 100);
}

function printTable(checks: ScanCheck[]): void {
  const nameWidth = Math.max(...checks.map((c) => c.name.length), 30);
  const detailWidth = 58;
  const border = '-'.repeat(nameWidth + detailWidth + 16);

  console.log('\n  SUDO-AI Scan — Security Audit');
  console.log(`  ${border}`);
  console.log(
    `  ${'Status'.padEnd(6)} ${'Check'.padEnd(nameWidth)} ${'Detail'.padEnd(detailWidth)}`,
  );
  console.log(`  ${border}`);

  for (const c of checks) {
    const status = c.status.padEnd(6);
    const name   = c.name.padEnd(nameWidth);
    const detail = c.detail.substring(0, detailWidth).padEnd(detailWidth);
    console.log(`  ${status} ${name} ${detail}`);
  }

  console.log(`  ${border}`);
  const score = computeScore(checks);
  const fails  = checks.filter((c) => c.status === 'FAIL').length;
  const warns  = checks.filter((c) => c.status === 'WARN').length;
  const passes = checks.filter((c) => c.status === 'PASS').length;
  console.log(`\n  Score: ${score}/100  |  ${passes} PASS  ${warns} WARN  ${fails} FAIL\n`);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run all scan checks and print results.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param opts        - { json?: boolean }
 * @returns Exit code: 0 if all PASS, 1 if any FAIL.
 */
export async function runScan(projectRoot: string, opts: ScanOptions = {}): Promise<number> {
  const checks: ScanCheck[] = [];

  checks.push(checkGatewayToken());
  checks.push(checkEnvApiKeys());
  checks.push(checkConfigPermissions(projectRoot));
  checks.push(checkDataDirPermissions(projectRoot));
  checks.push(checkVaultPresence(projectRoot));
  checks.push(checkPortBindAddress(projectRoot));
  checks.push(checkEnvLeaks(projectRoot));
  checks.push(checkApprovalAllowlist(projectRoot));

  if (opts.json) {
    const score = computeScore(checks);
    console.log(JSON.stringify({ checks, score }, null, 2));
  } else {
    printTable(checks);
  }

  const hasFail = checks.some((c) => c.status === 'FAIL');
  return hasFail ? 1 : 0;
}
