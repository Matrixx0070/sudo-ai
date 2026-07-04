/**
 * RepairFlywheelScanner — the periodic, report-only driver. Verifies the report
 * shape and fail-open behavior (a missing/broken DB must never throw into boot).
 */
import { describe, it, expect } from 'vitest';
import {
  buildFlywheelReport,
  RepairFlywheelScanner,
  type FlywheelScanReport,
} from '../../src/core/learning/repair-flywheel-scanner.js';
import type { FailureRow } from '../../src/core/learning/repair-flywheel.js';

describe('buildFlywheelReport', () => {
  it('reports coverage, system bugs, and top clusters', () => {
    const rows: FailureRow[] = [
      ...Array(6).fill({ tool_name: 'system.exec', error_message: 'Refused: shell metacharacters are not allowed in repo-exec' }),
      ...Array(3).fill({ tool_name: 'coder.read-file', error_message: 'Path traversal blocked: a/b.ts resolves outside project root' }),
      { tool_name: 'coder.read-file', error_message: '__dirname is not defined' },
      { tool_name: 'browser.click', error_message: 'unrelated one-off' },
    ];
    const r: FlywheelScanReport = buildFlywheelReport(rows);
    expect(r.totalFailures).toBe(11);
    expect(r.learnableCoveragePct).toBeCloseTo(81.8, 1); // 9/11 learnable
    expect(r.systemBugsFlagged).toBe(1);                  // the __dirname bug
    expect(r.topClusters[0]!.tool).toBe('system.exec');
    expect(r.topClusters[0]!.count).toBe(6);
  });
});

describe('RepairFlywheelScanner', () => {
  it('scan() is fail-open on a missing DB (returns null, never throws)', () => {
    const scanner = new RepairFlywheelScanner('/nonexistent/traces.db');
    expect(() => scanner.scan()).not.toThrow();
    expect(scanner.scan()).toBeNull();
  });

  it('start()/stop() are idempotent and do not hold the process', () => {
    const scanner = new RepairFlywheelScanner('/nonexistent/traces.db', 60_000);
    expect(() => { scanner.start(); scanner.start(); scanner.stop(); scanner.stop(); }).not.toThrow();
  });
});
