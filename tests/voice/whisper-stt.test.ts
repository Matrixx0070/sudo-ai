/**
 * Tests for the local Whisper ONNX STT provider and its wiring into SpeechToText.
 *
 * `@huggingface/transformers` and the ffmpeg subprocess are mocked so these run
 * without downloading model weights or shelling out to ffmpeg.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers: pipeline() -> a fake ASR function.
// ---------------------------------------------------------------------------

const asrMock = vi.fn();
const pipelineMock = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock node:child_process spawn: a fake ffmpeg emitting f32le PCM on stdout.
// ---------------------------------------------------------------------------

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

/** Fake ffmpeg child that emits `samples` as little-endian float32, then closes. */
function fakeFfmpeg(samples: Float32Array, exitCode = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (exitCode === 0) {
      child.stdout.emit('data', Buffer.from(samples.buffer.slice(0)));
    } else {
      child.stderr.emit('data', Buffer.from('boom: invalid audio'));
    }
    child.emit('close', exitCode);
  });
  return child;
}

function installFakeAsr(text = 'hello world'): void {
  asrMock.mockResolvedValue({ text });
  pipelineMock.mockResolvedValue(asrMock);
}

const WHISPER_ENV = ['SUDO_WHISPER_STT', 'SUDO_WHISPER_MODEL', 'SUDO_WHISPER_DTYPE', 'SUDO_WHISPER_DEVICE'];

describe('WhisperLocalSTT', () => {
  beforeEach(() => {
    vi.resetModules();
    asrMock.mockReset();
    pipelineMock.mockReset();
    spawnMock.mockReset();
    WHISPER_ENV.forEach((k) => delete process.env[k]);
    installFakeAsr();
    spawnMock.mockImplementation(() => fakeFfmpeg(new Float32Array(16_000))); // 1s @ 16kHz
  });

  afterEach(() => {
    WHISPER_ENV.forEach((k) => delete process.env[k]);
  });

  it('is available by default and disabled only by SUDO_WHISPER_STT=0', async () => {
    const { WhisperLocalSTT } = await import('../../src/core/voice/whisper-local.js');
    expect(new WhisperLocalSTT().available).toBe(true);

    process.env['SUDO_WHISPER_STT'] = '0';
    expect(new WhisperLocalSTT().available).toBe(false);
  });

  it('decodes audio and transcribes to text via the ONNX pipeline', async () => {
    const { WhisperLocalSTT } = await import('../../src/core/voice/whisper-local.js');
    const result = await new WhisperLocalSTT().transcribe(Buffer.from('fake-ogg-bytes'));

    expect(result.text).toBe('hello world');
    expect(result.confidence).toBe(1.0);
    expect(result.language).toBe('en');
    expect(result.durationMs).toBe(1000); // 16000 samples / 16000 Hz

    // Pipeline built with the default model on cpu, fed a Float32Array.
    expect(pipelineMock).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-base',
      { dtype: 'q8', device: 'cpu' },
    );
    expect(asrMock.mock.calls[0]?.[0]).toBeInstanceOf(Float32Array);
    expect((asrMock.mock.calls[0]?.[0] as Float32Array).length).toBe(16_000);
  });

  it('forwards a language hint to the pipeline', async () => {
    const { WhisperLocalSTT } = await import('../../src/core/voice/whisper-local.js');
    const result = await new WhisperLocalSTT().transcribe(Buffer.from('x'), { language: 'es' });

    expect(asrMock.mock.calls[0]?.[1]).toMatchObject({ language: 'es' });
    expect(result.language).toBe('es');
  });

  it('falls back to the cpu device when a non-cpu device fails to load', async () => {
    process.env['SUDO_WHISPER_DEVICE'] = 'cuda';
    pipelineMock
      .mockRejectedValueOnce(new Error('no CUDA device available'))
      .mockResolvedValueOnce(asrMock);

    const { WhisperLocalSTT } = await import('../../src/core/voice/whisper-local.js');
    const result = await new WhisperLocalSTT().transcribe(Buffer.from('x'));

    expect(result.text).toBe('hello world');
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(pipelineMock.mock.calls[0]?.[2]).toMatchObject({ device: 'cuda' });
    expect(pipelineMock.mock.calls[1]?.[2]).toMatchObject({ device: 'cpu' });
  });

  it('throws an actionable error when ffmpeg decoding fails', async () => {
    spawnMock.mockImplementation(() => fakeFfmpeg(new Float32Array(0), 1));
    const { WhisperLocalSTT } = await import('../../src/core/voice/whisper-local.js');
    await expect(new WhisperLocalSTT().transcribe(Buffer.from('x'))).rejects.toThrow(/decode failed/);
  });

  it('rejects an empty buffer', async () => {
    const { WhisperLocalSTT } = await import('../../src/core/voice/whisper-local.js');
    await expect(new WhisperLocalSTT().transcribe(Buffer.alloc(0))).rejects.toThrow(/non-empty Buffer/);
  });
});

describe('SpeechToText local-first routing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    asrMock.mockReset();
    pipelineMock.mockReset();
    spawnMock.mockReset();
    // A cloud key is set to prove it is NOT used while cloud STT is disabled.
    process.env['GROQ_API_KEY'] = 'gsk-test';
    delete process.env['ELEVENLABS_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['SUDO_STT_CLOUD'];
    WHISPER_ENV.forEach((k) => delete process.env[k]);
    installFakeAsr();
    spawnMock.mockImplementation(() => fakeFfmpeg(new Float32Array(16_000)));

    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'cloud transcript', language: 'en' }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env['GROQ_API_KEY'];
    delete process.env['SUDO_STT_CLOUD'];
    WHISPER_ENV.forEach((k) => delete process.env[k]);
    vi.unstubAllGlobals();
  });

  it('defaults to local Whisper even when a cloud key is present', async () => {
    const { SpeechToText } = await import('../../src/core/voice/stt.js');
    const result = await new SpeechToText().transcribe(Buffer.from('audio'));

    expect(result.text).toBe('hello world'); // local mock, not 'cloud transcript'
    expect(asrMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes a requested cloud provider to local Whisper while cloud is disabled', async () => {
    const { SpeechToText } = await import('../../src/core/voice/stt.js');
    const result = await new SpeechToText().transcribe(Buffer.from('audio'), { provider: 'groq' });

    expect(result.text).toBe('hello world');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses cloud STT (Groq) when SUDO_STT_CLOUD=1', async () => {
    process.env['SUDO_STT_CLOUD'] = '1';
    const { SpeechToText } = await import('../../src/core/voice/stt.js');
    const result = await new SpeechToText().transcribe(Buffer.from('audio'));

    expect(result.text).toBe('cloud transcript');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(asrMock).not.toHaveBeenCalled();
  });
});
