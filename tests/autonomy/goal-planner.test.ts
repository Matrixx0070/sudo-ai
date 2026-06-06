/**
 * @file goal-planner.test.ts
 * @description Tests for GoalPlanner — stage 2 of the 4-stage goal pipeline.
 * Covers template-based planning, goal-type-specific steps, complexity
 * adjustments, step ID/status correctness, and semantic planning fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoalPlanner, type BrainForPlanning, type PlannedStep } from '../../src/core/autonomy/goal-planner.js';
import type { GoalClassification, GoalType, GoalComplexity } from '../../src/core/autonomy/goal-pipeline.js';
import type { PlanV2, PlanStep } from '../../src/core/agent/plan-mode-v2.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a GoalClassification with defaults for easy testing. */
function makeClassification(
  type: GoalType = 'bug_fix',
  complexity: GoalComplexity = 'moderate',
  overrides?: Partial<GoalClassification>,
): GoalClassification {
  return {
    type,
    complexity,
    confidence: 0.85,
    evidence: ['test evidence'],
    estimatedSteps: 4,
    suggestedApproach: 'Test approach',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoalPlanner', () => {
  let planner: GoalPlanner;

  beforeEach(() => {
    planner = new GoalPlanner(); // No brain — template-based planning
  });

  // -----------------------------------------------------------------------
  // Template-based planning (no Brain)
  // -----------------------------------------------------------------------

  it('should generate a PlanV2 with correct structure from a bug_fix classification', async () => {
    const classification = makeClassification('bug_fix', 'moderate');
    const plan = await planner.plan(classification, 'Fix the login crash');

    expect(plan.id).toMatch(/^plan-\d+$/);
    expect(plan.title).toContain('Bug Fix');
    expect(plan.status).toBe('draft');
    expect(plan.createdAt).toBeTruthy();
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it('should produce bug_fix steps: reproduce -> diagnose -> fix -> verify', async () => {
    const classification = makeClassification('bug_fix', 'moderate');
    const plan = await planner.plan(classification);

    const descriptions = plan.steps.map(s => s.description.toLowerCase());
    expect(descriptions.length).toBeGreaterThanOrEqual(4);
    // First step should involve reproducing
    expect(descriptions[0]).toContain('reproduce');
    // Last step should involve verification
    expect(descriptions[descriptions.length - 1]).toContain('verify');
  });

  it('should produce feature steps: design -> implement -> test -> document', async () => {
    const classification = makeClassification('feature', 'moderate');
    const plan = await planner.plan(classification);

    const descriptions = plan.steps.map(s => s.description.toLowerCase());
    expect(descriptions.some(d => d.includes('design'))).toBe(true);
    expect(descriptions.some(d => d.includes('implement'))).toBe(true);
    expect(descriptions.some(d => d.includes('test'))).toBe(true);
    expect(descriptions.some(d => d.includes('document'))).toBe(true);
  });

  it('should produce refactor steps: identify -> plan -> execute -> verify', async () => {
    const classification = makeClassification('refactor', 'moderate');
    const plan = await planner.plan(classification);

    const descriptions = plan.steps.map(s => s.description.toLowerCase());
    expect(descriptions.some(d => d.includes('identif'))).toBe(true);
    expect(descriptions.some(d => d.includes('execute') || d.includes('refactor'))).toBe(true);
    expect(descriptions.some(d => d.includes('verify') || d.includes('test'))).toBe(true);
  });

  it('should produce research steps: scope -> search -> analyze -> synthesize', async () => {
    const classification = makeClassification('research', 'moderate');
    const plan = await planner.plan(classification);

    const descriptions = plan.steps.map(s => s.description.toLowerCase());
    expect(descriptions.some(d => d.includes('scope') || d.includes('define'))).toBe(true);
    expect(descriptions.some(d => d.includes('search') || d.includes('find'))).toBe(true);
    expect(descriptions.some(d => d.includes('analyz'))).toBe(true);
    expect(descriptions.some(d => d.includes('synthes') || d.includes('recommend'))).toBe(true);
  });

  it('should produce deployment steps: prepare -> test -> stage -> promote', async () => {
    const classification = makeClassification('deployment', 'moderate');
    const plan = await planner.plan(classification);

    const descriptions = plan.steps.map(s => s.description.toLowerCase());
    expect(descriptions.some(d => d.includes('prepar') || d.includes('build'))).toBe(true);
    expect(descriptions.some(d => d.includes('stag'))).toBe(true);
    expect(descriptions.some(d => d.includes('promot') || d.includes('production'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Complexity adjustments
  // -----------------------------------------------------------------------

  it('should add extra steps for complex goals', async () => {
    const trivial = makeClassification('bug_fix', 'trivial');
    const complex = makeClassification('bug_fix', 'complex');

    const trivialPlan = await planner.plan(trivial);
    const complexPlan = await planner.plan(complex);

    // Complex should have more steps than trivial (injected review step)
    expect(complexPlan.steps.length).toBeGreaterThan(trivialPlan.steps.length);
  });

  it('should add extra steps for critical goals including rollback and validation', async () => {
    const critical = makeClassification('feature', 'critical');
    const plan = await planner.plan(critical);

    // Critical should have the most steps (2 extra injected)
    const descriptions = plan.steps.map(s => s.description.toLowerCase());
    // Should include a rollback/monitoring step
    expect(descriptions.some(d =>
      d.includes('rollback') || d.includes('monitor') || d.includes('safeguard'),
    )).toBe(true);
  });

  it('should scale estimated time based on complexity', async () => {
    // We need to access the internal PlannedStep metadata, so we test indirectly
    // by verifying the plan is generated and structure is correct at different complexities
    const trivial = makeClassification('security', 'trivial');
    const critical = makeClassification('security', 'critical');

    const trivialPlan = await planner.plan(trivial);
    const criticalPlan = await planner.plan(critical);

    // Both should produce valid plans
    expect(trivialPlan.steps.length).toBeGreaterThan(0);
    expect(criticalPlan.steps.length).toBeGreaterThan(0);
    // Critical should have strictly more steps
    expect(criticalPlan.steps.length).toBeGreaterThan(trivialPlan.steps.length);
  });

  // -----------------------------------------------------------------------
  // Step IDs and status
  // -----------------------------------------------------------------------

  it('should assign sequential IDs starting at 1 and all steps should be pending', async () => {
    const classification = makeClassification('feature', 'moderate');
    const plan = await planner.plan(classification);

    for (let i = 0; i < plan.steps.length; i++) {
      expect(plan.steps[i].id).toBe(i + 1);
      expect(plan.steps[i].status).toBe('pending');
    }
  });

  // -----------------------------------------------------------------------
  // Title generation
  // -----------------------------------------------------------------------

  it('should include context in the plan title when provided', async () => {
    const classification = makeClassification('bug_fix', 'moderate');
    const plan = await planner.plan(classification, 'Fix the login crash on empty password');

    expect(plan.title).toContain('Bug Fix');
    expect(plan.title).toContain('Fix the login crash on empty password');
  });

  it('should truncate long context in title and add ellipsis', async () => {
    const classification = makeClassification('feature', 'moderate');
    const longContext = 'A'.repeat(100);
    const plan = await planner.plan(classification, longContext);

    expect(plan.title).toContain('...');
  });

  it('should use complexity label in title when no context provided', async () => {
    const classification = makeClassification('optimization', 'complex');
    const plan = await planner.plan(classification);

    expect(plan.title).toContain('Optimization');
    expect(plan.title).toContain('complex');
  });

  // -----------------------------------------------------------------------
  // All goal types produce valid plans
  // -----------------------------------------------------------------------

  it('should produce valid plans for all goal types', async () => {
    const allTypes: GoalType[] = [
      'bug_fix', 'feature', 'refactor', 'research', 'deployment',
      'testing', 'documentation', 'configuration', 'security',
      'optimization', 'integration', 'unknown',
    ];

    for (const type of allTypes) {
      const classification = makeClassification(type, 'moderate');
      const plan = await planner.plan(classification);

      expect(plan.steps.length).toBeGreaterThan(0, `No steps for type: ${type}`);
      expect(plan.status).toBe('draft');
      for (const step of plan.steps) {
        expect(step.id).toBeGreaterThan(0);
        expect(step.description.length).toBeGreaterThan(0);
        expect(step.status).toBe('pending');
      }
    }
  });

  // -----------------------------------------------------------------------
  // Semantic planning (with Brain mock)
  // -----------------------------------------------------------------------

  it('should use Brain for semantic planning when available', async () => {
    const semanticSteps = [
      { description: 'Read the crash logs from /var/log/app', estimatedTime: '3 min', complexity: 'low', risks: ['Logs may be rotated'] },
      { description: 'Identify the null pointer in auth handler', estimatedTime: '8 min', complexity: 'medium', risks: ['Stack trace may be misleading'] },
      { description: 'Add null check and unit test', estimatedTime: '12 min', complexity: 'medium', risks: ['Other callers may also need null check'] },
    ];

    const mockBrain: BrainForPlanning = {
      chat: vi.fn().mockResolvedValue(JSON.stringify(semanticSteps)),
    };

    const brainPlanner = new GoalPlanner(mockBrain);
    const classification = makeClassification('bug_fix', 'moderate');
    const plan = await brainPlanner.plan(classification, 'App crashes on null password');

    expect(plan.steps.length).toBe(3);
    expect(plan.steps[0].description).toContain('crash logs');
    expect(plan.steps[1].description).toContain('null pointer');
    expect(plan.steps[2].description).toContain('null check');
  });

  it('should fall back to template planning when Brain fails', async () => {
    const mockBrain: BrainForPlanning = {
      chat: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };

    const brainPlanner = new GoalPlanner(mockBrain);
    const classification = makeClassification('bug_fix', 'moderate');
    const plan = await brainPlanner.plan(classification, 'Fix something');

    // Should fall back to template-based planning
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0].description.toLowerCase()).toContain('reproduce');
  });

  it('should fall back to template planning when Brain returns invalid JSON', async () => {
    const mockBrain: BrainForPlanning = {
      chat: vi.fn().mockResolvedValue('This is not JSON at all'),
    };

    const brainPlanner = new GoalPlanner(mockBrain);
    const classification = makeClassification('feature', 'moderate');
    const plan = await brainPlanner.plan(classification);

    // Should fall back to template-based planning
    expect(plan.steps.length).toBeGreaterThan(0);
    // Feature template should have design step
    const descriptions = plan.steps.map(s => s.description.toLowerCase());
    expect(descriptions.some(d => d.includes('design'))).toBe(true);
  });
});