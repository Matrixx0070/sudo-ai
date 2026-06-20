/**
 * meta.voice — Voice Engine tool.
 *
 * Actions:
 *   speak      — Synthesize text to speech; returns audio file path.
 *   transcribe — Transcribe an audio file to text.
 *   voices     — List all known voice names.
 *   call       — Initiate an outbound phone call (Twilio).
 *   history    — Return recent voice message history.
 */

import { VoiceEngine } from '../../../voice/voice-engine.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-voice-engine');

const DB_PATH      = MIND_DB;
const DEFAULT_VOICE = 'af_heart'; // local Kokoro default
const DEFAULT_LANG  = 'en-US';

// ---------------------------------------------------------------------------
// Lazy singleton engine
// ---------------------------------------------------------------------------

let _engine: VoiceEngine | null = null;

function getEngine(): VoiceEngine {
  if (!_engine) {
    _engine = new VoiceEngine(
      { defaultVoice: DEFAULT_VOICE, speed: 1.0, pitch: 1.0, language: DEFAULT_LANG },
      DB_PATH,
    );
  }
  return _engine;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const voiceEngineTool: ToolDefinition = {
  name: 'meta.voice',
  description:
    'Voice Engine: synthesize text to speech (TTS), transcribe audio files (STT), manage voice library, initiate outbound phone calls, and review voice message history. Synthesis defaults to local Kokoro (ONNX, key-free, offline); cloud TTS (ElevenLabs/xAI/OpenAI) is disabled unless SUDO_TTS_CLOUD=1. Transcription uses OpenAI Whisper. Phone calling requires Twilio credentials.',
  category: 'meta',
  timeout: 90_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['speak', 'transcribe', 'voices', 'call', 'history'],
    },
    text: {
      type: 'string',
      description: '[speak] Text to synthesize (max 4096 chars).',
    },
    voice: {
      type: 'string',
      description: '[speak] Voice override (e.g. "alloy", "nova", "rex", ElevenLabs voice ID).',
    },
    outputPath: {
      type: 'string',
      description: '[speak] Optional absolute path for the output audio file.',
    },
    audioPath: {
      type: 'string',
      description: '[transcribe] Absolute path to the audio file to transcribe.',
    },
    phoneNumber: {
      type: 'string',
      description: '[call] Destination phone number in E.164 format (e.g. +14155552671).',
    },
    callMessage: {
      type: 'string',
      description: '[call] Text to speak when the call is answered.',
    },
    limit: {
      type: 'number',
      description: '[history] Max number of records to return (default 10).',
      default: 10,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.voice invoked');

    try {
      const engine = getEngine();

      switch (action) {
        // -------------------------------------------------------------------
        case 'speak': {
          const text  = params['text'] as string | undefined;
          const voice = params['voice'] as string | undefined;
          const out   = params['outputPath'] as string | undefined;

          if (!text?.trim()) {
            return { success: false, output: 'text is required for speak.' };
          }

          const msg = await engine.synthesize(text, voice, out);

          return {
            success: true,
            output: msg.audioPath
              ? `Audio synthesized: ${msg.audioPath} (voice: ${msg.voice}, ~${Math.round((msg.duration ?? 0) / 1000)}s)`
              : `TTS recorded (no audio file — provider unavailable). Message ID: ${msg.id}`,
            data: msg,
            artifacts: msg.audioPath
              ? [{ path: msg.audioPath, action: 'created' as const }]
              : [],
          };
        }

        // -------------------------------------------------------------------
        case 'transcribe': {
          const audioPath = params['audioPath'] as string | undefined;
          if (!audioPath?.trim()) {
            return { success: false, output: 'audioPath is required for transcribe.' };
          }

          const text = await engine.transcribe(audioPath);
          return {
            success: true,
            output:  text || '(no speech detected)',
            data:    { text, audioPath },
            artifacts: [{ path: audioPath, action: 'read' as const }],
          };
        }

        // -------------------------------------------------------------------
        case 'voices': {
          const voices = engine.listVoices();
          return {
            success: true,
            output:  `${voices.length} known voices:\n${voices.join(', ')}`,
            data:    { voices },
          };
        }

        // -------------------------------------------------------------------
        case 'call': {
          const phoneNumber  = params['phoneNumber'] as string | undefined;
          const callMessage  = params['callMessage'] as string | undefined;

          if (!phoneNumber?.trim()) {
            return { success: false, output: 'phoneNumber is required for call.' };
          }
          if (!callMessage?.trim()) {
            return { success: false, output: 'callMessage is required for call.' };
          }

          const result = await engine.callPhone(phoneNumber, callMessage);
          return {
            success: result.success,
            output:  result.success
              ? `Call initiated to ${phoneNumber}. Call ID: ${result.callId ?? 'unknown'}`
              : `Call to ${phoneNumber} could not be placed (Twilio unavailable or credentials missing).`,
            data: result,
          };
        }

        // -------------------------------------------------------------------
        case 'history': {
          const limit = Math.max(1, Math.min(100, (params['limit'] as number | undefined) ?? 10));
          const msgs  = engine.getRecentMessages(limit);
          const lines = msgs.map((m) =>
            `[${m.createdAt}] voice=${m.voice} len=${m.text.length} ${m.audioPath ? 'audio:✓' : 'audio:✗'}`,
          );
          return {
            success: true,
            output:  msgs.length > 0
              ? `${msgs.length} message(s):\n${lines.join('\n')}`
              : 'No voice messages in history.',
            data: { messages: msgs },
          };
        }

        // -------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.voice error');
      return { success: false, output: `Voice engine error: ${msg}` };
    }
  },
};
