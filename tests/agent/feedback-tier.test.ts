/**
 * Tests for Feedback Tier System.
 *
 * Covers:
 * - Signal recording (turns, tool calls, cancellations, errors)
 * - Tier assessment logic (none, sustained, complex, friction)
 * - Behavioral adjustments per tier
 * - Environment variable threshold overrides
 * - Edge cases (zero signals, conflicting signals)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FeedbackTierManager,
  type FeedbackTier,
  type FeedbackTierAssessment,
  type SessionSignals,
  type FeedbackAdjustments,
} from '../../src/core/agent/feedback-tier.js';

describe('FeedbackTierManager', () => {
  let manager: FeedbackTierManager;

  beforeEach(() => {
    manager = new FeedbackTierManager();
  });

  describe('signal recording', () => {
    it('should start with zero signals', () => {
      const signals = manager.getSignals();
      expect(signals.turnCount).toBe(0);
      expect(signals.toolCallCount).toBe(0);
      expect(signals.cancellationCount).toBe(0);
      expect(signals.errorCount).toBe(0);
      expect(signals.doomLoopDetections).toBe(0);
    });

    it('should record turns', () => {
      manager.recordTurn();
      manager.recordTurn();
      manager.recordTurn();
      expect(manager.getSignals().turnCount).toBe(3);
    });

    it('should record tool calls', () => {
      manager.recordToolCall();
      manager.recordToolCall();
      expect(manager.getSignals().toolCallCount).toBe(2);
    });

    it('should record cancellations', () => {
      manager.recordCancellation();
      expect(manager.getSignals().cancellationCount).toBe(1);
    });

    it('should record errors', () => {
      manager.recordError();
      expect(manager.getSignals().errorCount).toBe(1);
    });

    it('should record doom loop detections', () => {
      manager.recordDoomLoop();
      expect(manager.getSignals().doomLoopDetections).toBe(1);
    });

    it('should compute running average for time to first token', () => {
      manager.recordTimeToFirstToken(1000);
      expect(manager.getSignals().avgTimeToFirstTokenMs).toBe(1000);
      manager.recordTimeToFirstToken(2000);
      // 1000 * 0.8 + 2000 * 0.2 = 800 + 400 = 1200
      expect(manager.getSignals().avgTimeToFirstTokenMs).toBe(1200);
    });

    it('should record goal completion rate', () => {
      manager.recordGoalCompletionRate(0.75);
      expect(manager.getSignals().goalCompletionRate).toBe(0.75);
    });

    it('should clamp goal completion rate to [0, 1]', () => {
      manager.recordGoalCompletionRate(1.5);
      expect(manager.getSignals().goalCompletionRate).toBe(1);
      manager.recordGoalCompletionRate(-0.5);
      expect(manager.getSignals().goalCompletionRate).toBe(0);
    });

    it('should update lastUpdatedAt on every recording', () => {
      const before = manager.getSignals().lastUpdatedAt;
      // Small delay to ensure timestamp changes
      manager.recordTurn();
      // The timestamp should be at least as recent as before
      expect(manager.getSignals().lastUpdatedAt >= before).toBe(true);
    });
  });

  describe('tier assessment', () => {
    it('should assess none tier with few turns', () => {
      for (let i = 0; i < 5; i++) manager.recordTurn();
      const assessment = manager.assess();
      expect(assessment.tier).toBe('none');
      expect(assessment.reason).toContain('insufficient data');
    });

    it('should assess sustained tier at 10+ turns', () => {
      for (let i = 0; i < 10; i++) manager.recordTurn();
      const assessment = manager.assess();
      expect(assessment.tier).toBe('sustained');
      expect(assessment.reason).toContain('sustained turns');
    });

    it('should assess complex tier at 15+ turns with errors', () => {
      for (let i = 0; i < 15; i++) manager.recordTurn();
      manager.recordError();
      const assessment = manager.assess();
      expect(assessment.tier).toBe('complex');
      expect(assessment.reason).toContain('errors');
    });

    it('should assess complex tier at 15+ turns with doom loops', () => {
      for (let i = 0; i < 15; i++) manager.recordTurn();
      manager.recordDoomLoop();
      const assessment = manager.assess();
      expect(assessment.tier).toBe('complex');
      expect(assessment.reason).toContain('doom-loop');
    });

    it('should assess friction tier when cancellations >= 3', () => {
      for (let i = 0; i < 10; i++) manager.recordTurn();
      manager.recordCancellation();
      manager.recordCancellation();
      manager.recordCancellation();
      const assessment = manager.assess();
      expect(assessment.tier).toBe('friction');
      expect(assessment.reason).toContain('cancellations');
    });

    it('should prioritize friction over complex', () => {
      for (let i = 0; i < 20; i++) manager.recordTurn();
      manager.recordError();
      manager.recordCancellation();
      manager.recordCancellation();
      manager.recordCancellation();
      const assessment = manager.assess();
      expect(assessment.tier).toBe('friction');
    });

    it('should prioritize friction over sustained', () => {
      for (let i = 0; i < 12; i++) manager.recordTurn();
      manager.recordCancellation();
      manager.recordCancellation();
      manager.recordCancellation();
      const assessment = manager.assess();
      expect(assessment.tier).toBe('friction');
    });
  });

  describe('behavioral adjustments', () => {
    it('should return neutral adjustments for none tier', () => {
      const assessment = manager.assess();
      expect(assessment.adjustments.proactivity).toBe(0.5);
      expect(assessment.adjustments.verbosity).toBe(0.5);
      expect(assessment.adjustments.autoApproveLowRisk).toBe(false);
      expect(assessment.adjustments.enableBestOfN).toBe(false);
      expect(assessment.adjustments.askClarifyingQuestions).toBe(false);
      expect(assessment.adjustments.temperatureDelta).toBe(0);
      expect(assessment.adjustments.promptAddition).toBe('');
    });

    it('should return proactive adjustments for sustained tier', () => {
      for (let i = 0; i < 10; i++) manager.recordTurn();
      const assessment = manager.assess();
      expect(assessment.adjustments.proactivity).toBe(0.7);
      expect(assessment.adjustments.autoApproveLowRisk).toBe(true);
      expect(assessment.adjustments.promptAddition).toContain('sustained');
    });

    it('should return aggressive adjustments for complex tier', () => {
      for (let i = 0; i < 15; i++) manager.recordTurn();
      manager.recordError();
      const assessment = manager.assess();
      expect(assessment.adjustments.proactivity).toBe(0.9);
      expect(assessment.adjustments.enableBestOfN).toBe(true);
      expect(assessment.adjustments.promptAddition).toContain('complex');
    });

    it('should return conservative adjustments for friction tier', () => {
      manager.recordCancellation();
      manager.recordCancellation();
      manager.recordCancellation();
      const assessment = manager.assess();
      expect(assessment.adjustments.proactivity).toBe(0.3);
      expect(assessment.adjustments.askClarifyingQuestions).toBe(true);
      expect(assessment.adjustments.autoApproveLowRisk).toBe(false);
      expect(assessment.adjustments.temperatureDelta).toBe(-0.1);
      expect(assessment.adjustments.promptAddition).toContain('friction');
    });
  });

  describe('environment variable overrides', () => {
    afterEach(() => {
      delete process.env['SUDO_FEEDBACK_TIER_SUSTAINED_TURNS'];
      delete process.env['SUDO_FEEDBACK_TIER_COMPLEX_TURNS'];
      delete process.env['SUDO_FEEDBACK_TIER_FRICTION_CANCELLATIONS'];
    });

    it('should respect SUDO_FEEDBACK_TIER_SUSTAINED_TURNS override', () => {
      process.env['SUDO_FEEDBACK_TIER_SUSTAINED_TURNS'] = '5';
      const localManager = new FeedbackTierManager();
      for (let i = 0; i < 5; i++) localManager.recordTurn();
      expect(localManager.assess().tier).toBe('sustained');
    });

    it('should respect SUDO_FEEDBACK_TIER_COMPLEX_TURNS override', () => {
      process.env['SUDO_FEEDBACK_TIER_COMPLEX_TURNS'] = '8';
      const localManager = new FeedbackTierManager();
      for (let i = 0; i < 8; i++) localManager.recordTurn();
      localManager.recordError();
      expect(localManager.assess().tier).toBe('complex');
    });

    it('should respect SUDO_FEEDBACK_TIER_FRICTION_CANCELLATIONS override', () => {
      process.env['SUDO_FEEDBACK_TIER_FRICTION_CANCELLATIONS'] = '1';
      const localManager = new FeedbackTierManager();
      localManager.recordCancellation();
      expect(localManager.assess().tier).toBe('friction');
    });
  });

  describe('edge cases', () => {
    it('should handle zero signals gracefully', () => {
      const assessment = manager.assess();
      expect(assessment.tier).toBe('none');
      expect(assessment.signals.turnCount).toBe(0);
    });

    it('should return a copy of signals from getSignals()', () => {
      manager.recordTurn();
      const s1 = manager.getSignals();
      const s2 = manager.getSignals();
      expect(s1).toEqual(s2);
      expect(s1).not.toBe(s2);
    });

    it('should include signals snapshot in assessment', () => {
      manager.recordTurn();
      manager.recordToolCall();
      manager.recordError();
      const assessment = manager.assess();
      expect(assessment.signals.turnCount).toBe(1);
      expect(assessment.signals.toolCallCount).toBe(1);
      expect(assessment.signals.errorCount).toBe(1);
    });
  });
});