/**
 * @file tests/brain/context-compressor.test.ts
 * @description Tests for ContextCompressor — graduated four-stage compression.
 * 1. shouldCompress  2. compressMild  3. compressModerate  4. compressAggressive
 * 5. System prompt preservation  6. Last messages preserved  7. Tool pairs preserved
 * 8. Idempotency  9. Stats tracking  10. Empty messages
 */

import { describe, it, expect } from 'vitest';
import { ContextCompressor } from '../../src/core/brain/index.js';
import type { BrainMessage } from '../../src/core/brain/types.js';

/** Build a conversation with `count` user/assistant turns. */
function makeMessages(count: number, opts?: { longContent?: boolean }): BrainMessage[] {
  const msgs: BrainMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }];
  for (let i = 1; i <= count; i++) {
    const u = opts?.longContent
      ? `User message ${i} with lots of extra padding to ensure significant token count. `.repeat(12)
      : `User message ${i}`;
    const a = opts?.longContent
      ? `Assistant reply ${i} with detailed explanation and reasoning. `.repeat(10)
      : `Assistant reply ${i}`;
    msgs.push({ role: 'user', content: u }, { role: 'assistant', content: a });
  }
  return msgs;
}

/** Build messages containing tool-call/result pairs. */
function makeToolMessages(): BrainMessage[] {
  return [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Read the file' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'readFile', arguments: {} }] },
    { role: 'tool', content: 'File contents are here for you', toolCallId: 'tc-1', toolName: 'readFile' },
    { role: 'assistant', content: 'Here is the file.' },
    { role: 'user', content: 'Now write it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'tc-2', name: 'writeFile', arguments: {} }] },
    { role: 'tool', content: 'Written successfully', toolCallId: 'tc-2', toolName: 'writeFile' },
    { role: 'assistant', content: 'Done writing.' },
    { role: 'user', content: 'Final user message' },
  ];
}

describe('ContextCompressor', () => {
  // 1. shouldCompress threshold detection
  describe('shouldCompress', () => {
    const c = new ContextCompressor();
    it('returns "none" below 50%', () => {
      expect(c.shouldCompress(0)).toBe('none');
      expect(c.shouldCompress(0.49)).toBe('none');
    });
    it('returns "mild" at 50%+', () => {
      expect(c.shouldCompress(0.5)).toBe('mild');
      expect(c.shouldCompress(0.69)).toBe('mild');
    });
    it('returns "moderate" at 70%+', () => {
      expect(c.shouldCompress(0.7)).toBe('moderate');
      expect(c.shouldCompress(0.84)).toBe('moderate');
    });
    it('returns "aggressive" at 85%+', () => {
      expect(c.shouldCompress(0.85)).toBe('aggressive');
      expect(c.shouldCompress(0.94)).toBe('aggressive');
    });
    it('returns "emergency" at 95%+', () => {
      expect(c.shouldCompress(0.95)).toBe('emergency');
      expect(c.shouldCompress(1.0)).toBe('emergency');
    });
  });

  // 2. compressMild: summarises old messages, keeps recent intact
  it('compressMild: summarises old messages, keeps recent intact', async () => {
    const msgs = makeMessages(8, { longContent: true });
    const c = new ContextCompressor();
    const compressed = await c.compressMild(msgs);
    const mid = Math.floor(msgs.length / 2);
    for (let i = 1; i < mid; i++) {
      if (compressed[i].content !== msgs[i].content) {
        expect(compressed[i].content.length).toBeLessThan(msgs[i].content.length);
      }
    }
    for (let i = mid; i < compressed.length; i++) {
      expect(compressed[i].content).toBe(msgs[i].content);
    }
    expect(compressed.length).toBe(msgs.length);
  });

  // 3. compressModerate: compresses tool results, merges consecutive messages
  it('compressModerate: compresses tool results, merges consecutive messages', async () => {
    const msgs: BrainMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Go ahead' },
      { role: 'assistant', content: 'Step one analysis' },
      { role: 'assistant', content: 'Step two reasoning' },
      { role: 'assistant', content: 'Step three conclusion' },
      { role: 'user', content: 'Now check the file' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc-a', name: 'check', arguments: {} }] },
      { role: 'tool', content: 'A very long tool result with extensive output that should be compressed down', toolCallId: 'tc-a', toolName: 'check' },
      { role: 'assistant', content: 'Check complete' },
      { role: 'user', content: 'Final request' },
    ];
    const c = new ContextCompressor();
    const compressed = await c.compressModerate(msgs);
    expect(compressed.some((m) => m.content.includes('[merged]'))).toBe(true);
    const origTool = msgs.find((m) => m.role === 'tool')!;
    const compTool = compressed.find((m) => m.role === 'tool' && m.toolCallId === 'tc-a');
    if (compTool && compTool.content !== origTool.content) {
      expect(compTool.content.length).toBeLessThan(origTool.content.length);
    }
  });

  // 4. compressAggressive: creates 5-section structured summary
  it('compressAggressive: creates 5-section structured summary', async () => {
    const msgs = makeMessages(10, { longContent: true });
    const c = new ContextCompressor();
    const { messages: compressed, summary } = await c.compressAggressive(msgs);
    for (const section of ['Decisions', 'Open TODOs', 'Constraints', 'Pending asks', 'Identifiers']) {
      expect(summary).toContain(`## ${section}`);
    }
    expect(compressed[0].content).toBe(msgs[0].content);
    expect(compressed[1].content).toContain('Context Summary');
  });

  // 5. System prompt preservation: system messages are never compressed
  it('system prompt is never compressed across any stage', async () => {
    const sysContent = 'You are a helpful assistant. Never modify this.';
    const msgs: BrainMessage[] = [
      { role: 'system', content: sysContent },
      ...makeMessages(8, { longContent: true }).slice(1),
    ];
    const c = new ContextCompressor();
    for (const stage of ['mild', 'moderate', 'aggressive'] as const) {
      let compressed: BrainMessage[];
      if (stage === 'mild') compressed = await c.compressMild(msgs);
      else if (stage === 'moderate') compressed = await c.compressModerate(msgs);
      else { const agg = await c.compressAggressive(msgs); compressed = agg.messages; }
      expect(compressed[0].content).toBe(sysContent);
    }
  });

  // 6. Last messages preserved: last user+assistant pair always kept
  it('last user+assistant pair always preserved across all stages', async () => {
    const msgs = makeMessages(8, { longContent: true });
    const lastUser = msgs.filter((m) => m.role === 'user').at(-1)!.content;
    const lastAsst = msgs.filter((m) => m.role === 'assistant').at(-1)!.content;
    const c = new ContextCompressor();
    for (const stage of ['mild', 'moderate', 'aggressive'] as const) {
      let compressed: BrainMessage[];
      if (stage === 'mild') compressed = await c.compressMild(msgs);
      else if (stage === 'moderate') compressed = await c.compressModerate(msgs);
      else { const agg = await c.compressAggressive(msgs); compressed = agg.messages; }
      expect(compressed.filter((m) => m.role === 'user').at(-1)!.content).toBe(lastUser);
      expect(compressed.filter((m) => m.role === 'assistant').at(-1)!.content).toBe(lastAsst);
    }
  });

  // 7. Tool pairs preserved: tool-call/result pairs are never split
  it('tool-call/result pairs are never split', async () => {
    const msgs = makeToolMessages();
    const c = new ContextCompressor();
    for (const stage of ['mild', 'moderate'] as const) {
      const compressed = stage === 'mild'
        ? await c.compressMild(msgs) : await c.compressModerate(msgs);
      for (let i = 0; i < compressed.length; i++) {
        const m = compressed[i];
        if (m.role === 'assistant' && m.toolCalls?.length) {
          const callIds = new Set(m.toolCalls.map((tc) => tc.id));
          for (let j = i + 1; j < compressed.length && compressed[j].role === 'tool'; j++) {
            if (compressed[j].toolCallId) {
              expect(callIds.has(compressed[j].toolCallId as string)).toBe(true);
            }
          }
        }
      }
    }
  });

  // 8. Idempotency: running same stage twice produces same result
  it('idempotent: running same stage twice produces same result', async () => {
    const msgs = makeMessages(10, { longContent: true });
    const c = new ContextCompressor();
    const first = await c.compress(msgs, 'mild', 8000);
    const second = await c.compress(msgs, 'mild', 8000);
    expect(first.tokensAfter).toBe(second.tokensAfter);
    expect(first.ratio).toBe(second.ratio);
  });

  // 9. Stats tracking: getStats() returns correct compression counts
  it('getStats() returns correct compression counts', async () => {
    const c = new ContextCompressor();
    const msgs = makeMessages(6, { longContent: true });
    expect(c.getStats().totalCompressions).toBe(0);
    expect(c.getStats().tokensSaved).toBe(0);
    await c.compress(msgs, 'mild', 8000);
    await c.compress(msgs, 'moderate', 8000);
    await c.compress(msgs, 'aggressive', 8000);
    const stats = c.getStats();
    expect(stats.totalCompressions).toBe(3);
    expect(stats.byStage.mild).toBe(1);
    expect(stats.byStage.moderate).toBe(1);
    expect(stats.byStage.aggressive).toBe(1);
    expect(stats.byStage.emergency).toBe(0);
    expect(stats.tokensSaved).toBeGreaterThanOrEqual(0);
  });

  // 10. Empty messages: handles empty array gracefully
  it('handles empty message array gracefully', async () => {
    const c = new ContextCompressor();
    for (const stage of ['none', 'mild', 'moderate', 'aggressive', 'emergency'] as const) {
      const result = await c.compress([], stage, 8000);
      expect(result.tokensBefore).toBe(0);
      expect(result.tokensAfter).toBe(0);
      expect(result.ratio).toBe(1);
    }
  });
});