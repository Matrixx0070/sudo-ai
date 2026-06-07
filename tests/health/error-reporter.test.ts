/**
 * @file error-reporter.test.ts
 * @description Tests for ErrorReporter class.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { ErrorReporter } from '../../src/core/health/error-reporter.js';
import { ErrorMemory } from '../../src/core/health/error-memory.js';
import { HookManager } from '../../src/core/hooks/index.js';
import { GitHubIssuesConnector } from '../../src/core/channels/github-issues.js';
import { MetricsCollector } from '../../src/core/health/metrics.js';

// Use an in-memory SQLite DB so each test run gets a fully isolated, ephemeral
// store. This avoids leaking error_memory / auto_fix_rate_log rows across runs
// and prevents parallel test processes from corrupting a shared on-disk file.
const TEST_DB_PATH = ':memory:';

describe('ErrorReporter', () => {
  let errorMemory: ErrorMemory;
  let hookManager: HookManager;
  let github: GitHubIssuesConnector;
  let metrics: MetricsCollector;
  let reporter: ErrorReporter;

  beforeEach(() => {
    errorMemory = new ErrorMemory(TEST_DB_PATH);
    hookManager = new HookManager();
    github = new GitHubIssuesConnector();
    metrics = new MetricsCollector();
    reporter = new ErrorReporter(errorMemory, hookManager, github, metrics);
  });

  afterEach(() => {
    reporter.destroy();
    errorMemory.close();
  });

  describe('constructor', () => {
    it('should create instance with all dependencies', () => {
      assert.ok(reporter);
      assert.strictEqual(typeof reporter.capture, 'function');
      assert.strictEqual(typeof reporter.normalizeSignature, 'function');
      assert.strictEqual(typeof reporter.classifySeverity, 'function');
      assert.strictEqual(typeof reporter.destroy, 'function');
    });
  });

  describe('initialize', () => {
    it('should subscribe to after:tool-call hook', async () => {
      await reporter.initialize();
      const hooks = hookManager.listHooks();
      const toolHook = hooks.find((h) => h.event === 'after:tool-call');
      assert.ok(toolHook, 'Should register after:tool-call hook');
    });

    it('should subscribe to session:end hook', async () => {
      await reporter.initialize();
      const hooks = hookManager.listHooks();
      const sessionHook = hooks.find((h) => h.event === 'session:end');
      assert.ok(sessionHook, 'Should register session:end hook');
    });

    it('should respect kill-switch SUDO_GITHUB_ISSUES_DISABLE', async () => {
      process.env['SUDO_GITHUB_ISSUES_DISABLE'] = '1';
      await reporter.initialize();
      const hooks = hookManager.listHooks();
      assert.strictEqual(hooks.length, 0, 'Should not register hooks when disabled');
      delete process.env['SUDO_GITHUB_ISSUES_DISABLE'];
    });
  });

  describe('normalizeSignature', () => {
    it('should normalize error signature by removing volatile tokens', () => {
      const error1 = new Error('Connection failed at 192.168.1.1:3000');
      const error2 = new Error('Connection failed at 10.0.0.5:8080');

      const sig1 = reporter.normalizeSignature(error1);
      const sig2 = reporter.normalizeSignature(error2);

      assert.strictEqual(sig1, sig2, 'Should produce same signature for similar errors');
      assert.ok(sig1.includes('connection_failed'), 'Should keep core message');
      assert.ok(!sig1.includes('192.168'), 'Should remove IP addresses');
      assert.ok(!sig1.includes('3000'), 'Should remove port numbers');
    });

    it('should handle UUIDs and timestamps', () => {
      const error1 = new Error('Session abc12345-6789-abcd-ef01-234567890abc expired at 2026-05-31T12:00:00Z');
      const error2 = new Error('Session xyz98765-4321-dcba-1098-76543210fedc expired at 2026-06-01T08:30:00Z');

      const sig1 = reporter.normalizeSignature(error1);
      const sig2 = reporter.normalizeSignature(error2);

      assert.strictEqual(sig1, sig2, 'Should normalize UUIDs and timestamps');
    });
  });

  describe('classifySeverity', () => {
    it('should classify CRITICAL for crash/unhandled errors', () => {
      const crashError = new Error('Unhandled crash in module');
      const severity = reporter.classifySeverity(crashError, {});
      assert.strictEqual(severity, 'CRITICAL');
    });

    it('should classify HIGH for tool failures', () => {
      const toolError = new Error('Tool execution failed');
      const severity = reporter.classifySeverity(toolError, { toolName: 'fs.write' });
      assert.strictEqual(severity, 'HIGH');
    });

    it('should classify MEDIUM for health degradation', () => {
      const healthError = new Error('Health check degraded');
      const severity = reporter.classifySeverity(healthError, { healthCheck: 'disk_space' });
      assert.strictEqual(severity, 'MEDIUM');
    });

    it('should classify LOW for cosmetic errors', () => {
      const cosmeticError = new Error('Minor UI glitch');
      const severity = reporter.classifySeverity(cosmeticError, {});
      assert.strictEqual(severity, 'LOW');
    });
  });

  describe('capture', () => {
    it('should respect kill-switch and return early', async () => {
      process.env['SUDO_GITHUB_ISSUES_DISABLE'] = '1';
      const error = new Error('Test error');
      await reporter.capture(error, 'HIGH', {});
      delete process.env['SUDO_GITHUB_ISSUES_DISABLE'];
    });

    it('should not capture after destroy()', async () => {
      reporter.destroy();
      const error = new Error('Test error');
      await reporter.capture(error, 'HIGH', {});
    });
  });

  describe('destroy', () => {
    it('should unregister all hooks', async () => {
      await reporter.initialize();
      const beforeCount = hookManager.size;
      assert.ok(beforeCount > 0, 'Should have registered hooks');

      reporter.destroy();
      const afterCount = hookManager.size;
      assert.strictEqual(afterCount, 0, 'Should have no hooks after destroy');
    });

    it('should be idempotent', () => {
      reporter.destroy();
      reporter.destroy();
    });
  });
});
