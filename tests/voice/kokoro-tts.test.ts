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
    delete process.env['SUDO_KOKORO_DEVICE'];
    installFakeModel();
  });

  afterEach(() => {
    delete process.env['SUDO_KOKORO_TTS'];
    delete process.env['SUDO_KOKORO_VOICE'];
    delete process.env['SUDO_KOKORO_DEVICE'];
  });

  it('is available by default and disabled only by SUDO_KOKORO_TTS=0', async () => {
    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    expect(new KokoroLocalTTS().available).toBe(true);

    process.env['SUDO_KOKORO_TTS'] = '0';
    expect(new KokoroLocalTTS().available).toBe(false);
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

  it('falls back to the cpu device when a non-cpu device fails to load', async () => {
    process.env['SUDO_KOKORO_DEVICE'] = 'cuda';
    const model = {
      voices: { af_heart: {} },
      generate: generateMock,
    };
    generateMock.mockResolvedValue({ toWav: () => fakeWav(48_000) });
    fromPretrainedMock
      .mockRejectedValueOnce(new Error('no CUDA device available'))
      .mockResolvedValueOnce(model);

    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    const buf = await new KokoroLocalTTS().synthesize('hello');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(fromPretrainedMock).toHaveBeenCalledTimes(2);
    // First attempt uses the configured cuda device, second falls back to cpu.
    expect(fromPretrainedMock.mock.calls[0]?.[1]).toMatchObject({ device: 'cuda' });
    expect(fromPretrainedMock.mock.calls[1]?.[1]).toMatchObject({ device: 'cpu' });

    delete process.env['SUDO_KOKORO_DEVICE'];
  });

  it('does not retry when the configured device is already cpu, and throws an actionable error', async () => {
    fromPretrainedMock.mockRejectedValue(new Error('native binding boom'));

    const { KokoroLocalTTS } = await import('../../src/core/voice/kokoro.js');
    await expect(new KokoroLocalTTS().synthesize('hello')).rejects.toThrow(/approve-builds/);
    expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
    expect(fromPretrainedMock.mock.calls[0]?.[1]).toMatchObject({ device: 'cpu' });
  });
});

describe('TextToSpeech local-only routing', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    fromPretrainedMock.mockReset();
    // A cloud key is set to prove it is NOT used while cloud TTS is disabled.
    process.env['OPENAI_API_KEY'] = 'sk-test';
    delete process.env['ELEVENLABS_API_KEY'];
    delete process.env['XAI_VOICE_API_KEY'];
    delete process.env['SUDO_KOKORO_TTS'];
    delete process.env['SUDO_TTS_CLOUD'];
    installFakeModel();
  });

  afterEach(() => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['SUDO_KOKORO_TTS'];
    delete process.env['SUDO_TTS_CLOUD'];
  });

  it('defaults to local kokoro (wav) even when a cloud key is present', async () => {
    const { TextToSpeech } = await import('../../src/core/voice/tts.js');
    const result = await new TextToSpeech().synthesize('hello');

    expect(result.format).toBe('wav');
    expect(result.durationMs).toBe(1000); // 48000 data bytes / 48000 bytes-per-sec
    expect(generateMock).toHaveBeenCalled();
  });

  it('falls back to kokoro when a cloud provider is requested but SUDO_TTS_CLOUD is off', async () => {
    const { TextToSpeech } = await import('../../src/core/voice/tts.js');
    const result = await new TextToSpeech().synthesize('hello', { provider: 'openai' });

    expect(result.format).toBe('wav'); // routed to local kokoro, not OpenAI mp3
    expect(generateMock).toHaveBeenCalled();
  });

  it('routes provider:"kokoro" to the local model', async () => {
    const { TextToSpeech } = await import('../../src/core/voice/tts.js');
    const result = await new TextToSpeech().synthesize('hello', { provider: 'kokoro' });

    expect(result.format).toBe('wav');
    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
    expect(fromPretrainedMock).toHaveBeenCalled();
  });
});
