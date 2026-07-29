/**
 * Multi-turn tool-execution loop over the free app-chat lane.
 * Covers: text-only single turn, one tool round-trip → final answer,
 * multi-tool sequence, max-iterations halt, executor-throw → is_error
 * observation (loop continues), and transcript accumulation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IRMessage, IRTool } from '../../shared-types/ir/v1.js';
import { runGrokWebToolLoop, type GrokToolExecResult } from '../../src/llm/grok-web-tool-loop.js';

const TOOLS: IRTool[] = [
  { name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
];
const USER: IRMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] }];
const ids = () => {
  let n = 0;
  return () => `id_${++n}`;
};

describe('runGrokWebToolLoop', () => {
  it('returns immediately when grok gives a final text answer', async () => {
    const chat = vi.fn(async () => ({ text: 'It is sunny.' }));
    const execute = vi.fn(async (): Promise<GrokToolExecResult> => ({ content: 'unused' }));
    const r = await runGrokWebToolLoop(USER, TOOLS, chat, execute, { idFn: ids() });
    expect(r).toMatchObject({ finalText: 'It is sunny.', stopReason: 'final', iterations: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('runs a tool, feeds the result back, then returns the final answer', async () => {
    let turn = 0;
    const chat = vi.fn(async (message: string) => {
      turn++;
      if (turn === 1) return { text: '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>' };
      // second turn must SEE the tool result in the rebuilt transcript
      expect(message).toContain('Tool result: 18C sunny');
      return { text: 'It is 18C and sunny in Paris.' };
    });
    const execute = vi.fn(async (name: string, input: Record<string, unknown>): Promise<GrokToolExecResult> => {
      expect(name).toBe('get_weather');
      expect(input).toEqual({ city: 'Paris' });
      return { content: '18C sunny' };
    });
    const r = await runGrokWebToolLoop(USER, TOOLS, chat, execute, { idFn: ids() });
    expect(r.finalText).toBe('It is 18C and sunny in Paris.');
    expect(r.stopReason).toBe('final');
    expect(r.iterations).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    // transcript: user + assistant(tool_use) + user(tool_result) + assistant(text)
    expect(r.messages).toHaveLength(4);
    expect(r.messages[1]!.content[0]!.type).toBe('tool_use');
    expect(r.messages[2]!.content[0]!.type).toBe('tool_result');
  });

  it('chains multiple tool calls before finishing', async () => {
    const replies = [
      '<tool_call>{"name":"get_weather","arguments":{"city":"A"}}</tool_call>',
      '<tool_call>{"name":"get_weather","arguments":{"city":"B"}}</tool_call>',
      'Both fetched.',
    ];
    let i = 0;
    const chat = vi.fn(async () => ({ text: replies[i++]! }));
    const execute = vi.fn(async (): Promise<GrokToolExecResult> => ({ content: 'ok' }));
    const r = await runGrokWebToolLoop(USER, TOOLS, chat, execute, { idFn: ids() });
    expect(r.iterations).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(r.finalText).toBe('Both fetched.');
  });

  it('a throwing tool becomes an is_error observation and the loop continues', async () => {
    let turn = 0;
    const chat = vi.fn(async (message: string) => {
      turn++;
      if (turn === 1) return { text: '<tool_call>{"name":"get_weather","arguments":{}}</tool_call>' };
      expect(message).toContain('Tool error:');
      return { text: 'Sorry, the tool failed.' };
    });
    const execute = vi.fn(async (): Promise<GrokToolExecResult> => {
      throw new Error('network down');
    });
    const r = await runGrokWebToolLoop(USER, TOOLS, chat, execute, { idFn: ids() });
    expect(r.finalText).toBe('Sorry, the tool failed.');
    const toolResult = r.messages.find((m) => m.content[0]!.type === 'tool_result')!.content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', is_error: true });
    expect((toolResult as { content: string }).content).toContain('network down');
  });

  it('respects isError from the executor result', async () => {
    let turn = 0;
    const chat = vi.fn(async () => {
      turn++;
      return turn === 1
        ? { text: '<tool_call>{"name":"get_weather","arguments":{}}</tool_call>' }
        : { text: 'done' };
    });
    const execute = vi.fn(async (): Promise<GrokToolExecResult> => ({ content: 'bad input', isError: true }));
    const r = await runGrokWebToolLoop(USER, TOOLS, chat, execute, { idFn: ids() });
    const tr = r.messages.find((m) => m.content[0]!.type === 'tool_result')!.content[0];
    expect(tr).toMatchObject({ is_error: true });
  });

  it('halts with max_iterations when grok never stops calling tools', async () => {
    const chat = vi.fn(async () => ({ text: '<tool_call>{"name":"get_weather","arguments":{}}</tool_call>' }));
    const execute = vi.fn(async (): Promise<GrokToolExecResult> => ({ content: 'again' }));
    const r = await runGrokWebToolLoop(USER, TOOLS, chat, execute, { maxIterations: 3, idFn: ids() });
    expect(r.stopReason).toBe('max_iterations');
    expect(r.iterations).toBe(3);
    expect(r.finalText).toBe('');
    expect(chat).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
