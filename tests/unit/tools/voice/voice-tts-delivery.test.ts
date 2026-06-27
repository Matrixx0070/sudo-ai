/**
 * Guards the voice-reply wiring: voice.tts must emit an output the agent loop's
 * file-attachment extractor (file-attachments.ts extractFileAttachments) turns
 * into an `audio` attachment, so synthesized speech is delivered to the chat.
 * Uses the REAL extractor (not a mirror) so the contract can't silently drift.
 * Kokoro is mocked so the test doesn't download the ONNX model.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { extractFileAttachments } from '../../../../src/core/agent/file-attachments.js';

vi.mock('../../../../src/core/voice/tts.js', () => ({
  TextToSpeech: class {
    async synthesize() {
      return { audioBuffer: Buffer.from('RIFFfakeWAV'), format: 'wav', durationMs: 2000 };
    }
  },
}));

import { VOICE_TOOLS } from '../../../../src/core/tools/builtin/voice/index.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

const ttsTool = VOICE_TOOLS.find((t) => t.name === 'voice.tts')!;
const ctx = { sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console } as unknown as ToolContext;

describe('voice.tts — delivers synthesized speech to the chat', () => {
  it('emits an output the loop extracts as an audio attachment path', async () => {
    const outPath = join(tmpdir(), `voice-tts-test-${Date.now()}.wav`);
    const res = await ttsTool.execute({ text: 'hello there', outputPath: outPath }, ctx);
    expect(res.success).toBe(true);

    const atts = extractFileAttachments('voice.tts', res.output);
    expect(atts).toEqual([{ type: 'audio', path: outPath, filename: outPath.split('/').pop() }]);

    if (existsSync(outPath)) rmSync(outPath, { force: true });
  });

  it('describes itself as delivering voice (so the agent uses it to reply with voice)', () => {
    expect(ttsTool.description).toMatch(/voice note|deliver/i);
  });
});
