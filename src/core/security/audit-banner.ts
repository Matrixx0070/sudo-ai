/**
 * @file security/audit-banner.ts
 * @description Startup and on-call security audit banner display.
 *
 * Behavior:
 *  - On call: checks if latest scan is stale (>24h), logs summary
 *  - Displays CRITICAL/HIGH findings formatted
 *  - Only logs if new critical findings since last acknowledgment (24h cache)
 *
 * Kill-switches:
 *  - SUDO_SECURITY_AUDIT_DISABLE=1 — disable all audit functionality
 *  - SUDO_SECURITY_SCAN_ON_STARTUP=0 — skip startup scan (default: 0, off by default)
 *
 * Env:
 *  - SUDO_SECURITY_SCAN_INTERVAL_HOURS — staleness threshold (default: 24)
 */

import { createLogger } from '../shared/logger.js';
import { getSummary, getUnacknowledgedFindings, getLastAcknowledgmentTime } from './advisory-store.js';
import { scanAll } from './component-scanner.js';
import { batchQuery } from './osv-client.js';
import { storeScan } from './advisory-store.js';
import { randomUUID } from 'node:crypto';

const log = createLogger('audit-banner');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SCAN_INTERVAL_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getScanIntervalMs(): number {
  const hours = parseInt(process.env['SUDO_SECURITY_SCAN_INTERVAL_HOURS'] ?? '24', 10);
  return (isNaN(hours) ? DEFAULT_SCAN_INTERVAL_HOURS : hours) * MS_PER_HOUR;
}

function formatSeverity(severity: string): string {
  const icons: Record<string, string> = {
    CRITICAL: '🔴 CRITICAL',
    HIGH: '🟠 HIGH',
    MODERATE: '🟡 MODERATE',
    LOW: '🟢 LOW',
  };
  return icons[severity] ?? severity;
}

function formatFinding(finding: {
  componentName: string;
  advisoryId: string;
  severity: string;
  summary: string;
  fixedVersion: string | null;
}): string {
  const lines = [
    `  ${formatSeverity(finding.severity)}: ${finding.componentName} (${finding.advisoryId})`,
    `    Summary: ${finding.summary}`,
  ];
  if (finding.fixedVersion) {
    lines.push(`    Fix: Upgrade to ${finding.fixedVersion}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main banner logic
// ---------------------------------------------------------------------------

/**
 * Check and display security audit status.
 * Returns true if there are new critical/high findings to report.
 */
export function checkAndDisplayBanner(): boolean {
  if (process.env['SUDO_SECURITY_AUDIT_DISABLE'] === '1') {
    log.debug('Security audit disabled via SUDO_SECURITY_AUDIT_DISABLE');
    return false;
  }

  const scanIntervalMs = getScanIntervalMs();
  const now = Date.now();
  const staleThreshold = now - scanIntervalMs;

  // Get latest scan summary
  const summary = getSummary();

  if (!summary) {
    log.info('No previous security scans found. Run POST /v1/admin/security/audit to scan.');
    return false;
  }

  const scanAge = now - new Date(summary.timestamp).getTime();
  const isStale = scanAge > scanIntervalMs;
  const scanAgeHours = Math.round(scanAge / MS_PER_HOUR);

  // Check for new findings since last acknowledgment
  const lastAckTime = getLastAcknowledgmentTime();
  const newFindings = getUnacknowledgedFindings(lastAckTime || staleThreshold);

  const criticalHighFindings = newFindings.filter(
    f => f.severity === 'CRITICAL' || f.severity === 'HIGH',
  );

  // Log banner if scan is stale OR there are new critical/high findings
  if (isStale || criticalHighFindings.length > 0) {
    log.info('='.repeat(60));
    log.info('SECURITY AUDIT STATUS');
    log.info('='.repeat(60));
    log.info(`Last scan: ${summary.timestamp} (${scanAgeHours}h ago)`);
    log.info(`Status: ${isStale ? 'STALE (older than ${Math.round(scanIntervalMs / MS_PER_HOUR)}h)' : 'CURRENT'}`);
    log.info(`Components: ${summary.componentCount}`);
    log.info(`Findings: ${summary.findingCount} total`);
    log.info(`  - CRITICAL: ${summary.criticalCount}`);
    log.info(`  - HIGH: ${summary.highCount}`);
    log.info(`  - MODERATE: ${summary.moderateCount}`);
    log.info(`  - LOW: ${summary.lowCount}`);
    log.info(`  - Acknowledged: ${summary.acknowledgedCount}`);

    if (criticalHighFindings.length > 0) {
      log.info('');
      log.info('NEW CRITICAL/HIGH FINDINGS:');
      for (const finding of criticalHighFindings) {
        log.info(formatFinding(finding));
      }
      log.info('');
      log.info('Acknowledge findings via POST /v1/admin/security/advisories/:id/acknowledge');
    }

    log.info('='.repeat(60));
    return criticalHighFindings.length > 0;
  }

  log.debug(
    { scanAge: `${scanAgeHours}h`, findings: summary.findingCount },
    'Security scan is current, no new critical findings',
  );
  return false;
}

/**
 * Run a security scan and display the results banner.
 * Used for on-demand scans via CLI or scheduled runs.
 */
export async function runScanAndDisplayBanner(): Promise<void> {
  if (process.env['SUDO_SECURITY_AUDIT_DISABLE'] === '1') {
    log.info('Security audit disabled via SUDO_SECURITY_AUDIT_DISABLE');
    return;
  }

  log.info('Running security scan...');

  try {
    // Scan components
    const components = scanAll();
    log.info({ count: components.length }, 'Components discovered');

    // Query OSV for npm and PyPI packages
    const osvPackages = components
      .filter(c => c.ecosystem === 'npm' || c.ecosystem === 'PyPI')
      .map(c => ({
        name: c.name,
        version: c.version,
        ecosystem: c.ecosystem === 'npm' ? 'npm' as const : 'PyPI' as const,
      }));

    const advisories = await batchQuery(osvPackages);
    log.info({ findings: advisories.length }, 'OSV query complete');

    // Store results
    const scanId = `scan-${randomUUID().slice(0, 8)}`;
    storeScan(scanId, components, advisories);

    // Display summary
    log.info('='.repeat(60));
    log.info('SECURITY SCAN COMPLETE');
    log.info('='.repeat(60));
    log.info(`Scan ID: ${scanId}`);
    log.info(`Components: ${components.length}`);
    log.info(`Findings: ${advisories.length}`);
    log.info(`  - CRITICAL: ${advisories.filter(a => a.severity === 'CRITICAL').length}`);
    log.info(`  - HIGH: ${advisories.filter(a => a.severity === 'HIGH').length}`);
    log.info(`  - MODERATE: ${advisories.filter(a => a.severity === 'MODERATE').length}`);
    log.info(`  - LOW: ${advisories.filter(a => a.severity === 'LOW').length}`);
    log.info('='.repeat(60));

    // Display critical/high findings
    const criticalHigh = advisories.filter(a => a.severity === 'CRITICAL' || a.severity === 'HIGH');
    if (criticalHigh.length > 0) {
      log.info('');
      log.info('CRITICAL/HIGH FINDINGS:');
      for (const finding of criticalHigh) {
        log.info(formatFinding({
          componentName: finding.packageName,
          advisoryId: finding.id,
          severity: finding.severity,
          summary: finding.summary,
          fixedVersion: finding.fixedVersion,
        }));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'Security scan failed');
    throw err;
  }
}
