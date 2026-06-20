/**
 * Voice toolkit — registers 3 voice tools into the ToolRegistry.
 *
 * Tools registered:
 *   voice.tts         — Text-to-speech synthesis (ElevenLabs / xAI / OpenAI)
 *   voice.stt         — Speech-to-text transcription via OpenAI Whisper
 *   voice.phone-call  — Outbound phone calls and call history via Twilio
 */

import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('voice-builtin');

// ---------------------------------------------------------------------------
// voice.tts
// ---------------------------------------------------------------------------

const ttsTool: ToolDefinition = {
  name: 'voice.tts',
  description:
    'Convert text to speech audio. Default is the local Kokoro (ONNX) provider — offline, no API key. Cloud providers (ElevenLabs/xAI/OpenAI) are disabled unless SUDO_TTS_CLOUD=1. Saves the audio file and returns the path.',
  category: 'voice',
  timeout: 60_000,
  parameters: {
    text: {
      type: 'string',
      required: true,
      description: 'Text to synthesise into speech (max 4096 characters).',
    },
    provider: {
      type: 'string',
      description: 'TTS provider. Defaults to local "kokoro". Cloud providers (elevenlabs/xai/openai) only work when SUDO_TTS_CLOUD=1, otherwise they fall back to kokoro.',
      enum: ['kokoro', 'elevenlabs', 'xai', 'openai'],
    },
    voice: {
      type: 'string',
      description: 'Voice ID or name. Provider-specific (e.g. ElevenLabs voice ID, xAI "rex", OpenAI "alloy", Kokoro "af_heart").',
    },
    outputPath: {
      type: 'string',
      description: 'Absolute path to write the audio file to (default: /tmp/sudo-ai-tts-<timestamp>.mp3).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = params['text'] as string | undefined;
    const provider = params['provider'] as 'elevenlabs' | 'xai' | 'openai' | undefined;
    const voice = params['voice'] as string | undefined;

    logger.info({ session: ctx.sessionId, provider, textLen: text?.length }, 'voice.tts invoked');

    if (!text?.trim()) return { success: false, output: 'text is required.' };
    if (text.length > 4096) return { success: false, output: 'text must be 4096 characters or fewer.' };

    try {
      const { TextToSpeech } = await import('../../../voice/tts.js');
      const tts = new TextToSpeech();
      const result = await tts.synthesize(text, { provider, voice });

      const outPath = (params['outputPath'] as string | undefined) ??
        join('/tmp', `sudo-ai-tts-${Date.now()}.${result.format}`);

      await writeFile(outPath, result.audioBuffer);

      logger.info({ outPath, durationMs: result.durationMs, format: result.format }, 'TTS synthesis complete');
      return {
        success: true,
        output: `Audio synthesised: ${outPath} (${result.format}, ~${Math.round(result.durationMs / 1000)}s)`,
        data: { path: outPath, format: result.format, durationMs: result.durationMs, bytes: result.audioBuffer.length },
        artifacts: [{ path: outPath, action: 'created', size: result.audioBuffer.length }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'voice.tts error');
      return { success: false, output: `TTS error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// voice.stt
// ---------------------------------------------------------------------------

const sttTool: ToolDefinition = {
  name: 'voice.stt',
  description:
    'Transcribe an audio file to text using Whisper. Default is the local Whisper (ONNX) provider — offline, no API key. Cloud Whisper (Groq/ElevenLabs/OpenAI) is disabled unless SUDO_STT_CLOUD=1. Supports mp3, wav, ogg, webm, m4a formats.',
  category: 'voice',
  timeout: 60_000,
  parameters: {
    audioPath: {
      type: 'string',
      required: true,
      description: 'Absolute path to the audio file to transcribe.',
    },
    language: {
      type: 'string',
      description: 'BCP-47 language code hint (e.g. "en", "hi", "ur"). Omit for auto-detection.',
    },
    model: {
      type: 'string',
      description: 'Whisper model to use (default: whisper-1).',
      default: 'whisper-1',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const audioPath = params['audioPath'] as string | undefined;
    const language = params['language'] as string | undefined;
    const model = params['model'] as string | undefined;

    logger.info({ session: ctx.sessionId, audioPath }, 'voice.stt invoked');

    if (!audioPath?.trim()) return { success: false, output: 'audioPath is required.' };

    let audioBuffer: Buffer;
    try {
      audioBuffer = await readFile(audioPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ audioPath, err: msg }, 'voice.stt: failed to read audio file');
      return { success: false, output: `Cannot read audio file: ${msg}` };
    }

    if (audioBuffer.length === 0) {
      return { success: false, output: 'Audio file is empty.' };
    }

    try {
      const { SpeechToText } = await import('../../../voice/stt.js');
      const stt = new SpeechToText();
      const result = await stt.transcribe(audioBuffer, { language, model });

      logger.info({ audioPath, textLen: result.text.length, language: result.language }, 'STT transcription complete');
      return {
        success: true,
        output: result.text || '(no speech detected)',
        data: { text: result.text, language: result.language, confidence: result.confidence, durationMs: result.durationMs },
        artifacts: [{ path: audioPath, action: 'read' }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ audioPath, err: msg }, 'voice.stt error');
      return { success: false, output: `STT error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// voice.phone-call
// ---------------------------------------------------------------------------

const phoneCallTool: ToolDefinition = {
  name: 'voice.phone-call',
  description:
    'Make outbound phone calls via Twilio, check call status, and view call history. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER env vars.',
  category: 'voice',
  requiresConfirmation: true,
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['make-call', 'get-history', 'check-available'],
    },
    to: {
      type: 'string',
      description: 'Destination phone number in E.164 format (e.g. +14155552671). Required for make-call.',
    },
    message: {
      type: 'string',
      description: 'Text message to speak when the call is answered. Required for make-call.',
    },
    limit: {
      type: 'number',
      description: 'Max number of call history records to return (default: 10).',
      default: 10,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'voice.phone-call invoked');

    try {
      const { PhoneCallManager } = await import('../../../voice/phone-call.js');
      const mgr = new PhoneCallManager();

      switch (action) {
        case 'check-available': {
          return {
            success: true,
            output: mgr.available
              ? 'Phone call service is available (Twilio credentials configured).'
              : 'Phone call service is NOT available — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.',
            data: { available: mgr.available },
          };
        }

        case 'make-call': {
          const to = params['to'] as string | undefined;
          const message = params['message'] as string | undefined;
          if (!to?.trim()) return { success: false, output: 'to (E.164 number) is required for make-call.' };
          if (!message?.trim()) return { success: false, output: 'message is required for make-call.' };
          const record = await mgr.makeCall(to, message);
          logger.warn({ to, sid: record.sid }, 'Outbound call initiated');
          return {
            success: true,
            output: `Call initiated to ${to}. SID: ${record.sid}, State: ${record.state}`,
            data: record,
          };
        }

        case 'get-history': {
          const limit = (params['limit'] as number | undefined) ?? 10;
          const history = mgr.getCallHistory(limit);
          return {
            success: true,
            output: history.length > 0
              ? `${history.length} call(s) in history: ${history.map((c) => `${c.to} (${c.state})`).join(', ')}`
              : 'No call history.',
            data: history,
          };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'voice.phone-call error');
      return { success: false, output: `Phone call error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const VOICE_TOOLS: ToolDefinition[] = [
  ttsTool,
  sttTool,
  phoneCallTool,
];

/**
 * Register all voice tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerVoiceTools(registry: ToolRegistry): void {
  logger.info({ count: VOICE_TOOLS.length }, 'Registering voice tools');
  for (const tool of VOICE_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: VOICE_TOOLS.length }, 'Voice tools registered');
}
