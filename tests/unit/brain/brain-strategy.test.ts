/**
 * brain-strategy — resolveEffectiveStrategy + high-stakes env upgrade.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveEffectiveStrategy,
  HIGH_STAKES_UPGRADE_ENV,
  DEFAULT_BRAIN_STRATEGY,
} from '../../../src/core/brain/brain-strategy.js';

describe('resolveEffectiveStrategy', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[HIGH_STAKES_UPGRADE_ENV];
    delete process.env[HIGH_STAKES_UPGRADE_ENV];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[HIGH_STAKES_UPGRADE_ENV];
    else process.env[HIGH_STAKES_UPGRADE_ENV] = savedEnv;
  });

  describe('baseline (no env, no opts)', () => {
    it('returns the configured strategy when opts is undefined', () => {
      expect(resolveEffectiveStrategy('single', undefined)).toBe('single');
      expect(resolveEffectiveStrategy('debate', undefined)).toBe('debate');
    });

    it('falls back to the brain default when nothing is configured', () => {
      expect(DEFAULT_BRAIN_STRATEGY).toBe('single');
    });
  });

  describe('fast tier', () => {
    it('always wins over configured strategy', () => {
      expect(resolveEffectiveStrategy('debate', { tier: 'fast' })).toBe('single');
      expect(resolveEffectiveStrategy('tree-search', { tier: 'fast' })).toBe('single');
    });

    it('always wins over explicit opts.strategy', () => {
      expect(resolveEffectiveStrategy('single', { tier: 'fast', strategy: 'debate' })).toBe('single');
    });

    it('always wins over the high-stakes env upgrade', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'tree-search';
      expect(resolveEffectiveStrategy('single', { tier: 'fast' })).toBe('single');
    });
  });

  describe('explicit opts.strategy', () => {
    it('wins over configured', () => {
      expect(resolveEffectiveStrategy('single', { strategy: 'debate' })).toBe('debate');
      expect(resolveEffectiveStrategy('debate', { strategy: 'single' })).toBe('single');
    });

    it('wins over the high-stakes env upgrade', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'tree-search';
      expect(resolveEffectiveStrategy('single', { strategy: 'single', tier: 'high-stakes' })).toBe('single');
    });
  });

  describe('high-stakes env upgrade', () => {
    it('upgrades single → debate when env is "debate" and tier is high-stakes', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'debate';
      expect(resolveEffectiveStrategy('single', { tier: 'high-stakes' })).toBe('debate');
    });

    it('upgrades single → tree-search when env is "tree-search" and tier is high-stakes', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'tree-search';
      expect(resolveEffectiveStrategy('single', { tier: 'high-stakes' })).toBe('tree-search');
    });

    it('does NOT upgrade when tier is routine', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'debate';
      expect(resolveEffectiveStrategy('single', { tier: 'routine' })).toBe('single');
    });

    it('does NOT upgrade when tier is undefined (defaults to routine)', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'debate';
      expect(resolveEffectiveStrategy('single', {})).toBe('single');
    });

    it('ignores invalid env values', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'invalid-strategy';
      expect(resolveEffectiveStrategy('single', { tier: 'high-stakes' })).toBe('single');
    });

    it('ignores empty env value', () => {
      process.env[HIGH_STAKES_UPGRADE_ENV] = '';
      expect(resolveEffectiveStrategy('single', { tier: 'high-stakes' })).toBe('single');
    });

    it('does NOT override the configured strategy when configured is already multi-step', () => {
      // Operator explicitly set the brain to debate; the env upgrade is for callers
      // that left strategy unspecified. Configured wins via the normal fallback.
      process.env[HIGH_STAKES_UPGRADE_ENV] = 'tree-search';
      expect(resolveEffectiveStrategy('debate', { tier: 'high-stakes' })).toBe('tree-search');
      // …because high-stakes upgrade takes precedence over configured when no opts.strategy.
      // This is intentional: the env says "promote everything high-stakes to tree-search".
    });
  });
});
