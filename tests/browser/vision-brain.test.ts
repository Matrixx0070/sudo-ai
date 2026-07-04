/**
 * @file vision-brain.test.ts
 * @description browser.vision now prefers the agent's Brain (multimodal) over the
 * standalone HTTP providers (Phase 4 #7). Verifies Brain-first routing and clean
 * fallback when the Brain fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visionTool } from '../../src/core/tools/builtin/browser/vision.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const imgPath = join(tmpdir(), `sudo-vision-${process.pid}.png`);

function ctxWith(brain: unknown): ToolContext {
  return { sessionId: 't', workingDir: '.', config: { brain }, logger: console } as unknown as ToolContext;
}

describe('browser.vision Brain routing', () => {
  const savedXai = process.env['XAI_API_KEY'];
  const savedOpenai = process.env['OPENAI_API_KEY'];

  beforeAll(() => {
    writeFileSync(imgPath, Buffer.from(PNG_B64, 'base64'));
    // Remove keys so the HTTP fallback is deterministic (no network).
    delete process.env['XAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  afterAll(() => {
    try { unlinkSync(imgPath); } catch { /* ignore */ }
    if (savedXai !== undefined) process.env['XAI_API_KEY'] = savedXai;
    if (savedOpenai !== undefined) process.env['OPENAI_API_KEY'] = savedOpenai;
  });

  it('uses the Brain when available and returns its answer', async () => {
    let received: { images?: unknown[]; inputModalities?: unknown } | null = null;
    const brain = {
      call: async (req: { messages: Array<{ images?: unknown[] }>; inputModalities?: unknown }) => {
        received = { images: req.messages[0]?.images, inputModalities: req.inputModalities };
        return { content: 'A single red button labelled Submit.' };
      },
    };
    const res = await visionTool.execute({ imagePath: imgPath, question: 'What is shown?' }, ctxWith(brain));
    expect(res.success).toBe(true);
    expect(res.output).toContain('red button');
    expect((res.data as { provider?: string }).provider).toBe('brain');
    // The image was actually passed as a multimodal input.
    expect(received!.images).toHaveLength(1);
    expect(received!.inputModalities).toContain('image');
  });

  it('falls back cleanly when the Brain throws and no HTTP keys are set', async () => {
    const brain = { call: async () => { throw new Error('brain down'); } };
    const res = await visionTool.execute({ imagePath: imgPath, question: 'What is shown?' }, ctxWith(brain));
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/all vision providers failed/i);
  });
});
