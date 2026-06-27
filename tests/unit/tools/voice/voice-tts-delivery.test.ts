/**
 * Guards the voice-reply wiring: voice.tts must emit an output the agent loop's
 * file-attachment extractor (loop.ts FILE_PATH_PATTERN + TOOL_NAMES_PRODUCING_FILES)
 * turns into an `audio` attachment, so synthesized speech is delivered to the chat.
 * Kokoro is mocked so the test doesn't download the ONNX model.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

vi.mock('../../../../src/core/voice/tts.js', () => ({
  TextToSpeech: class {
    async synthesize() {
      return { audioBuffer: Buffer.from('RIFFfakeWAV'), format: 'wav', durationMs: 2000 };
    }
  },
}));

import { VOICE_TOOLS } from '../../../../src/core/tools/builtin/voice/index.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

// Mirror of loop.ts FILE_PATH_PATTERN — KEEP IN SYNC with src/core/agent/loop.ts.
// voice.tts relies on this exact contract to have its audio delivered.
const FILE_PATH_PATTERN = /(?:saved?(?:\s+to)?|path)[:\s]+([^\s\n"']+\.(?:png|jpg|jpeg|gif|webp|pdf|mp4|mov|avi|mp3|wav|ogg))/gi;

const ttsTool = VOICE_TOOLS.find((t) => t.name === 'voice.tts')!;
const ctx = { sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console } as unknown as ToolContext;

describe('voice.tts — delivers synthesized speech to the chat', () => {
  it('emits an output the loop extracts as an audio attachment path', async () => {
    const outPath = join(tmpdir(), `voice-tts-test-${Date.now()}.wav`);
    const res = await ttsTool.execute({ text: 'hello there', outputPath: outPath }, ctx);
    expect(res.success).toBe(true);

    FILE_PATH_PATTERN.lastIndex = 0;
    const m = FILE_PATH_PATTERN.exec(res.output);
    expect(m?.[1]).toBe(outPath);            // path is extractable
    expect(outPath.endsWith('.wav')).toBe(true); // .wav → attachment type 'audio'

    if (existsSync(outPath)) rmSync(outPath, { force: true });
  });

  it('describes itself as delivering voice (so the agent uses it to reply with voice)', () => {
    expect(ttsTool.description).toMatch(/voice note|deliver/i);
  });
});
