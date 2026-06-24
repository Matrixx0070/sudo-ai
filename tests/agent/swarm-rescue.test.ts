/**
 * @file swarm-rescue.test.ts
 * @description Tests for Mythos Tier C swarm-rescue config + opts logic.
 * The decision is pure (env-injected), so the loop wiring stays a one-liner.
 */

import { describe, it, expect } from 'vitest';
import {
  isSwarmRescueEnabled,
  getSwarmRescueStrategy,
  swarmRescueCallOpts,
  DEFAULT_SWARM_RESCUE_STRATEGY,
} from '../../src/core/agent/swarm-rescue.js';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('swarm-rescue — enablement', () => {
  it('is OFF by default (unset)', () => {
    expect(isSwarmRescueEnabled(env({}))).toBe(false);
  });
  it('is OFF for any value other than "1"', () => {
    expect(isSwarmRescueEnabled(env({ SUDO_SWARM_RESCUE: '0' }))).toBe(false);
    expect(isSwarmRescueEnabled(env({ SUDO_SWARM_RESCUE: 'true' }))).toBe(false);
  });
  it('is ON only for "1"', () => {
    expect(isSwarmRescueEnabled(env({ SUDO_SWARM_RESCUE: '1' }))).toBe(true);
  });
});

describe('swarm-rescue — strategy selection', () => {
  it('defaults to debate (tool-loop-safe, verifier-free)', () => {
    expect(DEFAULT_SWARM_RESCUE_STRATEGY).toBe('debate');
    expect(getSwarmRescueStrategy(env({}))).toBe('debate');
  });
  it('honors a valid escalation strategy', () => {
    expect(getSwarmRescueStrategy(env({ SUDO_SWARM_RESCUE_STRATEGY: 'tree-search' }))).toBe('tree-search');
    expect(getSwarmRescueStrategy(env({ SUDO_SWARM_RESCUE_STRATEGY: 'debate' }))).toBe('debate');
  });
  it('is case-insensitive and trims', () => {
    expect(getSwarmRescueStrategy(env({ SUDO_SWARM_RESCUE_STRATEGY: '  TREE-SEARCH ' }))).toBe('tree-search');
  });
  it('falls back to the default for "single" (would be a no-op) and invalid values', () => {
    expect(getSwarmRescueStrategy(env({ SUDO_SWARM_RESCUE_STRATEGY: 'single' }))).toBe('debate');
    expect(getSwarmRescueStrategy(env({ SUDO_SWARM_RESCUE_STRATEGY: 'banana' }))).toBe('debate');
  });
});

describe('swarm-rescue — call opts', () => {
  it('returns undefined when inactive (preserves the prior single-arg call shape)', () => {
    expect(swarmRescueCallOpts(false, env({ SUDO_SWARM_RESCUE_STRATEGY: 'tree-search' }))).toBeUndefined();
  });
  it('returns the escalation strategy when active', () => {
    expect(swarmRescueCallOpts(true, env({}))).toEqual({ strategy: 'debate' });
    expect(swarmRescueCallOpts(true, env({ SUDO_SWARM_RESCUE_STRATEGY: 'tree-search' }))).toEqual({ strategy: 'tree-search' });
  });
});
