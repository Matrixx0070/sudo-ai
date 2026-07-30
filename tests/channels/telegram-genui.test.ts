/**
 * @file telegram-genui.test.ts
 * @description TX13 — A2UI closed schema → Telegram mapping. Buttons ride a
 * TTL token registry (64-byte callback_data cap); taps produce the SAME typed
 * [CANVAS EVENT] wire format as the web bridge; foreign/expired tokens die.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderCanvasForTelegram, resolveTx13Callback, canvasEventText,
  registerActionToken, TX13_CALLBACK_PREFIX, _resetTx13,
} from '../../src/core/channels/telegram-genui.js';
import type { CanvasPayload } from '../../src/core/canvas/schema.js';

beforeEach(() => _resetTx13());

const PAYLOAD: CanvasPayload = {
  version: 1,
  title: 'Vendor pick',
  components: [
    { type: 'text', text: 'Three options found.', variant: 'body' },
    { type: 'metric', label: 'Best price', value: '$42', delta: '-12%', trend: 'down' },
    { type: 'progress', value: 66, label: 'Research' },
    { type: 'list', items: ['Acme', 'Globex'] },
    { type: 'button', label: 'Pick Acme', actionId: 'pick:acme' },
    { type: 'button', label: 'Pick Globex', actionId: 'pick:globex' },
  ],
};

describe('TX13 telegram generative UI', () => {
  it('GENUI-1: renders text components and one keyboard row per button', () => {
    const r = renderCanvasForTelegram('sess-1', PAYLOAD);
    expect(r.text).toContain('Vendor pick');
    expect(r.text).toContain('Best price: **$42** (-12% ↓)');
    expect(r.text).toContain('66%');
    expect(r.text).toContain('• Acme');
    expect(r.buttons).toHaveLength(2);
    expect(r.buttons[0]![0]!.text).toBe('Pick Acme');
    // callback_data stays under Telegram's 64-byte cap.
    expect(r.buttons[0]![0]!.callbackData.length).toBeLessThanOrEqual(64);
  });

  it('GENUI-2: a tap resolves to the registered actionId and the typed event text', () => {
    const r = renderCanvasForTelegram('sess-1', PAYLOAD);
    const resolved = resolveTx13Callback(r.buttons[1]![0]!.callbackData)!;
    expect(resolved.actionId).toBe('pick:globex');
    expect(resolved.sessionId).toBe('sess-1');
    const text = canvasEventText(resolved.actionId);
    expect(text).toContain('[CANVAS EVENT]');
    expect(text).toContain('"actionId":"pick:globex"');
    expect(text).toContain('"kind":"canvas-event"');
  });

  it('GENUI-3: foreign prefixes and unknown tokens resolve null', () => {
    expect(resolveTx13Callback('tx10:cp:x:0')).toBeNull();
    expect(resolveTx13Callback(`${TX13_CALLBACK_PREFIX}nope`)).toBeNull();
  });

  it('GENUI-4: token registry caps at 500 (oldest evicted, newest resolves)', () => {
    let firstToken = '';
    for (let i = 0; i < 520; i++) {
      const t = registerActionToken('s', `a-${i}`);
      if (i === 0) firstToken = t;
    }
    expect(resolveTx13Callback(`${TX13_CALLBACK_PREFIX}${firstToken}`)).toBeNull();
    const last = registerActionToken('s', 'a-last');
    expect(resolveTx13Callback(`${TX13_CALLBACK_PREFIX}${last}`)!.actionId).toBe('a-last');
  });

  it('GENUI-5: tables and charts render bounded plain-text', () => {
    const r = renderCanvasForTelegram('s', {
      version: 1,
      components: [
        { type: 'table', columns: ['a', 'b'], rows: [['1', '2']] },
        { type: 'chart', chartType: 'bar', title: 'C', series: [{ label: 'x', value: 10 }, { label: 'y', value: 5 }] },
      ],
    });
    expect(r.text).toContain('a | b');
    expect(r.text).toContain('x: ▮▮▮▮▮▮▮▮▮▮▮▮ 10');
    expect(r.buttons).toHaveLength(0);
  });
});
