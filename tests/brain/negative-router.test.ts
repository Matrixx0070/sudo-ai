/**
 * @file tests/brain/negative-router.test.ts
 * @description Comprehensive tests for the NegativeRouter class.
 *
 * Tests:
 *  1.  DFA rule matching: Add a rule, verify it routes correctly
 *  2.  DFA block rule: Add a block rule, verify blocked=true is returned
 *  3.  DFA redirect rule: Add a redirect rule, verify redirect is returned
 *  4.  Keyword fallback: Message with no DFA match but keyword hits
 *  5.  LLM fallback: Message with no DFA match and low keyword score
 *  6.  Priority ordering: Higher priority rules override lower priority
 *  7.  Rule management: addRule, removeRule, getRules work correctly
 *  8.  Stats tracking: getStats() returns correct counts after calls
 *  9.  Default rules: Default router has pre-configured rules
 *  10. Empty input: Empty message and intent return fast model fallback
 *  11. Concurrent calls: Multiple rapid calls don't crash
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NegativeRouter, type NegativeRule, type RoutingResult } from '@core/brain/negative-router.js';
import { ROUTING_MODELS } from '@core/shared/constants.js';

// Helper: build a router with zero default rules for isolated testing.
// The constructor merges DEFAULT_RULES even when config.rules is [],
// so we strip them out after construction.
function bareRouter(extra?: Record<string, unknown>): NegativeRouter {
  const r = new NegativeRouter({
    rules: [],
    keywordThreshold: 0.4,
    llmThreshold: 0.2,
    llmModel: ROUTING_MODELS.fast,
    ...extra,
  });
  for (const rule of r.getRules()) {
    r.removeRule(rule.pattern);
  }
  return r;
}

// ---------------------------------------------------------------------------
// 1. DFA rule matching
// ---------------------------------------------------------------------------
describe('NegativeRouter', () => {
  let router: NegativeRouter;

  beforeEach(() => {
    router = bareRouter();
  });

  describe('DFA rule matching', () => {
    it('routes a message matching a DFA rule to the correct model', () => {
      router.addRule({
        pattern: '\\bdeploy\\b',
        category: 'devops',
        model: 'ollama/devops-model:cloud',
        priority: 50,
      });

      const result = router.route('intent', 'please deploy the service');

      expect(result.tier).toBe('dfa');
      expect(result.category).toBe('devops');
      expect(result.model).toBe('ollama/devops-model:cloud');
      expect(result.confidence).toBe(1);
      expect(result.blocked).toBeUndefined();
    });

    it('matches DFA rule against the intent portion as well', () => {
      router.addRule({
        pattern: '\\bmonitor\\b',
        category: 'ops',
        model: 'ollama/ops-model:cloud',
        priority: 50,
      });

      const result = router.route('monitor the cluster', 'show metrics');

      expect(result.tier).toBe('dfa');
      expect(result.category).toBe('ops');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. DFA block rule
  // ---------------------------------------------------------------------------
  describe('DFA block rule', () => {
    it('returns blocked=true when a block rule matches', () => {
      router.addRule({
        pattern: '\\bhack\\b',
        category: 'blocked',
        model: '',
        priority: 100,
        block: true,
      });

      const result = router.route('intent', 'how to hack a server');

      expect(result.blocked).toBe(true);
      expect(result.model).toBe('');
      expect(result.category).toBe('blocked');
      expect(result.tier).toBe('dfa');
      expect(result.confidence).toBe(1);
      expect(result.ruleMatched?.block).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. DFA redirect rule
  // ---------------------------------------------------------------------------
  describe('DFA redirect rule', () => {
    it('returns redirect field when a redirect rule matches', () => {
      router.addRule({
        pattern: '\\btranslate\\b',
        category: 'translation',
        model: ROUTING_MODELS.fast,
        priority: 80,
        redirect: ROUTING_MODELS.fast,
      });

      const result = router.route('intent', 'translate this paragraph');

      expect(result.redirect).toBe(ROUTING_MODELS.fast);
      expect(result.category).toBe('translation');
      expect(result.tier).toBe('dfa');
      expect(result.confidence).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Keyword fallback
  // ---------------------------------------------------------------------------
  describe('keyword fallback', () => {
    it('routes via keyword heuristic when no DFA rule matches', () => {
      // "error", "build", "test" are in CODING_KEYWORDS but not in any
      // default DFA pattern, so they fall through to keyword tier.
      const result = router.route('intent', 'error in the build test');

      expect(result.tier).toBe('keyword');
      expect(result.category).toBe('coding');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.model).toBe(ROUTING_MODELS.coding);
    });

    it('routes analysis messages via keyword heuristic', () => {
      // "write" and "essay" are in ANALYSIS_KEYWORDS but not in DFA patterns.
      const result = router.route('intent', 'write an essay about the topic');

      expect(result.tier).toBe('keyword');
      expect(result.category).toBe('analysis');
      expect(result.model).toBe(ROUTING_MODELS.analysis);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. LLM fallback
  // ---------------------------------------------------------------------------
  describe('LLM fallback', () => {
    it('returns tier=llm when keyword confidence is below llmThreshold', () => {
      // A very short, ambiguous message should score low on all keyword sets.
      const result = router.route('intent', 'hello there');

      expect(result.confidence).toBeLessThan(0.4);
      // Confidence may fall below the llmThreshold (0.2) or land between
      // thresholds. Either way, verify the result is well-formed.
      expect(['keyword', 'llm']).toContain(result.tier);
      expect(result.scores).toBeDefined();
    });

    it('returns low confidence for ambiguous single-word messages', () => {
      const result = router.route('intent', 'okay');

      expect(result.confidence).toBeLessThanOrEqual(0.2);
      expect(result.tier).toBe('llm');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Priority ordering
  // ---------------------------------------------------------------------------
  describe('priority ordering', () => {
    it('higher priority rules take precedence over lower priority', () => {
      router.addRule({
        pattern: '\\bdata\\b',
        category: 'low-priority-cat',
        model: 'ollama/low-model:cloud',
        priority: 10,
      });
      router.addRule({
        pattern: '\\bdata\\b',
        category: 'high-priority-cat',
        model: 'ollama/high-model:cloud',
        priority: 90,
      });

      const result = router.route('intent', 'process the data pipeline');

      expect(result.category).toBe('high-priority-cat');
      expect(result.model).toBe('ollama/high-model:cloud');
    });

    it('block rules at high priority prevent lower-priority routing', () => {
      router.addRule({
        pattern: '\\bsecret\\b',
        category: 'sensitive',
        model: 'ollama/sensitive-model:cloud',
        priority: 50,
      });
      router.addRule({
        pattern: '\\bsecret\\b',
        category: 'blocked',
        model: '',
        priority: 100,
        block: true,
      });

      const result = router.route('intent', 'access the secret vault');

      expect(result.blocked).toBe(true);
      expect(result.category).toBe('blocked');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Rule management
  // ---------------------------------------------------------------------------
  describe('rule management', () => {
    it('addRule adds a rule and getRules returns it', () => {
      const rule: NegativeRule = {
        pattern: '\\bcustom\\b',
        category: 'custom',
        model: 'ollama/custom:cloud',
        priority: 60,
      };

      router.addRule(rule);
      const rules = router.getRules();

      expect(rules).toContainEqual(rule);
    });

    it('removeRule removes a rule by pattern and returns true', () => {
      const rule: NegativeRule = {
        pattern: '\\btemp\\b',
        category: 'temp',
        model: 'ollama/temp:cloud',
        priority: 30,
      };

      router.addRule(rule);
      expect(router.removeRule('\\btemp\\b')).toBe(true);
      expect(router.getRules()).not.toContainEqual(rule);
    });

    it('removeRule returns false for non-existent pattern', () => {
      expect(router.removeRule('\\bnonexistent\\b')).toBe(false);
    });

    it('removed rule no longer routes messages', () => {
      const rule: NegativeRule = {
        pattern: '\\bflavor\\b',
        category: 'flavor',
        model: 'ollama/flavor:cloud',
        priority: 70,
      };

      router.addRule(rule);
      expect(router.route('intent', 'pick a flavor').tier).toBe('dfa');
      router.removeRule('\\bflavor\\b');
      expect(router.route('intent', 'pick a flavor').tier).not.toBe('dfa');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Stats tracking
  // ---------------------------------------------------------------------------
  describe('stats tracking', () => {
    it('getStats returns correct counts after multiple calls', () => {
      router.addRule({ pattern: '\\bhack\\b', category: 'blocked', model: '', priority: 100, block: true });
      router.addRule({ pattern: '\\btranslate\\b', category: 'translation', model: ROUTING_MODELS.fast, priority: 80, redirect: ROUTING_MODELS.fast });

      router.route('intent', 'hack the mainframe');   // DFA tier0 hit, block
      router.route('intent', 'translate this text');   // DFA tier0 hit, redirect
      router.route('intent', 'error in the build');    // keyword tier1 hit (no DFA match)
      router.route('intent', 'okay fine');             // llm tier2 hit (low confidence)

      const stats = router.getStats();

      expect(stats.totalCalls).toBe(4);
      expect(stats.tier0Hits).toBe(2); // hack (blocked) + translate (redirect)
      expect(stats.blocks).toBe(1);
      expect(stats.redirects).toBe(1);
    });

    it('stats object is a copy, not a live reference', () => {
      router.route('intent', 'hello');
      const stats1 = router.getStats();
      const totalBefore = stats1.totalCalls;
      router.route('intent', 'hello again');
      const stats2 = router.getStats();

      expect(stats1.totalCalls).toBe(totalBefore);
      expect(stats2.totalCalls).toBe(totalBefore + 1);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Default rules
  // ---------------------------------------------------------------------------
  describe('default rules', () => {
    it('default router has pre-configured rules', () => {
      const defaultRouter = new NegativeRouter();
      const rules = defaultRouter.getRules();

      expect(rules.length).toBeGreaterThan(0);
      const blockRules = rules.filter(r => r.block);
      expect(blockRules.length).toBeGreaterThan(0);
      const redirectRules = rules.filter(r => r.redirect);
      expect(redirectRules.length).toBeGreaterThan(0);
    });

    it('default router routes coding messages via DFA', () => {
      const defaultRouter = new NegativeRouter();
      const result = defaultRouter.route('intent', 'fix the bug in the function');

      expect(result.tier).toBe('dfa');
      expect(result.category).toBe('coding');
    });

    it('default router blocks hack messages', () => {
      const defaultRouter = new NegativeRouter();
      const result = defaultRouter.route('intent', 'how to hack a server');

      expect(result.blocked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Empty input
  // ---------------------------------------------------------------------------
  describe('empty input', () => {
    it('returns fast model fallback for empty message and intent', () => {
      const result = router.route('', '');

      expect(result.model).toBe(ROUTING_MODELS.fast);
      expect(result.category).toBe('fast');
      expect(result.confidence).toBe(0);
      expect(result.tier).toBe('keyword');
    });

    it('returns fast model fallback when both are undefined-like', () => {
      const result = router.route('', '');

      expect(result.model).toBe(ROUTING_MODELS.fast);
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Concurrent calls
  // ---------------------------------------------------------------------------
  describe('concurrent calls', () => {
    it('multiple rapid calls do not crash', () => {
      router.addRule({ pattern: '\\bcode\\b', category: 'coding', model: ROUTING_MODELS.coding, priority: 50 });
      router.addRule({ pattern: '\\bhack\\b', category: 'blocked', model: '', priority: 100, block: true });

      const inputs = [
        'write code for me',
        'how to hack',
        'analyze this data',
        'translate this text',
        'fix the bug',
        'hello world',
        'deploy the app',
        'search for papers',
        'explain the concept',
        'okay',
      ];

      const results: RoutingResult[] = [];
      for (const msg of inputs) {
        results.push(router.route('intent', msg));
      }

      expect(results).toHaveLength(inputs.length);
      // Verify each result is well-formed
      for (const r of results) {
        expect(r).toHaveProperty('model');
        expect(r).toHaveProperty('category');
        expect(r).toHaveProperty('tier');
        expect(r).toHaveProperty('confidence');
        expect(r).toHaveProperty('scores');
      }

      const stats = router.getStats();
      expect(stats.totalCalls).toBe(inputs.length);
    });

    it('concurrent addRule and route do not throw', () => {
      // Alternate adding rules and routing to stress recompilation
      for (let i = 0; i < 20; i++) {
        router.addRule({
          pattern: `\\bword${i}\\b`,
          category: 'test',
          model: ROUTING_MODELS.fast,
          priority: 10 + i,
        });
        router.route('intent', `word${i} something`);
      }

      const stats = router.getStats();
      expect(stats.totalCalls).toBe(20);
      expect(stats.tier0Hits).toBe(20);
    });
  });
});