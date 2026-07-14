/**
 * gw-refactor Phase 7 — shadow machinery tests.
 * Covers: brainRequestToIR mapping (text / tool-call / tool-result turns),
 * resultToIR finishReason mapping, compareShadow material vs non-material,
 * and requestShadowDiff catching a deliberately mangled adapter output.
 */

import { describe, it, expect } from 'vitest';
import {
  brainRequestToIR,
  resultToIR,
  compareShadow,
  requestShadowDiff,
  compareWireAgainstLegacy,
  legacyFinishReasonToIR,
  wireFamilyFor,
  type ShadowBrainRequest,
} from '../../src/llm/shadow.js';
import { egressOpenAI } from '../../src/llm/adapters/egress-openai.js';

// ---------------------------------------------------------------------------
// brainRequestToIR
// ---------------------------------------------------------------------------

describe('brainRequestToIR', () => {
  it('maps a plain text conversation, folding system messages into ir.system', () => {
    const req: ShadowBrainRequest = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi there' },
        { role: 'assistant', content: 'hello!' },
        { role: 'user', content: 'how are you?' },
      ],
      system: 'BASE PROMPT',
      source: 'chat',
      temperature: 0.5,
      maxTokens: 4096,
    };
    const ir = brainRequestToIR(req, 'xai/grok-4-fast-reasoning');

    expect(ir.system).toBe('BASE PROMPT\n\nYou are helpful.');
    expect(ir.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi there' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello!' }] },
      { role: 'user', content: [{ type: 'text', text: 'how are you?' }] },
    ]);
    expect(ir.alias).toBe('xai/grok-4-fast-reasoning');
    expect(ir.caller).toBe('chat');
    expect(ir.purpose).toBe('shadow');
    expect(ir.priority).toBe('user'); // chat → user
    expect(ir.temperature).toBe(0.5);
    expect(ir.max_tokens).toBe(4096);
    expect(ir.trace_id).toMatch(/^shadow-/);
  });

  it('F4a: whitespace-only text is stripped (user and assistant), never an empty text block', () => {
    const req: ShadowBrainRequest = {
      messages: [
        { role: 'user', content: 'real question' },
        { role: 'assistant', content: '   \n\t ' }, // whitespace-only → message dropped
        { role: 'user', content: '  ' }, // whitespace-only → message dropped
        { role: 'user', content: 'follow-up' },
      ],
    };
    const ir = brainRequestToIR(req, 'anthropic/claude-opus-4-8');
    expect(ir.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'real question' }] },
      { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
    ]);
  });

  it('F4a: whitespace-only assistant text with toolCalls keeps the tool_use, drops the text block', () => {
    const req: ShadowBrainRequest = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: ' ', toolCalls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'x' } }] },
        { role: 'tool', content: 'body', toolCallId: 'c1' },
      ],
    };
    const ir = brainRequestToIR(req, 'anthropic/claude-opus-4-8');
    expect(ir.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'fs.read', input: { path: 'x' } }],
    });
    // The whitespace-only user message with an image keeps the image only.
    const ir2 = brainRequestToIR(
      { messages: [{ role: 'user', content: '  ', images: [{ type: 'url', data: 'https://x/i.png' }] }] },
      'anthropic/claude-opus-4-8',
    );
    expect(ir2.messages).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/i.png' } }] },
    ]);
  });

  it('F4b: orphan tool_result dropped, paired one survives (legacy orphan-strip parity)', () => {
    const req: ShadowBrainRequest = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'ok', toolCalls: [{ id: 'c1', name: 'fs.read', arguments: {} }] },
        { role: 'tool', content: 'kept result', toolCallId: 'c1' },
        { role: 'tool', content: 'orphan result', toolCallId: 'fallback_123' }, // no matching tool_use
        { role: 'user', content: 'summarize' },
      ],
    };
    const ir = brainRequestToIR(req, 'anthropic/claude-opus-4-8');
    expect(ir.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'kept result' }],
    });
    // The orphan never appears anywhere in the IR.
    const allBlocks = ir.messages.flatMap((m) => m.content);
    expect(allBlocks.some((b) => b.type === 'tool_result' && b.tool_use_id === 'fallback_123')).toBe(false);
    expect(ir.messages).toHaveLength(4); // user, assistant, folded results, user
  });

  it('F4b: a folded tool-results message that becomes EMPTY is dropped entirely', () => {
    const req: ShadowBrainRequest = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'no tools used' },
        { role: 'tool', content: 'orphan A', toolCallId: 'ghost_1' },
        { role: 'tool', content: 'orphan B', toolCallId: 'ghost_2' },
        { role: 'user', content: 'and?' },
      ],
    };
    const ir = brainRequestToIR(req, 'anthropic/claude-opus-4-8');
    expect(ir.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'no tools used' }] },
      { role: 'user', content: [{ type: 'text', text: 'and?' }] },
    ]);
  });

  it('F4: a history legacy would repair yields a CLEAN IR (no empty text, no orphans)', () => {
    const req: ShadowBrainRequest = {
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: '\n', toolCalls: [{ id: 'c1', name: 't', arguments: {} }] },
        { role: 'tool', content: 'r1', toolCallId: 'c1' },
        { role: 'tool', content: 'r-orphan', toolCallId: 'fallback_9' },
        { role: 'user', content: '\t ' },
        { role: 'user', content: 'end' },
      ],
    };
    const ir = brainRequestToIR(req, 'claude-oauth/claude-fable-5');
    const seenToolUse = new Set<string>();
    for (const m of ir.messages) {
      for (const b of m.content) {
        if (b.type === 'text') expect(b.text.trim()).not.toBe('');
        if (b.type === 'tool_use') seenToolUse.add(b.id);
        if (b.type === 'tool_result') expect(seenToolUse.has(b.tool_use_id)).toBe(true);
      }
      expect(m.content.length).toBeGreaterThan(0); // no empty-content messages
    }
  });

  it('maps priority background for non-chat/agent sources and defaults caller', () => {
    const ir = brainRequestToIR({ messages: [{ role: 'user', content: 'x' }], source: 'consciousness' }, 'm');
    expect(ir.priority).toBe('background');
    expect(ir.caller).toBe('consciousness');
    const ir2 = brainRequestToIR({ messages: [{ role: 'user', content: 'x' }] }, 'm');
    expect(ir2.caller).toBe('chat');
    expect(ir2.priority).toBe('background');
  });

  it('maps an assistant tool-call turn into text + tool_use blocks', () => {
    const ir = brainRequestToIR(
      {
        messages: [
          { role: 'user', content: 'read the file' },
          {
            role: 'assistant',
            content: 'Reading it now.',
            toolCalls: [{ id: 'call_1', name: 'fs.read', arguments: { path: '/tmp/a.txt', lines: 5 } }],
          },
        ],
      },
      'xai/grok-4',
    );
    expect(ir.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading it now.' },
        { type: 'tool_use', id: 'call_1', name: 'fs.read', input: { path: '/tmp/a.txt', lines: 5 } },
      ],
    });
  });

  it('folds consecutive tool-result messages into ONE user message of tool_result blocks', () => {
    const ir = brainRequestToIR(
      {
        messages: [
          { role: 'user', content: 'run both' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'c1', name: 't1', arguments: {} },
              { id: 'c2', name: 't2', arguments: {} },
            ],
          },
          { role: 'tool', content: 'result one', toolCallId: 'c1', toolName: 't1' },
          { role: 'tool', content: 'result two', toolCallId: 'c2', toolName: 't2' },
          { role: 'user', content: 'thanks' },
        ],
      },
      'anthropic/claude-opus-4-8',
    );
    expect(ir.messages).toHaveLength(4);
    // assistant turn carries only tool_use (empty text dropped)
    expect(ir.messages[1]!.content.every((b) => b.type === 'tool_use')).toBe(true);
    expect(ir.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'result one' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'result two' },
      ],
    });
    expect(ir.messages[3]).toEqual({ role: 'user', content: [{ type: 'text', text: 'thanks' }] });
  });

  it('maps ToolSchema tools to IRTool and user images to image blocks', () => {
    const ir = brainRequestToIR(
      {
        messages: [
          { role: 'user', content: 'what is this?', images: [{ type: 'base64', data: 'AAAA', mediaType: 'image/jpeg' }] },
        ],
        tools: [
          { type: 'function', function: { name: 'web.search', description: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
        ],
      },
      'xai/grok-4',
    );
    expect(ir.tools).toEqual([
      { name: 'web.search', description: 'search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
    ]);
    expect(ir.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// resultToIR
// ---------------------------------------------------------------------------

describe('resultToIR', () => {
  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool-calls', 'tool_use'],
    ['error', 'error'],
    ['content-filter', 'error'],
    ['some-unknown-reason', 'error'],
    [undefined, 'error'],
  ] as const)('maps finishReason %s → %s', (legacy, ir) => {
    expect(legacyFinishReasonToIR(legacy)).toBe(ir);
    expect(resultToIR({ text: 'x', finishReason: legacy }, 't1').stop_reason).toBe(ir);
  });

  it('maps text, toolCalls and usage', () => {
    const ir = resultToIR(
      {
        text: 'done',
        finishReason: 'tool-calls',
        usage: { promptTokens: 100, completionTokens: 20 },
        toolCalls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'a' } }],
      },
      'trace-9',
    );
    expect(ir.blocks).toEqual([
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 'c1', name: 'fs.read', input: { path: 'a' } },
    ]);
    expect(ir.usage).toEqual({ in: 100, out: 20, cached_in: 0 });
    expect(ir.trace_id).toBe('trace-9');
  });
});

