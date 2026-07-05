/**
 * @file tests/brain/brain-image-messages.test.ts
 * @description Regression tests for BrainMessage.images → SDK multi-part
 *   conversion. The images field used to be silently dropped in
 *   toSDKMessages, so vision-via-Brain always saw text only.
 */

import { describe, it, expect } from 'vitest';
import { toSDKMessages } from '../../src/core/brain/brain.js';
import type { BrainMessage } from '../../src/core/brain/types.js';

describe('toSDKMessages — image attachments', () => {
  it('converts a user message with a base64 image into text + image parts', () => {
    const messages: BrainMessage[] = [{
      role: 'user',
      content: 'What is in this screenshot?',
      images: [{ type: 'base64', data: 'aGVsbG8=', mediaType: 'image/jpeg' }],
    }];

    const [msg] = toSDKMessages(messages) as Array<{ role: string; content: unknown }>;
    expect(msg.role).toBe('user');
    const parts = msg.content as Array<Record<string, unknown>>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'text', text: 'What is in this screenshot?' });
    expect(parts[1]).toEqual({ type: 'image', image: 'aGVsbG8=', mediaType: 'image/jpeg' });
  });

  it('converts url-type images to URL objects', () => {
    const messages: BrainMessage[] = [{
      role: 'user',
      content: 'Describe',
      images: [{ type: 'url', data: 'https://example.com/pic.png', mediaType: 'image/png' }],
    }];

    const [msg] = toSDKMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msg.content[1]['type']).toBe('image');
    expect(msg.content[1]['image']).toBeInstanceOf(URL);
    expect(String(msg.content[1]['image'])).toBe('https://example.com/pic.png');
  });

  it('supports multiple images and empty text', () => {
    const messages: BrainMessage[] = [{
      role: 'user',
      content: '',
      images: [
        { type: 'base64', data: 'aa==' },
        { type: 'base64', data: 'bb==' },
      ],
    }];

    const [msg] = toSDKMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    // No empty text part (Anthropic rejects empty text blocks).
    expect(msg.content.every((p) => p['type'] === 'image')).toBe(true);
    expect(msg.content).toHaveLength(2);
  });

  it('user messages without images still pass through as plain strings', () => {
    const messages: BrainMessage[] = [{ role: 'user', content: 'hi' }];
    const [msg] = toSDKMessages(messages) as Array<{ role: string; content: unknown }>;
    expect(msg).toEqual({ role: 'user', content: 'hi' });
  });

  it('assistant tool-call messages are unaffected', () => {
    const messages: BrainMessage[] = [{
      role: 'assistant',
      content: 'calling',
      toolCalls: [{ id: 't1', name: 'x.y', arguments: {} }],
    }];
    const [msg] = toSDKMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msg.content[1]['type']).toBe('tool-call');
  });
});
