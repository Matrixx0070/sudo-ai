/**
 * @file tests/brain/model-switch.test.ts
 * @description Runtime model switching (gap #11). resolveModelSwitch matches
 * /model targets against the configured failover chain; the /model command
 * duck-types brain.getModel()/setModel() — previously a permanent no-op
 * because Brain had neither method.
 */

import { describe, it, expect } from 'vitest';
import { resolveModelSwitch } from '../../src/core/brain/brain.js';
import { ModelFailover } from '../../src/core/brain/failover.js';
import { modelCommand } from '../../src/core/commands/builtin/model.js';
import type { CommandContext } from '../../src/core/commands/types.js';

const configured = ['anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'xai/grok-4'];

describe('resolveModelSwitch', () => {
  it('matches a full provider/model ref', () => {
    expect(resolveModelSwitch(configured, 'openai/gpt-5')).toBe('openai/gpt-5');
  });

  it('matches a bare model id case-insensitively and returns the canonical ref', () => {
    expect(resolveModelSwitch(configured, 'GROK-4')).toBe('xai/grok-4');
    expect(resolveModelSwitch(configured, 'claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
  });

  it('rejects unconfigured models and blank input', () => {
    expect(resolveModelSwitch(configured, 'mistral/large')).toBeNull();
    expect(resolveModelSwitch(configured, 'gpt-6')).toBeNull();
    expect(resolveModelSwitch(configured, '  ')).toBeNull();
    expect(resolveModelSwitch([], 'gpt-5')).toBeNull();
  });

  it('prefers an exact full-ref match over a bare-id match', () => {
    const dup = ['a/model-x', 'b/a']; // bare target "a" should not match provider prefix
    expect(resolveModelSwitch(dup, 'b/a')).toBe('b/a');
    expect(resolveModelSwitch(dup, 'a')).toBe('b/a'); // bare-id match on "a", not provider "a/"
  });
});

describe('ModelFailover.setPrimary', () => {
  it('promotes the model so the sequential failover path starts from it', () => {
    const failover = new ModelFailover(configured);
    expect(failover.getNextProfile()?.id).toBe('anthropic/claude-sonnet-4-6');
    failover.setPrimary('xai/grok-4');
    expect(failover.getNextProfile()?.id).toBe('xai/grok-4');
  });

  it('ignores unregistered models without disturbing the order', () => {
    const failover = new ModelFailover(configured);
    failover.setPrimary('mistral/large');
    expect(failover.getNextProfile()?.id).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('/model command against a brain with runtime switching', () => {
  function makeCtx(brain: unknown): CommandContext {
    return {
      channel: 'telegram',
      peerId: 'peer-1',
      sessionId: 'sess-1',
      agentLoop: { brain },
      toolRegistry: null,
      config: null,
      db: null,
    };
  }

  it('shows the current model with no args', async () => {
    const brain = { getModel: () => 'anthropic/claude-sonnet-4-6' };
    const reply = await modelCommand.execute('', makeCtx(brain));
    expect(reply).toBe('Current model: anthropic/claude-sonnet-4-6');
  });

  it('switches via brain.setModel and reports the new model', async () => {
    let current = 'anthropic/claude-sonnet-4-6';
    const brain = {
      getModel: () => current,
      setModel: (m: string) => { current = m; },
    };
    const reply = await modelCommand.execute('openai/gpt-5', makeCtx(brain));
    expect(reply).toBe('Model switched to: openai/gpt-5');
    expect(current).toBe('openai/gpt-5');
  });

  it('reports the canonical ref when switching via a bare model id', async () => {
    let current = 'anthropic/claude-sonnet-4-6';
    const brain = {
      getModel: () => current,
      setModel: (m: string) => {
        const match = resolveModelSwitch(configured, m);
        if (!match) throw new Error(`Model "${m}" is not configured`);
        current = match;
      },
    };
    const reply = await modelCommand.execute('grok-4', makeCtx(brain));
    expect(reply).toBe('Model switched to: xai/grok-4');
    expect(current).toBe('xai/grok-4');
  });

  it('surfaces setModel rejections as a user-facing failure message', async () => {
    const brain = {
      getModel: () => 'anthropic/claude-sonnet-4-6',
      setModel: () => { throw new Error('Model "nope" is not configured'); },
    };
    const reply = await modelCommand.execute('nope', makeCtx(brain));
    expect(reply).toContain('Failed to switch model');
    expect(reply).toContain('not configured');
  });
});
