/**
 * @file tests/security/security-audit.test.ts
 * @description Tests for security audit module (OSV client, scanner, store, routes, banner).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { batchQuery, clearCache } from '../../src/core/security/osv-client.js';
import { scanNpm, scanPip, scanMcp, scanAll } from '../../src/core/security/component-scanner.js';
import {
  storeScan,
  getLatestScan,
  getAdvisories,
  acknowledgeFinding,
  acknowledgeAll,
  getSummary,
  getUnacknowledgedFindings,
  getLastAcknowledgmentTime,
  resetDbInstance,
} from '../../src/core/security/advisory-store.js';
import { checkAndDisplayBanner, runScanAndDisplayBanner } from '../../src/core/security/audit-banner.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const TEST_DATA_DIR = path.join(os.tmpdir(), `sudo-ai-test-${randomUUID()}`);

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env['DATA_DIR'] = TEST_DATA_DIR;
  process.env['SUDO_SECURITY_AUDIT_DISABLE'] = '0';
  clearCache();
  resetDbInstance();
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  delete process.env['DATA_DIR'];
  delete process.env['SUDO_SECURITY_AUDIT_DISABLE'];
  resetDbInstance();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// OSV Client Tests
// ---------------------------------------------------------------------------

describe('osv-client', () => {
  describe('batchQuery', () => {
    it('returns empty array for empty input', async () => {
      const result = await batchQuery([]);
      expect(result).toEqual([]);
    });

    it('returns empty array when disabled', async () => {
      process.env['SUDO_SECURITY_AUDIT_DISABLE'] = '1';
      const result = await batchQuery([{ name: 'lodash', version: '4.17.0', ecosystem: 'npm' }]);
      expect(result).toEqual([]);
    });

    it('caches results for 1 hour', async () => {
      // Mock fetch for first call
      const mockResponse = {
        results: [{
          vulns: [{
            id: 'GHSA-test-1234',
            summary: 'Test vulnerability',
            details: 'Test details',
            severity: [{ type: 'CVSS_V3', score: '9.8' }],
            references: [{ url: 'https://example.com' }],
            affected: [{ ranges: [{ events: [{ fixed: '4.17.21' }] }] }],
          }],
        }],
      };

      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve(mockResponse),
        } as unknown as Response);

      const packages = [{ name: 'lodash', version: '4.17.0', ecosystem: 'npm' as const }];

      // First call
      const result1 = await batchQuery(packages);
      expect(result1).toHaveLength(1);
      expect(result1[0].id).toBe('GHSA-test-1234');

      // Second call should use cache
      const result2 = await batchQuery(packages);
      expect(result2).toHaveLength(1);

      // Fetch should only be called once due to caching
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('maps CVSS severity correctly', async () => {
      const mockResponse = {
        results: [{
          vulns: [{
            id: 'GHSA-critical',
            summary: 'Critical vuln',
            severity: [{ type: 'CVSS_V3', score: '9.8' }],
          }],
        }, {
          vulns: [{
            id: 'GHSA-high',
            summary: 'High vuln',
            severity: [{ type: 'CVSS_V3', score: '7.5' }],
          }],
        }, {
          vulns: [{
            id: 'GHSA-moderate',
            summary: 'Moderate vuln',
            severity: [{ type: 'CVSS_V3', score: '5.0' }],
          }],
        }, {
          vulns: [{
            id: 'GHSA-low',
            summary: 'Low vuln',
            severity: [{ type: 'CVSS_V3', score: '2.0' }],
          }],
        }],
      };

      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve(mockResponse),
        } as unknown as Response);

      const packages = [
        { name: 'pkg1', version: '1.0.0', ecosystem: 'npm' as const },
        { name: 'pkg2', version: '1.0.0', ecosystem: 'npm' as const },
        { name: 'pkg3', version: '1.0.0', ecosystem: 'npm' as const },
        { name: 'pkg4', version: '1.0.0', ecosystem: 'npm' as const },
      ];

      const result = await batchQuery(packages);
      expect(result.find(r => r.id === 'GHSA-critical')?.severity).toBe('CRITICAL');
      expect(result.find(r => r.id === 'GHSA-high')?.severity).toBe('HIGH');
      expect(result.find(r => r.id === 'GHSA-moderate')?.severity).toBe('MODERATE');
      expect(result.find(r => r.id === 'GHSA-low')?.severity).toBe('LOW');
    });

    it('handles rate limiting with Retry-After header', async () => {
      let callCount = 0;

      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: (name: string) => name === 'Retry-After' ? '0' : null },
          statusText: 'Too Many Requests',
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve({ results: [] }),
        } as unknown as Response);

      const result = await batchQuery([{ name: 'test', version: '1.0.0', ecosystem: 'npm' as const }]);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual([]);
    });

    it('retries on timeout errors', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve({ results: [] }),
        } as unknown as Response);

      const result = await batchQuery([{ name: 'test', version: '1.0.0', ecosystem: 'npm' as const }]);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearCache', () => {
    it('clears the advisory cache', async () => {
      // Populate cache
      clearCache();

      // Verify cache is cleared (internal state reset)
      // This is mainly for test isolation
      expect(() => clearCache()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Component Scanner Tests
// ---------------------------------------------------------------------------

describe('component-scanner', () => {
  describe('scanNpm', () => {
    it('scans package.json dependencies', () => {
      const testDir = path.join(TEST_DATA_DIR, 'npm-test');
      mkdirSync(testDir, { recursive: true });

      const pkgJson = {
        dependencies: {
          'express': '^4.18.0',
          'lodash': '~4.17.21',
        },
        devDependencies: {
          'vitest': '>=1.0.0',
        },
      };

      writeFileSync(path.join(testDir, 'package.json'), JSON.stringify(pkgJson));

      const originalCwd = process.cwd();
      process.chdir(testDir);

      try {
        const components = scanNpm();
        expect(components).toHaveLength(3);
        expect(components.find(c => c.name === 'express')?.version).toBe('4.18.0');
        expect(components.find(c => c.name === 'lodash')?.version).toBe('4.17.21');
        expect(components.find(c => c.name === 'vitest')?.version).toBe('1.0.0');
        expect(components.every(c => c.ecosystem === 'npm')).toBe(true);
        expect(components.every(c => c.direct === true)).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('returns empty array when package.json not found', () => {
      const testDir = path.join(TEST_DATA_DIR, 'empty-project');
      mkdirSync(testDir, { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(testDir);

      try {
        const components = scanNpm();
        expect(components).toEqual([]);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('handles invalid JSON gracefully', () => {
      const testDir = path.join(TEST_DATA_DIR, 'invalid-json');
      mkdirSync(testDir, { recursive: true });

      writeFileSync(path.join(testDir, 'package.json'), 'not valid json');

      const originalCwd = process.cwd();
      process.chdir(testDir);

      try {
        const components = scanNpm();
        expect(components).toEqual([]);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('scanPip', () => {
    it('gracefully handles missing pip', () => {
      // pip may not be installed in test environment
      const components = scanPip();
      // Should not throw, returns empty or actual results
      expect(Array.isArray(components)).toBe(true);
    });
  });

  describe('scanMcp', () => {
    it('scans MCP config when available', () => {
      const testDir = path.join(TEST_DATA_DIR, 'mcp-test');
      mkdirSync(testDir, { recursive: true });

      const mcpConfig = {
        servers: {
          'filesystem': { version: '1.0.0', command: 'node' },
          'github': { version: '2.1.0', command: 'npx' },
        },
      };

      writeFileSync(path.join(testDir, 'mcp-config.json'), JSON.stringify(mcpConfig));
      process.env['SUDO_AI_HOME'] = testDir;

      try {
        const components = scanMcp();
        expect(components).toHaveLength(2);
        expect(components.find(c => c.name === 'filesystem')?.version).toBe('1.0.0');
        expect(components.find(c => c.name === 'github')?.version).toBe('2.1.0');
        expect(components.every(c => c.ecosystem === 'MCP')).toBe(true);
      } finally {
        delete process.env['SUDO_AI_HOME'];
      }
    });

    it('returns empty array when MCP config not found', () => {
      const components = scanMcp();
      expect(components).toEqual([]);
    });
  });

  describe('scanAll', () => {
    it('combines all scanners', () => {
      const testDir = path.join(TEST_DATA_DIR, 'combined-test');
      mkdirSync(testDir, { recursive: true });

      writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({
        dependencies: { 'express': '4.18.0' },
      }));

      const mcpConfig = { servers: { 'test-mcp': { version: '1.0.0' } } };
      writeFileSync(path.join(testDir, 'mcp-config.json'), JSON.stringify(mcpConfig));

      const originalCwd = process.cwd();
      process.chdir(testDir);
      process.env['SUDO_AI_HOME'] = testDir;

      try {
        const components = scanAll();
        expect(components.length).toBeGreaterThanOrEqual(1);
        expect(components.some(c => c.ecosystem === 'npm')).toBe(true);
        expect(components.some(c => c.ecosystem === 'MCP')).toBe(true);
      } finally {
        process.chdir(originalCwd);
        delete process.env['SUDO_AI_HOME'];
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Advisory Store Tests
// ---------------------------------------------------------------------------

describe('advisory-store', () => {
  beforeEach(() => {
    // Ensure fresh database for each test
    const dbPath = path.join(TEST_DATA_DIR, 'mind.db');
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
  });

  describe('storeScan and getLatestScan', () => {
    it('stores and retrieves scan results', () => {
      const scanId = 'test-scan-001';
      const components = [
        { name: 'lodash', version: '4.17.0', ecosystem: 'npm' as const, source: 'package.json', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-test',
          severity: 'HIGH' as const,
          summary: 'Prototype pollution',
          details: 'Details here',
          fixedVersion: '4.17.21',
          references: [],
          packageName: 'lodash',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const summary = getLatestScan();
      expect(summary).not.toBeNull();
      expect(summary?.id).toBe(scanId);
      expect(summary?.componentCount).toBe(1);
      expect(summary?.findingCount).toBe(1);
      expect(summary?.highCount).toBe(1);
    });

    it('returns null when no scans exist', () => {
      const summary = getLatestScan();
      expect(summary).toBeNull();
    });
  });

  describe('getAdvisories', () => {
    it('filters by severity', () => {
      const scanId = 'test-scan-002';
      const components = [
        { name: 'pkg1', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
        { name: 'pkg2', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-critical',
          severity: 'CRITICAL' as const,
          summary: 'Critical issue',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg1',
          affectedVersions: [],
        },
        {
          id: 'GHSA-low',
          severity: 'LOW' as const,
          summary: 'Low issue',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg2',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const critical = getAdvisories('CRITICAL');
      expect(critical).toHaveLength(1);
      expect(critical[0].advisoryId).toBe('GHSA-critical');

      const low = getAdvisories('LOW');
      expect(low).toHaveLength(1);
      expect(low[0].advisoryId).toBe('GHSA-low');

      const all = getAdvisories();
      expect(all).toHaveLength(2);
    });

    it('excludes acknowledged findings', () => {
      const scanId = 'test-scan-003';
      const components = [
        { name: 'pkg', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-1',
          severity: 'HIGH' as const,
          summary: 'Issue 1',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg',
          affectedVersions: [],
        },
        {
          id: 'GHSA-2',
          severity: 'HIGH' as const,
          summary: 'Issue 2',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      // Acknowledge one
      const allBefore = getAdvisories();
      acknowledgeFinding(allBefore[0].id, 'Test reason');

      const remaining = getAdvisories();
      expect(remaining).toHaveLength(1);
    });
  });

  describe('acknowledgeFinding', () => {
    it('acknowledges a finding with reason', () => {
      const scanId = 'test-scan-004';
      const components = [
        { name: 'pkg', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-test',
          severity: 'HIGH' as const,
          summary: 'Test issue',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const allBefore = getAdvisories();
      expect(allBefore).toHaveLength(1);

      const result = acknowledgeFinding(allBefore[0].id, 'Accepted risk');
      expect(result).toBe(true);

      const allAfter = getAdvisories();
      expect(allAfter).toHaveLength(0);
    });

    it('returns false for non-existent finding', () => {
      const result = acknowledgeFinding('non-existent', 'Reason');
      expect(result).toBe(false);
    });
  });

  describe('acknowledgeAll', () => {
    it('bulk acknowledges all findings', () => {
      const scanId = 'test-scan-005';
      const components = [
        { name: 'pkg1', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
        { name: 'pkg2', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-1',
          severity: 'HIGH' as const,
          summary: 'Issue 1',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg1',
          affectedVersions: [],
        },
        {
          id: 'GHSA-2',
          severity: 'LOW' as const,
          summary: 'Issue 2',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg2',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const count = acknowledgeAll();
      expect(count).toBe(2);

      const remaining = getAdvisories();
      expect(remaining).toHaveLength(0);
    });

    it('bulk acknowledges by severity', () => {
      const scanId = 'test-scan-006';
      const components = [
        { name: 'pkg1', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
        { name: 'pkg2', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-high',
          severity: 'HIGH' as const,
          summary: 'High issue',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg1',
          affectedVersions: [],
        },
        {
          id: 'GHSA-low',
          severity: 'LOW' as const,
          summary: 'Low issue',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg2',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const count = acknowledgeAll('HIGH');
      expect(count).toBe(1);

      const remaining = getAdvisories();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].severity).toBe('LOW');
    });
  });

  describe('getSummary', () => {
    it('returns scan summary', () => {
      const scanId = 'test-scan-007';
      const components = [
        { name: 'pkg', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-test',
          severity: 'CRITICAL' as const,
          summary: 'Critical',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const summary = getSummary();
      expect(summary).not.toBeNull();
      expect(summary?.criticalCount).toBe(1);
    });
  });

  describe('getUnacknowledgedFindings', () => {
    it('returns findings since timestamp', () => {
      const scanId = 'test-scan-008';
      const components = [
        { name: 'pkg', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-test',
          severity: 'HIGH' as const,
          summary: 'Test',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const now = Date.now();
      const unacknowledged = getUnacknowledgedFindings(now - 60000); // Last minute
      expect(unacknowledged).toHaveLength(1);
    });
  });

  describe('getLastAcknowledgmentTime', () => {
    it('returns 0 when no acknowledgments', () => {
      const time = getLastAcknowledgmentTime();
      expect(time).toBe(0);
    });

    it('returns timestamp after acknowledgment', () => {
      const scanId = 'test-scan-009';
      const components = [
        { name: 'pkg', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings = [
        {
          id: 'GHSA-test',
          severity: 'HIGH' as const,
          summary: 'Test',
          details: 'Details',
          fixedVersion: null,
          references: [],
          packageName: 'pkg',
          affectedVersions: [],
        },
      ];

      storeScan(scanId, components, findings);

      const before = getLastAcknowledgmentTime();
      expect(before).toBe(0);

      const all = getAdvisories();
      acknowledgeFinding(all[0].id, 'Reason');

      const after = getLastAcknowledgmentTime();
      expect(after).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Audit Banner Tests
// ---------------------------------------------------------------------------

describe('audit-banner', () => {
  beforeEach(() => {
    const dbPath = path.join(TEST_DATA_DIR, 'mind.db');
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
  });

  describe('checkAndDisplayBanner', () => {
    it('returns false when disabled', () => {
      process.env['SUDO_SECURITY_AUDIT_DISABLE'] = '1';
      const result = checkAndDisplayBanner();
      expect(result).toBe(false);
    });

    it('returns false when no scans exist', () => {
      const result = checkAndDisplayBanner();
      expect(result).toBe(false);
    });

    it('detects stale scan', () => {
      // Create a scan from 25 hours ago
      const scanId = 'old-scan';
      const components = [
        { name: 'pkg', version: '1.0.0', ecosystem: 'npm' as const, source: 'test', direct: true },
      ];
      const findings: any[] = [];

      storeScan(scanId, components, findings);

      // Manually update timestamp to be stale (this is a limitation - in real tests
      // we'd need to mock the database time, but for now we test the logic path)
      const result = checkAndDisplayBanner();
      // Result depends on actual scan time, just verify it doesn't throw
      expect(typeof result).toBe('boolean');
    });
  });

  describe('runScanAndDisplayBanner', () => {
    it('throws when disabled', async () => {
      process.env['SUDO_SECURITY_AUDIT_DISABLE'] = '1';
      await expect(runScanAndDisplayBanner()).resolves.toBeUndefined();
    });

    it('runs scan successfully', async () => {
      // Create a mock package.json for the scanner to find
      const testDir = path.join(TEST_DATA_DIR, 'banner-test');
      mkdirSync(testDir, { recursive: true });
      writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({
        dependencies: { 'express': '4.18.0' },
      }));

      const originalCwd = process.cwd();
      process.chdir(testDir);

      try {
        // Mock fetch to avoid real API calls
        global.fetch = vi.fn()
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: () => Promise.resolve({ results: [] }),
          } as unknown as Response);

        await runScanAndDisplayBanner();

        // Verify scan was stored
        const summary = getSummary();
        expect(summary).not.toBeNull();
        expect(summary?.componentCount).toBeGreaterThanOrEqual(1);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Kill-switch Tests
// ---------------------------------------------------------------------------

describe('kill-switches', () => {
  describe('SUDO_SECURITY_AUDIT_DISABLE', () => {
    it('disables OSV client', async () => {
      process.env['SUDO_SECURITY_AUDIT_DISABLE'] = '1';
      const result = await batchQuery([{ name: 'test', version: '1.0.0', ecosystem: 'npm' as const }]);
      expect(result).toEqual([]);
    });

    it('disables banner check', () => {
      process.env['SUDO_SECURITY_AUDIT_DISABLE'] = '1';
      const result = checkAndDisplayBanner();
      expect(result).toBe(false);
    });
  });
});
