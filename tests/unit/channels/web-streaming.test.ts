/**
 * Guards the agent-event → web-frame mapping that powers live streaming in the
 * web chat. Only tool-call and (non-empty) stream-chunk events surface to the
 * browser; everything else maps to null so the WS isn't spammed with frames the
 * SPA doesn't render. Frame shapes must match the SPA's ChatWSMessage union.
 */
import { describe, it, expect } from 'vitest';
import { agentEventToWebFrame } from '../../../src/core/channels/web.js';
import type { AgentEvent } from '../../../src/core/agent/types.js';

describe('agentEventToWebFrame', () => {
  it('maps a tool-call to a progress frame naming the tool', () => {
    const ev: AgentEvent = { type: 'tool-call', name: 'web.search', args: {}, toolId: 't1' };
    const frame = JSON.parse(agentEventToWebFrame(ev)!);
    expect(frame.type).toBe('progress');
    expect(frame.text).toContain('web.search');
  });

  it('maps a non-empty stream-chunk to a token frame', () => {
    const ev: AgentEvent = { type: 'stream-chunk', chunk: 'Let me check that.' };
    expect(JSON.parse(agentEventToWebFrame(ev)!)).toEqual({ type: 'token', text: 'Let me check that.' });
  });

  it('drops a whitespace-only stream-chunk', () => {
    expect(agentEventToWebFrame({ type: 'stream-chunk', chunk: '   \n' })).toBeNull();
  });

  it('drops events the web UI does not surface', () => {
    expect(agentEventToWebFrame({ type: 'message', content: 'hi' })).toBeNull();
    expect(agentEventToWebFrame({ type: 'tool-result', name: 'x', result: {}, toolId: 't1' } as AgentEvent)).toBeNull();
    expect(agentEventToWebFrame({ type: 'done' })).toBeNull();
    expect(agentEventToWebFrame({ type: 'error', error: 'boom' })).toBeNull();
  });
});
