/**
 * @file cli/commands/security-audit.ts — GW-7
 *
 * `sudo-ai security-audit [--json] [--fix]`
 *
 * Runs the pure check catalog (core/security/security-audit.ts) against the live
 * environment + filesystem and prints a human table or `--json`. Exit code: 0
 * clean, 1 if any HIGH, 2 if any CRITICAL (CI-friendly).
 *
 * `--fix` applies ONLY the narrow, reversible remediation the spec whitelists:
 * tightening sensitive-file permissions to 0600. Every other remediation is
 * printed as an exact command / an env suggestion — never applied to live env.
 */

import { existsSync, statSync, chmodSync } from 'node:fs';
import path from 'node:path';
import {
  runAuditChecks,
  fixableFindings,
  type AuditDeps,
  type AuditFinding,
  type Severity,
} from '../../core/security/security-audit.js';
import { PROJECT_ROOT } from '../../core/shared/paths.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: 'CRIT', HIGH: 'HIGH', MEDIUM: 'MED ', LOW: 'LOW ', INFO: 'INFO',
};

async function loadManifest(): Promise<readonly string[]> {
  try {
    const mod = await import('../../core/config/flag-manifest.json', { with: { type: 'json' } });
    return ((mod.default ?? mod) as { flags?: string[] }).flags ?? [];
  } catch {
    return [];
  }
}

function realDeps(manifest: readonly string[]): AuditDeps {
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p));
  return {
    env: process.env,
    manifest,
    fileExists: (p) => existsSync(abs(p)),
    fileMode: (p) => {
      try { return statSync(abs(p)).mode; } catch { return null; }
    },
  };
}

function printTable(findings: AuditFinding[]): void {
  if (findings.length === 0) {
    console.log('security-audit: clean — no findings.');
    return;
  }
  console.log(`security-audit: ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.log(`[${SEVERITY_LABEL[f.severity]}] ${f.id}`);
    console.log(`       ${f.evidence}`);
    console.log(`       fix: ${f.remediation}${f.fixable ? '  (auto-fixable with --fix)' : ''}`);
    console.log('');
  }
}

/**
 * Apply the whitelisted fixes (file-perm tightening only). Returns the paths
 * that were chmod'd. `chmod` is injectable so tests never touch the real fs.
 */
export function applyFixes(
  findings: AuditFinding[],
  chmod: (p: string, mode: number) => void = chmodSync,
  root: string = PROJECT_ROOT,
): string[] {
  const fixed: string[] = [];
  for (const f of findings) {
    if (!f.fixable || !f.fixPath) continue;
    const abs = path.isAbsolute(f.fixPath) ? f.fixPath : path.join(root, f.fixPath);
    try {
      chmod(abs, 0o600);
      fixed.push(f.fixPath);
    } catch (err) {
      console.error(`security-audit --fix: failed to chmod ${f.fixPath}: ${String(err)}`);
    }
  }
  return fixed;
}

/** Entry point wired into the cli.ts subcommand dispatch. */
export async function runSecurityAudit(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const fix = argv.includes('--fix');

  const manifest = await loadManifest();
  const deps = realDeps(manifest);
  const result = runAuditChecks(deps);

  if (fix) {
    const applied = applyFixes(fixableFindings(result));
    if (!json && applied.length) console.log(`security-audit --fix: tightened ${applied.length} file(s): ${applied.join(', ')}\n`);
  }

  // Re-run after fixes so the reported state + exit code reflect them.
  const finalResult = fix ? runAuditChecks(deps) : result;

  if (json) {
    console.log(JSON.stringify({ findings: finalResult.findings, exitCode: finalResult.exitCode }, null, 2));
  } else {
    printTable(finalResult.findings);
    const worst = finalResult.exitCode === 2 ? 'CRITICAL' : finalResult.exitCode === 1 ? 'HIGH' : 'none';
    console.log(`security-audit: worst severity = ${worst}, exit ${finalResult.exitCode}`);
  }
  return finalResult.exitCode;
}
