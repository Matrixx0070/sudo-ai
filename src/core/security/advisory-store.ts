/**
 * @file security/advisory-store.ts
 * @description SQLite-backed storage for security scan results and advisories.
 *
 * Tables:
 *  - security_scans: scan metadata (id, timestamp, component count)
 *  - security_findings: vulnerability findings linked to scans
 *  - acknowledged_findings: dismissed findings with reason and timestamp
 *
 * Uses better-sqlite3 with data/mind.db (or DATA_DIR env override).
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { OSVAdvisory } from './osv-client.js';
import type { ComponentInfo } from './component-scanner.js';

const log = createLogger('advisory-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityFinding {
  id: string;
  scanId: string;
  componentName: string;
  componentVersion: string;
  advisoryId: string;
  severity: string;
  summary: string;
  fixedVersion: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedReason: string | null;
}

export interface ScanSummary {
  id: string;
  timestamp: string;
  componentCount: number;
  findingCount: number;
  criticalCount: number;
  highCount: number;
  moderateCount: number;
  lowCount: number;
  acknowledgedCount: number;
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function getDbPath(): string {
  const dataDir = process.env['DATA_DIR'] ?? path.resolve('data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'mind.db');
}

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = getDbPath();
    log.debug({ path: dbPath }, 'Opening security database');
    dbInstance = new Database(dbPath);
    dbInstance.pragma('journal_mode = WAL');
    initSchema(dbInstance);
  }
  return dbInstance;
}

/**
 * Reset the database instance (useful for testing).
 * Closes the current connection and clears the cached instance.
 */
export function resetDbInstance(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors
    }
    dbInstance = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_scans (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      component_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_findings (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      component_name TEXT NOT NULL,
      component_version TEXT NOT NULL,
      advisory_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      fixed_version TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      acknowledged_at TEXT,
      acknowledged_reason TEXT,
      FOREIGN KEY (scan_id) REFERENCES security_scans(id)
    );

    CREATE TABLE IF NOT EXISTS acknowledged_findings (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      acknowledged_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_findings_scan_id ON security_findings(scan_id);
    CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);
    CREATE INDEX IF NOT EXISTS idx_findings_acknowledged ON security_findings(acknowledged);
  `);

  log.debug('Security database schema initialized');
}

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

export function storeScan(
  scanId: string,
  components: ComponentInfo[],
  findings: OSVAdvisory[],
): void {
  const db = getDb();
  const timestamp = new Date().toISOString();

  const insertScan = db.prepare(`
    INSERT OR REPLACE INTO security_scans (id, timestamp, component_count)
    VALUES (?, ?, ?)
  `);

  const insertFinding = db.prepare(`
    INSERT OR REPLACE INTO security_findings
    (id, scan_id, component_name, component_version, advisory_id, severity, summary, fixed_version, acknowledged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);

  const transaction = db.transaction(() => {
    insertScan.run(scanId, timestamp, components.length);

    for (const finding of findings) {
      const findingId = `${scanId}:${finding.id}:${finding.packageName}`;
      insertFinding.run(
        findingId,
        scanId,
        finding.packageName,
        '', // Component version stored in advisory
        finding.id,
        finding.severity,
        finding.summary,
        finding.fixedVersion,
      );
    }
  });

  transaction();
  log.info({ scanId, components: components.length, findings: findings.length }, 'Stored security scan');
}

