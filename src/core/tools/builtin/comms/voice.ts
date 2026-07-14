/**
 * @file voice.ts
 * @description comms.voice — TTS (text-to-speech) and STT (speech-to-text)
 * via OpenAI audio APIs (tts-1 and Whisper).
 *
 * Environment variables consumed:
 *   OPENAI_API_KEY — required for all operations.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { toolFetch } from '../../../security/guarded-fetch.js';
import { getProviderApiKey, type ProviderKeyName } from '../../../../llm/client.js';
import { XAI_TTS_URL, OPENAI_TTS_URL, OPENAI_STT_URL } from '../../../../llm/endpoints.js';

const log = createLogger('comms:voice');

// TTS/STT providers — try xAI first, fallback to OpenAI (caller 'tool:comms-voice').
// Requests stay on toolFetch (the SSRF guard); only the URL/key source moved to src/llm.
const TTS_PROVIDERS: Array<{ name: string; url: string; key: ProviderKeyName; model: string; voices: string[] }> = [
  { name: 'xai', url: XAI_TTS_URL, key: 'xai', model: 'tts-1', voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
  { name: 'openai', url: OPENAI_TTS_URL, key: 'openai', model: 'tts-1', voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
];
const STT_PROVIDERS: Array<{ name: string; url: string; key: ProviderKeyName; model: string }> = [
  { name: 'openai', url: OPENAI_STT_URL, key: 'openai', model: 'whisper-1' },
  // xAI doesn't have STT yet — OpenAI only for now
];
const DEFAULT_OUTPUT = 'data/voice/output.mp3';
const VALID_VOICES   = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);

/** Extract the error message from an OpenAI JSON error response. */
async function extractApiError(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j.error?.message ?? fallback;
  } catch { return fallback; }
}

export const voiceTool: ToolDefinition = {
  name: 'comms.voice',
  description:
    'Convert text to speech audio (TTS) or transcribe audio to text (STT). ' +
    'Uses OpenAI tts-1 and Whisper. ' +
    'For tts: provide "text", optionally "outputPath" and "voice". ' +
    'For stt: provide "audioPath".',
  category: 'comms',
  timeout: 120_000,
  parameters: {
    operation: {
      type: 'string', required: true,
      enum: ['tts', 'stt'],
      description: 'tts = text to speech, stt = speech to text (Whisper).',
    },
    text: {
      type: 'string', required: false,
      description: 'Text to synthesize. Required for tts.',
    },
    audioPath: {
      type: 'string', required: false,
      description: 'Absolute path to audio file to transcribe. Required for stt.',
    },
    outputPath: {
      type: 'string', required: false, default: DEFAULT_OUTPUT,
      description: `Destination path for generated MP3 (tts). Default: "${DEFAULT_OUTPUT}".`,
    },
    voice: {
      type: 'string', required: false, default: 'alloy',
      enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      description: 'OpenAI TTS voice. Default: alloy.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = typeof params['operation'] === 'string' ? params['operation'] : '';
    if (operation !== 'tts' && operation !== 'stt') {
      return { success: false, output: 'comms.voice: "operation" must be "tts" or "stt".' };
    }

    // -----------------------------------------------------------------------
    // TTS
    // -----------------------------------------------------------------------
    if (operation === 'tts') {
      const ttsProvider = TTS_PROVIDERS.find(p => getProviderApiKey(p.key));
      if (!ttsProvider) {
        return { success: false, output: 'comms.voice: No API key set. Set XAI_API_KEY or OPENAI_API_KEY.' };
      }
      const apiKey = getProviderApiKey(ttsProvider.key)!;
      log.info({ provider: ttsProvider.name }, 'Using TTS provider');

      const text = typeof params['text'] === 'string' ? params['text'].trim() : '';
      if (!text) return { success: false, output: 'comms.voice: "text" is required for tts.' };
      if (text.length > 4096) {
        return { success: false, output: `comms.voice: "text" exceeds 4096 characters (${text.length}). Split into chunks.` };
      }

      const rawVoice = typeof params['voice'] === 'string' ? params['voice'] : 'alloy';
      const voice    = VALID_VOICES.has(rawVoice) ? rawVoice : 'alloy';
      const outRaw   = typeof params['outputPath'] === 'string' && params['outputPath'].trim()
        ? params['outputPath'].trim() : DEFAULT_OUTPUT;
      const absOut   = path.isAbsolute(outRaw) ? outRaw : path.join(process.cwd(), outRaw);

      log.info({ sessionId: ctx.sessionId, voice, absOut, textLength: text.length }, 'TTS request');

      try {
        const res = await toolFetch(ttsProvider.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: ttsProvider.model, input: text, voice }),
          signal: ctx.signal,
        });

        if (!res.ok) {
          const errMsg = await extractApiError(res, `HTTP ${res.status}`);
          throw new Error(`${ttsProvider.name} TTS: ${errMsg}`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        await fs.mkdir(path.dirname(absOut), { recursive: true });
        await fs.writeFile(absOut, buf);

        log.info({ sessionId: ctx.sessionId, absOut, sizeBytes: buf.byteLength }, 'TTS complete');
        return {
          success: true,
          output: `Audio saved to ${absOut} (${buf.byteLength} bytes, voice: ${voice}).`,
          data: { path: absOut, sizeBytes: buf.byteLength, voice, textLength: text.length },
          artifacts: [{ path: absOut, action: 'created', size: buf.byteLength }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ sessionId: ctx.sessionId, err }, 'TTS failed');
        return { success: false, output: `comms.voice tts error: ${msg}` };
      }
    }

    // -----------------------------------------------------------------------
    // STT
    // -----------------------------------------------------------------------
    const audioPath = typeof params['audioPath'] === 'string' ? params['audioPath'].trim() : '';
    if (!audioPath) return { success: false, output: 'comms.voice: "audioPath" is required for stt.' };

    try { await fs.access(audioPath); } catch {
      return { success: false, output: `comms.voice: audio file not found at "${audioPath}".` };
    }

    const sttProvider = STT_PROVIDERS.find(p => getProviderApiKey(p.key));
    if (!sttProvider) {
      return { success: false, output: 'comms.voice: No STT API key set. Set OPENAI_API_KEY.' };
    }
    const sttApiKey = getProviderApiKey(sttProvider.key)!;

    log.info({ sessionId: ctx.sessionId, audioPath, provider: sttProvider.name }, 'STT request');

    try {
      const audioBuf  = await fs.readFile(audioPath);
      const formData  = new FormData();
      formData.append('model', sttProvider.model);
      formData.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), path.basename(audioPath));

      const res = await toolFetch(sttProvider.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sttApiKey}` },
        body: formData,
        signal: ctx.signal,
      });

      if (!res.ok) {
        const errMsg = await extractApiError(res, `HTTP ${res.status}`);
        throw new Error(`OpenAI Whisper: ${errMsg}`);
      }

      const json       = (await res.json()) as { text?: string };
      const transcript = json.text ?? '(no transcription returned)';

      log.info({ sessionId: ctx.sessionId, audioPath, transcriptLength: transcript.length }, 'STT complete');
      return {
        success: true,
        output: transcript,
        data: { audioPath, transcriptLength: transcript.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, audioPath, err }, 'STT failed');
      return { success: false, output: `comms.voice stt error: ${msg}` };
    }
  },
};

export default voiceTool;
