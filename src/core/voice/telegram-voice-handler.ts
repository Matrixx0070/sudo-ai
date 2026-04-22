/**
 * TelegramVoiceHandler — intercepts Telegram voice/audio messages,
 * downloads the audio file via the Bot API, transcribes it using
 * SpeechToText, and feeds the resulting text into the normal message flow.
 *
 * Attach this by calling attachVoiceHandler(bot, stt, onTranscribed).
 * The onTranscribed callback receives the same payload structure as a text
 * message so the rest of the pipeline needs no changes.
 */

import type { Bot, Context } from 'grammy';
import { createLogger } from '../shared/logger.js';
import { SpeechToText } from './stt.js';

const log = createLogger('voice:telegram');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback called with the transcribed text and originating Telegram context. */
export type TranscribedHandler = (ctx: Context, text: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Download a Telegram file by file_id and return it as a Buffer.
 * Uses the getFile + file download endpoint directly via fetch.
 */
async function downloadTelegramFile(bot: Bot, fileId: string): Promise<Buffer> {
  const fileInfo = await bot.api.getFile(fileId);
  const filePath = fileInfo.file_path;

  if (!filePath) {
    throw new Error(`Telegram returned no file_path for file_id: ${fileId}`);
  }

  const token = (bot.token as string);
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download Telegram file: ${resp.status} ${resp.statusText}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// Handler attachment
// ---------------------------------------------------------------------------

/**
 * Register Grammy handlers for voice and audio messages on the bot.
 *
 * @param bot           - Grammy Bot instance (must not be started yet, or handlers
 *                        can be added before start()).
 * @param stt           - SpeechToText instance for transcription.
 * @param onTranscribed - Callback receiving the transcribed text.
 * @param ttsReply      - Optional: if true, sends a text confirmation that the
 *                        voice was heard. Caller can extend this to send TTS.
 */
export function attachVoiceHandler(
  bot: Bot,
  stt: SpeechToText,
  onTranscribed: TranscribedHandler,
  ttsReply = false,
): void {
  // Voice messages (recorded in Telegram)
  bot.on('message:voice', async (ctx) => {
    await _handleVoiceMessage(ctx, bot, stt, onTranscribed, ttsReply, 'voice');
  });

  // Audio file uploads
  bot.on('message:audio', async (ctx) => {
    await _handleVoiceMessage(ctx, bot, stt, onTranscribed, ttsReply, 'audio');
  });

  log.info('Telegram voice handler attached (voice + audio)');
}

async function _handleVoiceMessage(
  ctx: Context,
  bot: Bot,
  stt: SpeechToText,
  onTranscribed: TranscribedHandler,
  ttsReply: boolean,
  kind: 'voice' | 'audio',
): Promise<void> {
  const userId = String(ctx.from?.id ?? 'unknown');

  const fileId: string | undefined =
    kind === 'voice'
      ? ctx.message?.voice?.file_id
      : ctx.message?.audio?.file_id;

  if (!fileId) {
    log.warn({ userId, kind }, 'Voice/audio message missing file_id — skipping');
    return;
  }

  const durationSec: number =
    kind === 'voice'
      ? (ctx.message?.voice?.duration ?? 0)
      : (ctx.message?.audio?.duration ?? 0);

  log.info({ userId, kind, fileId, durationSec }, 'Received voice/audio message — downloading');

  let audioBuffer: Buffer;
  try {
    audioBuffer = await downloadTelegramFile(bot, fileId);
  } catch (err) {
    log.error({ userId, fileId, err }, 'Failed to download voice file');
    await ctx.reply('Sorry, I could not download your voice message. Please try again.').catch(() => undefined);
    return;
  }

  log.info({ userId, bytes: audioBuffer.length }, 'Audio downloaded — transcribing');

  let transcribed: string;
  try {
    const result = await stt.transcribe(audioBuffer);
    transcribed = result.text;
    log.info({ userId, textLen: transcribed.length, language: result.language }, 'Transcription complete');
  } catch (err) {
    log.error({ userId, err }, 'Transcription failed');
    await ctx.reply('Sorry, I could not transcribe your voice message.').catch(() => undefined);
    return;
  }

  if (!transcribed) {
    log.warn({ userId }, 'Transcription returned empty text — ignoring message');
    await ctx.reply('I heard silence or could not understand the audio.').catch(() => undefined);
    return;
  }

  if (ttsReply) {
    await ctx.reply(`I heard: "${transcribed}"`).catch((err) =>
      log.warn({ userId, err }, 'Failed to send transcription acknowledgement'),
    );
  }

  // Feed into normal message pipeline
  try {
    await onTranscribed(ctx, transcribed);
  } catch (err) {
    log.error({ userId, err }, 'onTranscribed handler threw');
  }
}
