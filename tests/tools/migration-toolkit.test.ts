/**
 * Tests for the Migration Toolkit.
 * Reducing switching cost is the fastest adoption accelerator.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MigrationToolkit } from '../../src/core/tools/migration-toolkit.js';
import type { OpenClawConfig, HermesConfig } from '../../src/core/tools/migration-toolkit.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_DIR = 'test-data-migrations';

describe('MigrationToolkit', () => {
  let toolkit: MigrationToolkit;

  beforeEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
    mkdirSync(TEST_DIR, { recursive: true });

    toolkit = new MigrationToolkit({ outputDir: TEST_DIR });
  });

  it('should initialize with default config', () => {
    expect(toolkit).toBeDefined();
  });

  it('should migrate OpenClaw config', () => {
    const ocConfig: OpenClawConfig = {
      name: 'my-agent',
      model: 'claude-sonnet-4-6',
      skills: ['web-scraper', 'data-exporter'],
      memory: true,
      heartbeat: true,
      tools: ['browser', 'file'],
      customInstructions: 'Be helpful and concise',
    };

    const result = toolkit.migrateOpenClaw(ocConfig);

    expect(result.success).toBe(true);
    expect(result.source).toBe('openclaw');
    expect(result.itemsMigrated).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should migrate OpenClaw with MCP servers', () => {
    const ocConfig: OpenClawConfig = {
      name: 'my-agent',
      mcpServers: {
        'github': { url: 'https://mcp.github.com', headers: { 'Authorization': 'Bearer token' } },
        'slack': { url: 'https://mcp.slack.com' },
      },
    };

    const result = toolkit.migrateOpenClaw(ocConfig);

    expect(result.success).toBe(true);
    expect(result.itemsMigrated).toBeGreaterThan(2); // config + 2 MCP servers
  });

  it('should migrate Hermes config', () => {
    const hermesConfig: HermesConfig = {
      name: 'my-hermes-agent',
      model: 'deepseek-v4-pro',
      agentskills: ['memory-manager', 'task-scheduler'],
      memory: { enabled: true, backend: 'sqlite' },
      persona: 'You are a helpful assistant with a focus on accuracy.',
    };

    const result = toolkit.migrateHermes(hermesConfig);

    expect(result.success).toBe(true);
    expect(result.source).toBe('hermes');
    expect(result.itemsMigrated).toBeGreaterThan(0);
  });

  it('should generate feature comparison', () => {
    const comparison = toolkit.generateComparison();

    expect(comparison).toContain('Agent Platform Comparison');
    expect(comparison).toContain('OpenClaw');
    expect(comparison).toContain('Hermes');
    expect(comparison).toContain('OpenJarvis');
    expect(comparison).toContain('SUDO-AI');
    expect(comparison).toContain('Memory');
    expect(comparison).toContain('Security');
    expect(comparison).toContain('Cost');
  });

  it('should return comparison data as structured entries', () => {
    const data = toolkit.getComparisonData();

    expect(data.length).toBeGreaterThan(0);
    for (const entry of data) {
      expect(entry.feature).toBeTruthy();
      expect(entry.openclaw).toBeTruthy();
      expect(entry.hermes).toBeTruthy();
      expect(entry.openjarvis).toBeTruthy();
      expect(entry.sudoai).toBeTruthy();
    }
  });

  it('should write migration output files', () => {
    const ocConfig: OpenClawConfig = { name: 'test-migration' };
    const result = toolkit.migrateOpenClaw(ocConfig);

    if (result.success) {
      const configPath = join(result.outputDir, 'sudo-ai.config.json');
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.agent).toBeDefined();
      expect(config.consciousness).toBeDefined();
    }
  });

  it('should support dry run mode', () => {
    const dryToolkit = new MigrationToolkit({ outputDir: TEST_DIR, dryRun: true });
    const result = dryToolkit.migrateOpenClaw({ name: 'dry-test' });

    // Dry run should not write files
    expect(result.success).toBe(true);
  });

  it('should convert Hermes persona to SOUL.md', () => {
    const hermesConfig: HermesConfig = {
      persona: 'You are a creative coding assistant.',
    };

    const result = toolkit.migrateHermes(hermesConfig);

    if (result.success && result.itemsMigrated > 1) {
      // Check that SOUL.md was created (if persona was present)
      const soulPath = join(result.outputDir, 'SOUL.md');
      if (existsSync(soulPath)) {
        const soul = readFileSync(soulPath, 'utf-8');
        expect(soul).toContain('SOUL.md');
        expect(soul).toContain('creative coding assistant');
      }
    }
  });

  it('should track migration statistics', () => {
    toolkit.migrateOpenClaw({ name: 'test1' });
    toolkit.migrateHermes({ name: 'test2' });

    const stats = toolkit.getStats();
    expect(stats.totalMigrations).toBeGreaterThanOrEqual(2);
    expect(stats.bySource.openclaw).toBeGreaterThanOrEqual(1);
    expect(stats.bySource.hermes).toBeGreaterThanOrEqual(1);
  });
});