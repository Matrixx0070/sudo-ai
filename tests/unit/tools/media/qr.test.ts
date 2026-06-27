/**
 * Guards media.qr's wiring + input validation (the paths that return before any
 * browser launch). The QR encoding is the `qrcode` lib's; the SVG→PNG render is
 * verified out-of-band + live (chromium isn't launched in CI).
 */
import { describe, it, expect } from 'vitest';
import { qrTool } from '../../../../src/core/tools/builtin/media/tools/qr.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

const ctx = { sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console } as unknown as ToolContext;

describe('media.qr', () => {
  it('is registered as media.qr in the media category with required text param', () => {
    expect(qrTool.name).toBe('media.qr');
    expect(qrTool.category).toBe('media');
    expect(qrTool.parameters['text']?.required).toBe(true);
  });

  it('rejects empty text (before any render)', async () => {
    expect((await qrTool.execute({ text: '' }, ctx)).success).toBe(false);
    expect((await qrTool.execute({ text: '   ' }, ctx)).success).toBe(false);
  });

  it('rejects text beyond the QR capacity cap', async () => {
    const r = await qrTool.execute({ text: 'x'.repeat(2000) }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/too long/i);
  });

  it('describes itself as delivering an image so the agent uses it', () => {
    expect(qrTool.description).toMatch(/QR code/i);
    expect(qrTool.description).toMatch(/image|chat/i);
  });
});
