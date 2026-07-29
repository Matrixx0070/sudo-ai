/**
 * grok-web as a first-class IR provider: route detection, model-id parsing, and
 * IRResponse envelope mapping (tool_use vs end_turn, cost 0, system passthrough).
 * grokWebComplete is mocked — this tests the provider's mapping, not the lane.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IRRequest } from '../../shared-types/ir/v1.js';

vi.mock('../../src/llm/grok-web-media.js', () => ({
  grokWebComplete: vi.fn(),
}));

import { grokWebComplete } from '../../src/llm/grok-web-media.js';
import { callGrokWebIR, isGrokWebRoute, grokWebModelId } from '../../src/llm/grok-web-provider.js';

const baseIR = (over: Partial<IRRequest> = {}): IRRequest => ({
  alias: 'grok-web/grok-4',
  caller: 'agent-loop',
  purpose: 'test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  priority: 'user',
  trace_id: 't1',
  ...over,
});

beforeEach(() => vi.mocked(grokWebComplete).mockReset());

describe('route helpers', () => {
  it('detects grok-web routes', () => {
    expect(isGrokWebRoute('grok-web/grok-4')).toBe(true);
    expect(isGrokWebRoute('claude-oauth/claude-fable-5')).toBe(false);
  });
  it('parses the model id, defaulting to grok-4', () => {
    expect(grokWebModelId('grok-web/grok-4')).toBe('grok-4');
    expect(grokWebModelId('grok-web/')).toBe('grok-4');
  });
});

describe('callGrokWebIR', () => {
  it('maps a tool_use block to stop_reason tool_use, cost 0', async () => {
    vi.mocked(grokWebComplete).mockResolvedValue([
      { type: 'tool_use', id: 'x', name: 'f', input: { a: 1 } },
    ]);
    const res = await callGrokWebIR(baseIR());
    expect(res.stop_reason).toBe('tool_use');
    expect(res.blocks[0]).toMatchObject({ type: 'tool_use', name: 'f' });
    expect(res.cost_usd).toBe(0);
    expect(res.usage).toEqual({ in: 0, out: 0, cached_in: 0 });
    expect(res.extra).toMatchObject({ provider: 'grok-web', model: 'grok-4' });
    expect(res.trace_id).toBe('t1');
  });

  it('maps a text block to stop_reason end_turn', async () => {
    vi.mocked(grokWebComplete).mockResolvedValue([{ type: 'text', text: 'done' }]);
    const res = await callGrokWebIR(baseIR());
    expect(res.stop_reason).toBe('end_turn');
    expect(res.blocks[0]).toEqual({ type: 'text', text: 'done' });
  });

  it('passes the model id, tools, and system prompt through', async () => {
    vi.mocked(grokWebComplete).mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await callGrokWebIR(
      baseIR({ alias: 'grok-web/grok-4-auto', system: 'be terse', tools: [{ name: 'f', input_schema: {} }] }),
    );
    const [msgs, tools, opts] = vi.mocked(grokWebComplete).mock.calls[0]!;
    expect(msgs).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(opts).toMatchObject({ modelName: 'grok-4-auto', system: 'be terse' });
  });

  // Lane-error propagation (rate-limit → failover) is guaranteed by construction:
  // callGrokWebIR is a straight `await grokWebComplete(...)` with no try/catch, and
  // the transport wrapper (callGrokWebBrainTurn) logs + rethrows for the failover chain.
});
