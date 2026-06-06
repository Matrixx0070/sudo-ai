/**
 * Tests for the HEARTBEAT Morning Briefing System.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HeartbeatEngine } from '../../src/core/consciousness/heartbeat.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_DIR = 'test-workspace-heartbeat';

describe('HeartbeatEngine', () => {
  let engine: HeartbeatEngine;

  beforeEach(() => {
    // Clean test dir
    try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
    mkdirSync(TEST_DIR, { recursive: true });

    engine = new HeartbeatEngine({
      enabled: true,
      workspaceDir: TEST_DIR,
      schedule: '0 7 * * *',
      pushToChannels: [],
      includeCostData: true,
      maxHealthObservations: 5,
      maxMemoryHighlights: 5,
    });
  });

  it('should initialize with default config', () => {
    const e = new HeartbeatEngine({ workspaceDir: TEST_DIR });
    expect(e).toBeDefined();
    const stats = e.getStats();
    expect(stats.totalBriefings).toBe(0);
  });

  it('should generate a morning briefing', async () => {
    const briefing = await engine.generateBriefing('TestAgent');

    expect(briefing).toBeDefined();
    expect(briefing.agentName).toBe('TestAgent');
    expect(briefing.date).toBeDefined();
    expect(briefing.generatedAt).toBeDefined();
    expect(briefing.greeting).toBeTruthy();
    expect(briefing.quote).toBeTruthy();
    expect(briefing.calendar).toBeInstanceOf(Array);
    expect(briefing.tasks).toBeInstanceOf(Array);
    expect(briefing.health).toBeInstanceOf(Array);
    expect(briefing.memory).toBeInstanceOf(Array);
    expect(briefing.goals).toBeInstanceOf(Array);
    expect(briefing.cost).toBeDefined();
    expect(briefing.skills).toBeDefined();
  });

  it('should write HEARTBEAT.md to workspace', async () => {
    await engine.generateBriefing('TestAgent');

    const heartbeatPath = join(TEST_DIR, 'HEARTBEAT.md');
    expect(existsSync(heartbeatPath)).toBe(true);

    const content = readFileSync(heartbeatPath, 'utf-8');
    expect(content).toContain('HEARTBEAT');
    expect(content).toContain('TestAgent');
    expect(content).toContain('System Health');
    expect(content).toContain('Skills');
  });

  it('should include cost data when configured', async () => {
    const briefing = await engine.generateBriefing('TestAgent');
    expect(briefing.cost).toBeDefined();
    expect(typeof briefing.cost.tokensUsedToday).toBe('number');
    expect(typeof briefing.cost.estimatedCostToday).toBe('number');
  });

  it('should read current briefing', async () => {
    // No briefing yet
    expect(engine.readCurrentBriefing()).toBeNull();

    // Generate one
    await engine.generateBriefing('TestAgent');
    const content = engine.readCurrentBriefing();
    expect(content).toBeTruthy();
    expect(content).toContain('HEARTBEAT');
  });

  it('should track briefing count in stats', async () => {
    await engine.generateBriefing('TestAgent');
    await engine.generateBriefing('TestAgent');

    const stats = engine.getStats();
    expect(stats.totalBriefings).toBe(2);
    expect(stats.lastGenerated).toBeTruthy();
  });

  it('should generate progress bars for goals', async () => {
    // This tests the private _renderProgressBar indirectly through the markdown
    const briefing = await engine.generateBriefing('TestAgent');
    if (briefing.goals.length > 0) {
      const content = readFileSync(join(TEST_DIR, 'HEARTBEAT.md'), 'utf-8');
      // Progress bar contains block characters
      expect(content).toMatch(/█|░/);
    }
  });

  it('should handle missing workspace gracefully', async () => {
    const brokenEngine = new HeartbeatEngine({ workspaceDir: '/nonexistent/path/that/should/not/exist' });
    // Should not throw — logs warning instead
    const briefing = await brokenEngine.generateBriefing('TestAgent');
    expect(briefing).toBeDefined();
  });
});