/**
 * Tests for the local Kokoro ONNX TTS provider and its wiring into TextToSpeech.
 *
 * `kokoro-js` is mocked so these run without downloading model weights.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock kokoro-js: a fake model that records generate() calls and emits a WAV.
// ---------------------------------------------------------------------------

const generateMock = vi.fn();
const fromPretrainedMock = vi.fn();

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: (...args: unknown[]) => fromPretrainedMock(...args),
  },
}));

/** Build a minimal WAV (44-byte header + N data bytes) ArrayBuffer. */
function fakeWav(dataBytes: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + dataBytes);
  return buf;
}

function installFakeModel(voices: string[] = ['af_heart', 'am_adam']): void {
  const model = {
    voices: Object.fromEntries(voices.map((v) => [v, {}])),
    generate: generateMock,
  };
  generateMock.mockResolvedValue({ toWav: () => fakeWav(48_000) }); // ~1s of 24kHz/16-bit audio
  fromPretrainedMock.mockResolvedValue(model);
}

describe('KokoroLocalTTS', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    fromPretrainedMock.mockReset();
    delete process.env['SUDO_KOKORO_TTS'];
    delete process.env['SUDO_KOKORO_VOICE'];
    installFakeModel();
  });

  afterEach(() => {
    delete process.env['SUDO_KOKORO_TTS'];
    delete process.env['SUDO_KOKORO_VOICE'];
  });

  it('is not available for auto-selection unless SUDO_KOKORO_TTS is enabled', async () => {
    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    expect(new KokoroLocalTTS().available).toBe(false);

    process.env['SUDO_KOKORO_TTS'] = '1';
    expect(new KokoroLocalTTS().available).toBe(true);
  });

  it('synthesizes a WAV buffer using the configured default voice', async () => {
    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    const tts = new KokoroLocalTTS();
    const buf = await tts.synthesize('hello world');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(44 + 48_000);
    expect(generateMock).toHaveBeenCalledWith('hello world', { voice: 'af_heart', speed: 1.0 });
  });

  it('falls back to the default voice when an unknown voice is requested', async () => {
    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    const tts = new KokoroLocalTTS();
    await tts.synthesize('hi', { voice: 'alloy' }); // alloy is an OpenAI voice, not Kokoro

    expect(generateMock).toHaveBeenCalledWith('hi', { voice: 'af_heart', speed: 1.0 });
  });

  it('passes through a valid Kokoro voice and clamps speed', async () => {
    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    const tts = new KokoroLocalTTS();
    await tts.synthesize('hi', { voice: 'am_adam', speed: 5 });

    expect(generateMock).toHaveBeenCalledWith('hi', { voice: 'am_adam', speed: 2.0 });
  });

  it('lists available voice ids', async () => {
    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    const voices = await new KokoroLocalTTS().listVoices();
    expect(voices).toEqual(['af_heart', 'am_adam']);
  });

  it('rejects empty text', async () => {
    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    await expect(new KokoroLocalTTS().synthesize('')).rejects.toThrow(/non-empty string/);
  });
});

describe('TextToSpeech kokoro routing', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    fromPretrainedMock.mockReset();
    delete process.env['ELEVENLABS_API_KEY'];
    delete process.env['XAI_VOICE_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['SUDO_KOKORO_TTS'];
    installFakeModel();
  });

  afterEach(() => {
    delete process.env['SUDO_KOKORO_TTS'];
  });

  it('routes provider:"kokoro" to the local model and returns wav format', async () => {
    const { TextToSpeech } = await import('../../src/core/voice/tts.js');
    const result = await new TextToSpeech().synthesize('hello', { provider: 'kokoro' });

    expect(result.format).toBe('wav');
    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
    expect(result.durationMs).toBe(1000); // 48000 data bytes / 48000 bytes-per-sec
    expect(fromPretrainedMock).toHaveBeenCalled();
  });

  it('auto-selects kokoro when no cloud keys are set and SUDO_KOKORO_TTS=1', async () => {
    process.env['SUDO_KOKORO_TTS'] = '1';
    const { TextToSpeech } = await import('../../src/core/voice/tts.js');
    const result = await new TextToSpeech().synthesize('hello');

    expect(result.format).toBe('wav');
    expect(generateMock).toHaveBeenCalled();
  });
});