// ---------------------------------------------------------------------------
// compareShadow
// ---------------------------------------------------------------------------

describe('compareShadow', () => {
  const base = { text: 'hello world', finishReason: 'stop' as const };

  it('matches when the IR round-trips the legacy result', () => {
    const legacy = { ...base, usage: { promptTokens: 100, completionTokens: 50 }, toolCalls: [] };
    const diff = compareShadow(legacy, resultToIR(legacy, 't'));
    expect(diff.material).toBe(false);
    expect(diff.fields).toEqual([]);
  });

  it('usage within ±10% is non-material; >10% is material', () => {
    const legacy = { ...base, usage: { promptTokens: 100, completionTokens: 50 } };
    const ir5 = resultToIR({ ...base, usage: { promptTokens: 95, completionTokens: 50 } }, 't'); // 5%
    const d5 = compareShadow(legacy, ir5);
    expect(d5.material).toBe(false);
    expect(d5.nonMaterial).toContain('usage');

    const ir15 = resultToIR({ ...base, usage: { promptTokens: 85, completionTokens: 50 } }, 't'); // 15%
    const d15 = compareShadow(legacy, ir15);
    expect(d15.material).toBe(true);
    expect(d15.fields).toEqual(['usage']);
  });

  it('tool args deep-equal pass; object-level mismatch is material', () => {
    const legacy = { ...base, toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1, b: { c: [1, 2] } } }] };
    const same = resultToIR({ ...base, toolCalls: [{ id: 'c1', name: 't', arguments: { b: { c: [1, 2] }, a: 1 } }] }, 't');
    expect(compareShadow(legacy, same).material).toBe(false); // key order irrelevant

    const mangled = resultToIR({ ...base, toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1, b: { c: [1, 3] } } }] }, 't');
    const d = compareShadow(legacy, mangled);
    expect(d.material).toBe(true);
    expect(d.fields).toEqual(['tool_calls']);
  });

  it('stop_reason class mismatch is material', () => {
    const d = compareShadow({ text: 'x', finishReason: 'stop' }, resultToIR({ text: 'x', finishReason: 'length' }, 't'));
    expect(d.material).toBe(true);
    expect(d.fields).toEqual(['stop_reason']);
  });

  it('whitespace-only text drift is non-material; real text mismatch is material', () => {
    const ws = compareShadow({ text: 'a  b\n' }, resultToIR({ text: 'a b' }, 't'));
    expect(ws.material).toBe(false);
    expect(ws.nonMaterial).toContain('text');

    const real = compareShadow({ text: 'a b' }, resultToIR({ text: 'a c' }, 't'));
    expect(real.material).toBe(true);
    expect(real.fields).toEqual(['text']);
  });

  it('skips fields absent on the legacy side (streaming path: no text/finishReason)', () => {
    const d = compareShadow({ usage: { promptTokens: 10, completionTokens: 5 } }, resultToIR({ usage: { promptTokens: 10, completionTokens: 5 } }, 't'));
    expect(d.material).toBe(false);
    expect(d.fields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// requestShadowDiff
// ---------------------------------------------------------------------------

const RICH_REQUEST: ShadowBrainRequest = {
  messages: [
    { role: 'system', content: 'extra rule' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'ok', toolCalls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'x' } }] },
    { role: 'tool', content: 'file body', toolCallId: 'c1' },
    { role: 'tool', content: 'second result', toolCallId: 'c2' },
    { role: 'user', content: 'summarize it' },
  ],
  system: 'BASE SYSTEM',
  source: 'agent',
  temperature: 1.5,
  maxTokens: 2048,
  tools: [
    { type: 'function', function: { name: 'fs.read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ],
};

describe('requestShadowDiff', () => {
  it('routes anthropic-shaped model ids to the anthropic adapter', () => {
    expect(wireFamilyFor('anthropic/claude-opus-4-8')).toBe('anthropic');
    expect(wireFamilyFor('claude-oauth/claude-fable-5')).toBe('anthropic');
    expect(wireFamilyFor('xai/grok-4')).toBe('openai');
  });

  it('known-good request → material:false through the OpenAI adapter', () => {
    const d = requestShadowDiff(RICH_REQUEST, 'xai/grok-4-fast-reasoning');
    expect(d.fields).toEqual([]);
    expect(d.material).toBe(false);
  });

  it('known-good request → material:false through the Anthropic adapter (incl. temperature clamp)', () => {
    const d = requestShadowDiff(RICH_REQUEST, 'claude-oauth/claude-fable-5');
    expect(d.fields).toEqual([]);
    expect(d.material).toBe(false);
  });

  it('known-good request with response-side extras still passes (no tools, background source)', () => {
    const d = requestShadowDiff(
      { messages: [{ role: 'user', content: 'ping' }], system: 'S', source: 'cron' },
      'anthropic/claude-opus-4-8',
    );
    expect(d.material).toBe(false);
  });

  it('flags a mangled wire body that DROPPED the tool schema', () => {
    const ir = brainRequestToIR(RICH_REQUEST, 'xai/grok-4');
    const body = egressOpenAI(ir);
    delete body['tools']; // simulate a broken adapter dropping the tools
    const d = compareWireAgainstLegacy(RICH_REQUEST, body, 'openai');
    expect(d.material).toBe(true);
    expect(d.fields).toContain('tools');
  });

  it('flags mangled user text and a dropped message', () => {
    const ir = brainRequestToIR(RICH_REQUEST, 'xai/grok-4');
    const body = egressOpenAI(ir);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    const lastUser = [...messages].reverse().find((m) => m['role'] === 'user')!;
    lastUser['content'] = 'summarize'; // mangled content
    const d = compareWireAgainstLegacy(RICH_REQUEST, body, 'openai');
    expect(d.material).toBe(true);
    expect(d.fields).toContain('user_text');

    messages.pop(); // drop a message entirely
    const d2 = compareWireAgainstLegacy(RICH_REQUEST, body, 'openai');
    expect(d2.fields).toContain('message_count');
  });

  it('flags a mangled tool schema (not just a dropped one)', () => {
    const ir = brainRequestToIR(RICH_REQUEST, 'xai/grok-4');
    const body = egressOpenAI(ir);
    const tools = body['tools'] as Array<{ function: Record<string, unknown> }>;
    tools[0]!.function['parameters'] = { type: 'object', properties: {} }; // schema mangled
    const d = compareWireAgainstLegacy(RICH_REQUEST, body, 'openai');
    expect(d.material).toBe(true);
    expect(d.fields).toContain('tools');
  });

  it('flags un-carried max_tokens / temperature', () => {
    const ir = brainRequestToIR(RICH_REQUEST, 'xai/grok-4');
    const body = egressOpenAI(ir);
    body['max_tokens'] = 999;
    delete body['temperature'];
    const d = compareWireAgainstLegacy(RICH_REQUEST, body, 'openai');
    expect(d.fields).toEqual(expect.arrayContaining(['max_tokens', 'temperature']));
  });
});
