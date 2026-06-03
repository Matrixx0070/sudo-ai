/**
 * @file tool-outcome-learner.test.ts
 * @description Tests for ToolOutcomeLearner integration module.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { ToolOutcomeLearner, toolOutcomeLearner } from '../../src/core/agent/tool-outcome-learner.js';

// ---------------------------------------------------------------------------
// Mock implementations for duck-typed dependencies
// ---------------------------------------------------------------------------

class MockFailureLearner {
  public failures: Array<{ tool: string; error: string; context: string }> = [];
  public rules: Map<string, string> = new Map();

  recordFailure(tool: string, error: string, context: string) {
    this.failures.push({ tool, error, context });
    return { id: `fail-${Date.now()}`, tool, error, context };
  }

  getPreventionRule(tool: string, error: string): string | undefined {
    const key = `${tool}:${error.substring(0, 50)}`;
    return this.rules.get(key);
  }

  hasSeenBefore(tool: string, error: string): boolean {
    return this.failures.some(f => f.tool === tool && f.error.includes(error.substring(0, 30)));
  }

  getSolution(tool: string, error: string): string | undefined {
    const match = this.failures.find(f => f.tool === tool && f.error.includes(error.substring(0, 30)));
    return match ? 'Try using different parameters' : undefined;
  }
}

class MockImprovementLoop {
  public insights: Array<{ type: string; description: string; source: string }> = [];

  recordInsight(type: 'weakness' | 'strength' | 'opportunity' | 'pattern', description: string, source: string) {
    this.insights.push({ type, description, source });
    return { id: `insight-${Date.now()}`, type, description, source };
  }
}

class MockSkillDiscovery {
  public calls: Array<{ sessionId: string; toolName: string; success: boolean }> = [];

  recordToolCall(sessionId: string, toolName: string, success: boolean) {
    this.calls.push({ sessionId, toolName, success });
  }
}

class MockAgentConfigEvolver {
  public traces: Array<{ sessionId: string; agentId: string; toolSequence: string[]; quality: number }> = [];

  recordTrace(trace: { sessionId: string; agentId: string; toolSequence: string[]; quality: number }) {
    this.traces.push(trace);
  }
}

class MockTrustTierTracker {
  public outcomes: Array<{ timestamp: number; kind: string }> = [];

  recordOutcome(outcome: { timestamp: number; kind: string }) {
    this.outcomes.push(outcome);
  }
}

class MockConfidenceCalibrationTracker {
  public entries: Array<{ predicted: number; outcome: 0 | 1; tag?: string }> = [];

  record(predicted: number, outcome: 0 | 1, tag?: string) {
    this.entries.push({ predicted, outcome, tag });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolOutcomeLearner', () => {
  let mockFailureLearner: MockFailureLearner;
  let mockImprovementLoop: MockImprovementLoop;
  let mockSkillDiscovery: MockSkillDiscovery;
  let mockAgentConfigEvolver: MockAgentConfigEvolver;
  let mockTrustTierTracker: MockTrustTierTracker;
  let mockConfidenceCalibrationTracker: MockConfidenceCalibrationTracker;

  beforeEach(() => {
    mockFailureLearner = new MockFailureLearner();
    mockImprovementLoop = new MockImprovementLoop();
    mockSkillDiscovery = new MockSkillDiscovery();
    mockAgentConfigEvolver = new MockAgentConfigEvolver();
    mockTrustTierTracker = new MockTrustTierTracker();
    mockConfidenceCalibrationTracker = new MockConfidenceCalibrationTracker();
  });

  afterEach(() => {
    // Clean up env var after each test
    delete process.env['SUDO_TOOL_LEARNING_DISABLE'];
  });

  it('records failure in FailureLearner when tool fails', () => {
    const learner = new ToolOutcomeLearner({
      failureLearner: mockFailureLearner,
    });

    learner.onToolResult('fs.read', { path: '/test.txt' }, false, 'ENOENT: no such file', 'session-1');

    expect(mockFailureLearner.failures).toHaveLength(1);
    expect(mockFailureLearner.failures[0].tool).toBe('fs.read');
    expect(mockFailureLearner.failures[0].error).toBe('ENOENT: no such file');
  });

  it('records action in ImprovementLoop for both success and failure', () => {
    const learner = new ToolOutcomeLearner({
      improvementLoop: mockImprovementLoop,
    });

    learner.onToolResult('fs.read', { path: '/test.txt' }, true, undefined, 'session-1');
    learner.onToolResult('fs.write', { path: '/test.txt' }, false, 'EACCES: permission denied', 'session-1');

    expect(mockImprovementLoop.insights).toHaveLength(2);
    expect(mockImprovementLoop.insights[0].type).toBe('strength');
    expect(mockImprovementLoop.insights[1].type).toBe('weakness');
    expect(mockImprovementLoop.insights[0].description).toContain('fs.read');
    expect(mockImprovementLoop.insights[1].description).toContain('fs.write');
  });

  it('returns hint from checkPreventionRules when pattern exists', () => {
    mockFailureLearner.rules.set('fs.read:ENOENT: no such file', 'Check if file exists before reading');

    const learner = new ToolOutcomeLearner({
      failureLearner: mockFailureLearner,
    });

    const hint = learner.checkPreventionRulesForError('fs.read', 'ENOENT: no such file');

    expect(hint).toBeTruthy();
    expect(hint).toContain('Prevention rule');
    expect(hint).toContain('Check if file exists');
  });

  it('returns null from checkPreventionRules when no patterns exist', () => {
    const learner = new ToolOutcomeLearner({
      failureLearner: mockFailureLearner,
    });

    const hint = learner.checkPreventionRulesForError('fs.read', 'ENOENT: no such file');

    expect(hint).toBeNull();
  });

  it('disables all learning when SUDO_TOOL_LEARNING_DISABLE=1', () => {
    process.env['SUDO_TOOL_LEARNING_DISABLE'] = '1';

    const learner = new ToolOutcomeLearner({
      failureLearner: mockFailureLearner,
      improvementLoop: mockImprovementLoop,
      skillDiscovery: mockSkillDiscovery,
      agentConfigEvolver: mockAgentConfigEvolver,
      trustTierTracker: mockTrustTierTracker,
      confidenceCalibrationTracker: mockConfidenceCalibrationTracker,
    });

    learner.onToolResult('fs.read', { path: '/test.txt' }, false, 'ENOENT', 'session-1');

    expect(mockFailureLearner.failures).toHaveLength(0);
    expect(mockImprovementLoop.insights).toHaveLength(0);
    expect(mockSkillDiscovery.calls).toHaveLength(0);
    expect(mockAgentConfigEvolver.traces).toHaveLength(0);
  });

  it('feeds outcomes to TrustTierTracker on session end', () => {
    const learner = new ToolOutcomeLearner({
      trustTierTracker: mockTrustTierTracker,
    });

    const outcomes = [
      { toolName: 'fs.read', success: true },
      { toolName: 'fs.write', success: false },
      { toolName: 'net.fetch', success: true },
    ];

    learner.onSessionEnd('session-1', outcomes);

    expect(mockTrustTierTracker.outcomes).toHaveLength(3);
    expect(mockTrustTierTracker.outcomes[0].kind).toBe('success');
    expect(mockTrustTierTracker.outcomes[1].kind).toBe('failure');
    expect(mockTrustTierTracker.outcomes[2].kind).toBe('success');
  });

  it('feeds predictions vs outcomes to ConfidenceCalibrationTracker on session end', () => {
    const learner = new ToolOutcomeLearner({
      confidenceCalibrationTracker: mockConfidenceCalibrationTracker,
    });

    const outcomes = [
      { toolName: 'fs.read', success: true, predictedConfidence: 0.9, epistemicTag: 'CERTAIN' },
      { toolName: 'fs.write', success: false, predictedConfidence: 0.4, epistemicTag: 'CONJECTURE' },
    ];

    learner.onSessionEnd('session-1', outcomes);

    expect(mockConfidenceCalibrationTracker.entries).toHaveLength(2);
    expect(mockConfidenceCalibrationTracker.entries[0].predicted).toBe(0.9);
    expect(mockConfidenceCalibrationTracker.entries[0].outcome).toBe(1);
    expect(mockConfidenceCalibrationTracker.entries[0].tag).toBe('CERTAIN');
    expect(mockConfidenceCalibrationTracker.entries[1].predicted).toBe(0.4);
    expect(mockConfidenceCalibrationTracker.entries[1].outcome).toBe(0);
  });

  it('records to SkillDiscovery when tool succeeds', () => {
    const learner = new ToolOutcomeLearner({
      skillDiscovery: mockSkillDiscovery,
    });

    learner.onToolResult('fs.read', { path: '/test.txt' }, true, undefined, 'session-1');

    expect(mockSkillDiscovery.calls).toHaveLength(1);
    expect(mockSkillDiscovery.calls[0].toolName).toBe('fs.read');
    expect(mockSkillDiscovery.calls[0].success).toBe(true);
  });

  it('records to AgentConfigEvolver when tool executes', () => {
    const learner = new ToolOutcomeLearner({
      agentConfigEvolver: mockAgentConfigEvolver,
    });

    learner.onToolResult('fs.read', { path: '/test.txt' }, true, undefined, 'session-1');

    expect(mockAgentConfigEvolver.traces).toHaveLength(1);
    expect(mockAgentConfigEvolver.traces[0].sessionId).toBe('session-1');
    expect(mockAgentConfigEvolver.traces[0].toolSequence).toEqual(['fs.read']);
    expect(mockAgentConfigEvolver.traces[0].quality).toBe(1);
  });

  it('records failure outcome to TrustTierTracker', () => {
    const learner = new ToolOutcomeLearner({
      trustTierTracker: mockTrustTierTracker,
    });

    learner.onToolResult('fs.read', { path: '/test.txt' }, false, 'ENOENT', 'session-1');

    expect(mockTrustTierTracker.outcomes).toHaveLength(1);
    expect(mockTrustTierTracker.outcomes[0].kind).toBe('failure');
  });

  it('records calibration entry for tool outcome with predicted confidence', () => {
    const learner = new ToolOutcomeLearner({
      confidenceCalibrationTracker: mockConfidenceCalibrationTracker,
    });

    learner.onToolResult('fs.read', { path: '/test.txt' }, true, undefined, 'session-1', 0.8, 'CERTAIN');

    expect(mockConfidenceCalibrationTracker.entries).toHaveLength(1);
    expect(mockConfidenceCalibrationTracker.entries[0].predicted).toBe(0.8);
    expect(mockConfidenceCalibrationTracker.entries[0].outcome).toBe(1);
    expect(mockConfidenceCalibrationTracker.entries[0].tag).toBe('CERTAIN');
  });

  it('singleton export exists', () => {
    expect(toolOutcomeLearner).toBeDefined();
    expect(toolOutcomeLearner).toBeInstanceOf(ToolOutcomeLearner);
  });

  it('handles missing dependencies gracefully (fail-open)', () => {
    const learner = new ToolOutcomeLearner({});

    // Should not throw
    expect(() => {
      learner.onToolResult('fs.read', { path: '/test.txt' }, false, 'ENOENT', 'session-1');
      learner.onSessionEnd('session-1', [{ toolName: 'fs.read', success: false }]);
      learner.checkPreventionRulesForError('fs.read', 'ENOENT');
    }).not.toThrow();
  });

  it('checkPreventionRules returns null when learning disabled', () => {
    process.env['SUDO_TOOL_LEARNING_DISABLE'] = '1';

    const learner = new ToolOutcomeLearner({
      failureLearner: mockFailureLearner,
    });

    mockFailureLearner.rules.set('fs.read:ENOENT', 'Check file exists');
    const hint = learner.checkPreventionRulesForError('fs.read', 'ENOENT');

    expect(hint).toBeNull();
  });

  it('onSessionEnd does nothing when learning disabled', () => {
    process.env['SUDO_TOOL_LEARNING_DISABLE'] = '1';

    const learner = new ToolOutcomeLearner({
      trustTierTracker: mockTrustTierTracker,
      confidenceCalibrationTracker: mockConfidenceCalibrationTracker,
    });

    learner.onSessionEnd('session-1', [
      { toolName: 'fs.read', success: true, predictedConfidence: 0.9 },
    ]);

    expect(mockTrustTierTracker.outcomes).toHaveLength(0);
    expect(mockConfidenceCalibrationTracker.entries).toHaveLength(0);
  });
});