export function getLatestScan(): ScanSummary | null {
  const db = getDb();

  const scanRow = db.prepare(`
    SELECT id, timestamp, component_count
    FROM security_scans
    ORDER BY timestamp DESC
    LIMIT 1
  `).get() as { id: string; timestamp: string; component_count: number } | undefined;

  if (!scanRow) return null;

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN severity = 'MODERATE' THEN 1 ELSE 0 END) as moderate,
      SUM(CASE WHEN severity = 'LOW' THEN 1 ELSE 0 END) as low,
      SUM(CASE WHEN acknowledged = 1 THEN 1 ELSE 0 END) as acknowledged
    FROM security_findings
    WHERE scan_id = ?
  `).get(scanRow.id) as {
    total: number;
    critical: number;
    high: number;
    moderate: number;
    low: number;
    acknowledged: number;
  };

  return {
    id: scanRow.id,
    timestamp: scanRow.timestamp,
    componentCount: scanRow.component_count,
    findingCount: counts.total,
    criticalCount: counts.critical,
    highCount: counts.high,
    moderateCount: counts.moderate,
    lowCount: counts.low,
    acknowledgedCount: counts.acknowledged,
  };
}

export function getAdvisories(severity?: string): SecurityFinding[] {
  const db = getDb();

  let query = `
    SELECT id, scan_id, component_name, component_version, advisory_id,
           severity, summary, fixed_version, acknowledged, acknowledged_at, acknowledged_reason
    FROM security_findings
    WHERE acknowledged = 0
  `;

  const params: (string | number)[] = [];
  if (severity) {
    query += ' AND severity = ?';
    params.push(severity);
  }

  query += ' ORDER BY severity DESC, component_name ASC';

  const rows = db.prepare(query).all(...params) as Array<{
    id: string;
    scan_id: string;
    component_name: string;
    component_version: string;
    advisory_id: string;
    severity: string;
    summary: string;
    fixed_version: string | null;
    acknowledged: number;
    acknowledged_at: string | null;
    acknowledged_reason: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    scanId: row.scan_id,
    componentName: row.component_name,
    componentVersion: row.component_version,
    advisoryId: row.advisory_id,
    severity: row.severity,
    summary: row.summary,
    fixedVersion: row.fixed_version,
    acknowledged: row.acknowledged === 1,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedReason: row.acknowledged_reason,
  }));
}

export function acknowledgeFinding(findingId: string, reason: string): boolean {
  const db = getDb();
  const acknowledgedAt = new Date().toISOString();

  const update = db.prepare(`
    UPDATE security_findings
    SET acknowledged = 1, acknowledged_at = ?, acknowledged_reason = ?
    WHERE id = ?
  `);

  const result = update.run(acknowledgedAt, reason, findingId);
  log.info({ findingId, reason }, 'Acknowledged security finding');

  return result.changes > 0;
}

export function acknowledgeAll(severity?: string): number {
  const db = getDb();
  const acknowledgedAt = new Date().toISOString();

  let query = `
    UPDATE security_findings
    SET acknowledged = 1, acknowledged_at = ?, acknowledged_reason = 'Bulk acknowledgment'
    WHERE acknowledged = 0
  `;

  const params: (string | number)[] = [acknowledgedAt];
  if (severity) {
    query += ' AND severity = ?';
    params.push(severity);
  }

  const result = db.prepare(query).run(...params);
  log.info({ count: result.changes, severity }, 'Bulk acknowledged findings');

  return result.changes;
}

export function getSummary(): ScanSummary | null {
  return getLatestScan();
}

/**
 * Get findings that have not been acknowledged and are older than a threshold.
 * Used by audit-banner to detect new critical findings.
 */
export function getUnacknowledgedFindings(sinceMs: number): SecurityFinding[] {
  const db = getDb();
  const sinceDate = new Date(sinceMs).toISOString();

  const rows = db.prepare(`
    SELECT id, scan_id, component_name, component_version, advisory_id,
           severity, summary, fixed_version, acknowledged, acknowledged_at, acknowledged_reason
    FROM security_findings
    WHERE acknowledged = 0 AND scan_id IN (
      SELECT id FROM security_scans WHERE timestamp >= ?
    )
    ORDER BY
      CASE severity
        WHEN 'CRITICAL' THEN 1
        WHEN 'HIGH' THEN 2
        WHEN 'MODERATE' THEN 3
        WHEN 'LOW' THEN 4
        ELSE 5
      END,
      component_name ASC
  `).all(sinceDate) as Array<{
    id: string;
    scan_id: string;
    component_name: string;
    component_version: string;
    advisory_id: string;
    severity: string;
    summary: string;
    fixed_version: string | null;
    acknowledged: number;
    acknowledged_at: string | null;
    acknowledged_reason: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    scanId: row.scan_id,
    componentName: row.component_name,
    componentVersion: row.component_version,
    advisoryId: row.advisory_id,
    severity: row.severity,
    summary: row.summary,
    fixedVersion: row.fixed_version,
    acknowledged: row.acknowledged === 1,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedReason: row.acknowledged_reason,
  }));
}

/**
 * Get the timestamp of the last acknowledgment.
 */
export function getLastAcknowledgmentTime(): number {
  const db = getDb();

  const row = db.prepare(`
    SELECT MAX(acknowledged_at) as last_ack FROM security_findings WHERE acknowledged = 1
  `).get() as { last_ack: string | null } | undefined;

  if (!row?.last_ack) return 0;
  return new Date(row.last_ack).getTime();
}
