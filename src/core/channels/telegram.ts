/**
 * @file telegram.ts
 * @description Telegram channel adapter using the Grammy framework.
 *
 * Features:
 *  - Text, photo, and document message handling.
 *  - Built-in commands: /start, /help, /status.
 *  - MarkdownV2 escaping for outbound messages.
 *  - Automatic message chunking at 4096 characters.
 *  - Allowlist enforcement from config.
 *  - Graceful start / stop lifecycle.
 */

import { Bot, type Context, GrammyError, InputFile, InlineKeyboard } from 'grammy';
import { saveFeedback, addNoteToFeedback } from '../feedback/store.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../shared/paths.js';
import { createLogger } from '../shared/index.js';
import { ChannelError } from '../shared/index.js';
import { SpeechToText } from '../voice/stt.js';
import { TextToSpeech } from '../voice/tts.js';
import { progress } from '../gateway/progress.js';
import type { ProgressEvent } from '../gateway/progress.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  ChatType,
  MediaAttachment,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandContext } from '../commands/types.js';

import type { HookContext, HookEvent } from '../hooks/index.js';
import { rateLimiter } from './rate-limit.js';

// ---------------------------------------------------------------------------
// Hook emission support
// ---------------------------------------------------------------------------

/** Minimal hook-emission interface compatible with HookManager. */
export interface HookEmitterLike {
  emit(event: HookEvent, context: HookContext): Promise<void>;
}

const log = createLogger('channels:telegram');

/** Maximum characters per Telegram message (platform limit). */
const TELEGRAM_CHUNK_LIMIT = 4096;

/**
 * Escape a string for Telegram MarkdownV2 format.
 * Characters that must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Split text into chunks of at most `limit` characters, splitting on
 * newlines where possible to avoid mid-sentence breaks.
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakAt = slice.lastIndexOf('\n');
    const cut = breakAt > limit * 0.5 ? breakAt : limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** Directory where incoming Telegram photos are saved. */
const UPLOAD_DIR = join(DATA_DIR, 'uploads');

/**
 * Download a Telegram photo to disk and return the saved path.
 * Returns `undefined` on any failure so the call site can degrade gracefully.
 *
 * @param bot    - Authenticated Grammy bot instance.
 * @param fileId - Telegram file_id for the photo (largest size).
 * @param token  - Bot token (needed to build the download URL).
 */
async function downloadTelegramPhoto(
  bot: Bot,
  fileId: string,
  token: string,
): Promise<string | undefined> {
  try {
    mkdirSync(UPLOAD_DIR, { recursive: true });

    const fileInfo = await bot.api.getFile(fileId);
    const filePath = fileInfo.file_path;
    if (!filePath) {
      log.warn({ fileId }, 'getFile returned no file_path');
      return undefined;
    }

    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      log.error({ fileId, status: res.status }, 'Photo download HTTP error');
      return undefined;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = filePath.split('.').pop() ?? 'jpg';
    const filename = `photo-${fileId.slice(-12)}.${ext}`;
    const savePath = join(UPLOAD_DIR, filename);
    writeFileSync(savePath, buffer);

    log.info({ fileId, savePath }, 'Telegram photo downloaded and saved');
    return savePath;
  } catch (err) {
    log.error({ fileId, err: String(err) }, 'Failed to download Telegram photo');
    return undefined;
  }
}

/**
 * Download a Telegram voice/audio message to disk and return { path, buffer }.
 * Telegram sends voice messages as OGG/Opus files.
 */
async function downloadTelegramVoice(
  bot: Bot,
  fileId: string,
  token: string,
): Promise<{ path: string; buffer: Buffer } | undefined> {
  try {
    mkdirSync(UPLOAD_DIR, { recursive: true });

    const fileInfo = await bot.api.getFile(fileId);
    const filePath = fileInfo.file_path;
    if (!filePath) {
      log.warn({ fileId }, 'getFile returned no file_path for voice');
      return undefined;
    }

    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      log.error({ fileId, status: res.status }, 'Voice download HTTP error');
      return undefined;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = filePath.split('.').pop() ?? 'ogg';
    const filename = `voice-${fileId.slice(-12)}.${ext}`;
    const savePath = join(UPLOAD_DIR, filename);
    writeFileSync(savePath, buffer);

    log.info({ fileId, savePath, bytes: buffer.length }, 'Telegram voice downloaded');
    return { path: savePath, buffer };
  } catch (err) {
    log.error({ fileId, err: String(err) }, 'Failed to download Telegram voice');
    return undefined;
  }
}

/** Lazy-loaded STT / TTS instances (created once on first use). */
let _stt: SpeechToText | null = null;
let _tts: TextToSpeech | null = null;
function getStt(): SpeechToText { return (_stt ??= new SpeechToText()); }
function getTts(): TextToSpeech { return (_tts ??= new TextToSpeech()); }

/**
 * Telegram channel adapter.
 * Reads the bot token from the environment variable specified in
 * `tokenEnvKey` (default: TELEGRAM_BOT_TOKEN).
 */
/**
 * Factory that produces a CommandContext for a given incoming message.
 * Injected at runtime by the application bootstrap so the Telegram adapter
 * does not need a hard dependency on SessionManager, Brain, etc.
 */
export type CommandContextFactory = (msg: UnifiedMessage) => Promise<CommandContext | null>;

export class TelegramAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'telegram';

  private bot: Bot | null = null;
  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private readonly allowedUsers: Set<string>;
  private readonly tokenEnvKey: string;
  private _commandRegistry: CommandRegistry | null = null;
  private _commandContextFactory: CommandContextFactory | null = null;
  private _pollAbort: AbortController | null = null;
  private _pollOffset = 0;
  private _hooks: HookEmitterLike | null = null;

  /**
   * @param tokenEnvKey  - Environment variable holding the bot token.
   * @param allowedUsers - Allowlisted Telegram user IDs (as strings).
   *                       Empty array = allow everyone (use with caution).
   */
  constructor(tokenEnvKey = 'TELEGRAM_BOT_TOKEN', allowedUsers: string[] = []) {
    this.tokenEnvKey = tokenEnvKey;
    this.allowedUsers = new Set(allowedUsers);
    if (this.allowedUsers.size === 0) {
      log.warn('Telegram allowedUsers is empty — all messages will be DENIED by default. Set TELEGRAM_CHAT_ID to allow users.');
    }
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  /**
   * Attach a CommandRegistry and context factory to this adapter.
   * When set, any inbound message starting with '/' is dispatched to the
   * registry before (and instead of) the regular message handler.
   *
   * @param registry       - The populated CommandRegistry.
   * @param contextFactory - Async factory that builds a CommandContext for a message.
   */
  setCommandRegistry(registry: CommandRegistry, contextFactory: CommandContextFactory): void {
    if (!registry || typeof registry.isCommand !== 'function') {
      throw new ChannelError(
        'setCommandRegistry: registry must be a CommandRegistry instance',
        'channel_invalid_peer',
      );
    }
    if (typeof contextFactory !== 'function') {
      throw new ChannelError(
        'setCommandRegistry: contextFactory must be a function',
        'channel_invalid_peer',
      );
    }
    this._commandRegistry = registry;
    this._commandContextFactory = contextFactory;
    log.info({}, 'CommandRegistry attached to Telegram adapter');
  }

  /**
   * Inject a HookEmitter so the adapter can emit lifecycle events.
   * Must be called before start() to ensure all events are captured.
   */
  setHookEmitter(hooks: HookEmitterLike): void {
    this._hooks = hooks;
  }

  /**
   * Fire-and-forget hook emission.
   * Any thrown exception is caught and logged so a broken hook never
   * breaks a channel send or inbound message processing.
   */
  private async _safeEmit(event: HookEvent, context: Omit<HookContext, 'event'>): Promise<void> {
    if (!this._hooks) return;
    try {
      await this._hooks.emit(event, { event, ...context } as HookContext);
    } catch (err) {
      log.warn({ event, err: String(err) }, 'Telegram hook emission failed — continuing');
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('Telegram adapter already connected — skipping start');
      return;
    }

    const token = process.env[this.tokenEnvKey];
    if (!token) {
      throw new ChannelError(
        `Telegram bot token not found in env var: ${this.tokenEnvKey}`,
        'channel_auth_missing',
        { envKey: this.tokenEnvKey },
      );
    }

    // Create bot instance for API calls (sending messages, getting files, etc.)
    // but do NOT use bot.start() — its polling is unreliable (dies on 409).
    this.bot = new Bot(token);
    this._registerHandlers(this.bot);

    // Initialize Grammy so bot.handleUpdate() works
    try {
      await this.bot.init();
      log.info({ username: this.bot.botInfo.username, id: this.bot.botInfo.id }, 'Telegram bot authenticated');
    } catch (err) {
      throw new ChannelError('Failed to authenticate Telegram bot', 'channel_auth_failed', {
        cause: String(err),
      });
    }

    // Delete any webhook so long-polling works
    await this.bot.api.deleteWebhook({ drop_pending_updates: true });

    this._isConnected = true;
    this._writeHeartbeat(); // Immediately mark polling as live before first long-poll cycle
    this._pollAbort = new AbortController();

    // Start our own polling loop (not Grammy's — ours is resilient to 409)
    this._runPollLoop(token);

    log.info('Telegram adapter started — custom polling loop active');
  }

  async stop(): Promise<void> {
    this._pollAbort?.abort();
    this._pollAbort = null;
    this._isConnected = false;
    this.bot = null;
    log.info('Telegram bot stopped');
  }

  /**
   * Write a freshness timestamp to data/heartbeat-state.json so the health
   * watchdog can confirm Telegram polling is reachable.
   * Best-effort: failures are logged at warn level and never propagate.
   */
  private _writeHeartbeat(): void {
    const heartbeatPath = join(DATA_DIR, 'heartbeat-state.json');
    try {
      let existing: Record<string, unknown> = {};
      if (existsSync(heartbeatPath)) {
        try {
          existing = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as Record<string, unknown>;
        } catch {
          // Corrupt file — start fresh; existing fields are unrecoverable
        }
      }
      const merged = { ...existing, lastBeat: new Date().toISOString() };
      writeFileSync(heartbeatPath, JSON.stringify(merged, null, 2));
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to write Telegram heartbeat — continuing');
    }
  }

  /**
   * Custom polling loop that handles 409 gracefully by retrying.
   * Unlike Grammy's bot.start(), this never dies permanently.
   */
  private _runPollLoop(token: string): void {
    const baseUrl = `https://api.telegram.org/bot${token}`;
    const abort = this._pollAbort!;

    const poll = async () => {
      log.info('Poll loop starting fetch cycle');
      while (!abort.signal.aborted) {
        try {
          const url = `${baseUrl}/getUpdates?offset=${this._pollOffset}&timeout=30&allowed_updates=["message"]`;
          let res: Response;
          try {
            res = await fetch(url, { signal: abort.signal });
          } catch (fetchErr: any) {
            if (abort.signal.aborted || fetchErr.name === 'AbortError') break;
            log.warn({ err: String(fetchErr) }, 'Poll fetch error — retrying in 3s');
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }

          let data: { ok: boolean; result?: any[]; description?: string };
          try {
            data = await res.json() as typeof data;
          } catch {
            log.warn('Poll response not JSON — retrying in 3s');
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }

          if (!data.ok) {
            if (data.description?.includes('409')) {
              log.warn('Poll 409 conflict — retrying in 10s');
              await new Promise(r => setTimeout(r, 10000));
              continue;
            }
            log.error({ description: data.description }, 'getUpdates failed — retrying in 5s');
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }

          // Successful fetch: record heartbeat before dispatching updates.
          this._writeHeartbeat();

          const updates = data.result ?? [];
          for (const update of updates) {
            this._pollOffset = update.update_id + 1;
            if (!update.message) continue;

            try {
              if (this.bot) {
                await this.bot.handleUpdate(update);
              }
            } catch (err) {
              log.error({ updateId: update.update_id, err: String(err) }, 'Error handling update');
            }
          }
        } catch (err: any) {
          if (abort.signal.aborted) break;
          if (err.name === 'AbortError') break;
          // NEVER exit the loop on error — always retry
          log.error({ err: String(err) }, 'Poll loop unexpected error — retrying in 5s');
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      log.info('Poll loop exited');
    };

    // Fire and forget — runs in background. NEVER crashes permanently.
    poll().catch((err) => {
      log.error({ err: String(err) }, 'Poll loop crashed — restarting in 10s');
      // Auto-restart the poll loop on crash
      setTimeout(() => {
        if (!abort.signal.aborted) {
          log.info('Poll loop auto-restarting after crash');
          this._runPollLoop(token);
        }
      }, 10000);
    });
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async send(peerId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.bot || !this._isConnected) {
      throw new ChannelError('Telegram adapter is not connected', 'channel_not_connected', {
        peerId,
      });
    }

    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }

    const parseMode = options?.parseMode ?? 'markdown';
    const replyParams =
      options?.replyToId != null
        ? { reply_parameters: { message_id: parseInt(options.replyToId, 10) } }
        : {};

    try {
      // Voice reply — synthesise text and send as Telegram voice note
      if (options?.['voiceReply'] === true && text.trim().length > 0) {
        try {
          const tts = getTts();
          const ttsResult = await tts.synthesize(text.trim().slice(0, 4000));
          if (ttsResult.audioBuffer && ttsResult.audioBuffer.length > 0) {
            const voiceFile = new InputFile(ttsResult.audioBuffer, 'voice.ogg');
            await this.bot.api.sendVoice(peerId, voiceFile, {
              ...replyParams,
              caption: text.length > 200 ? text.slice(0, 200) + '…' : undefined,
            });
            log.info({ peerId, bytes: ttsResult.audioBuffer.length }, 'Voice reply sent');
            // Emit message:sent for the voice delivery path before returning.
            void this._safeEmit('message:sent', {
              channel: 'telegram' as const,
              meta: { peerId, chunks: 1, via: 'voice' },
            });
            return; // Voice sent — skip text send
          }
        } catch (voiceErr) {
          log.warn({ voiceErr: String(voiceErr) }, 'TTS failed — falling back to text reply');
          // Fall through to send as text
        }
      }

      // Send media first if provided.
      if (options?.media?.length) {
        for (const attachment of options.media) {
          await this._sendMedia(peerId, attachment, replyParams);
        }
      }

      // Send text (chunked if necessary).
      if (text.trim().length > 0) {
        const chunks = chunkText(text, TELEGRAM_CHUNK_LIMIT);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk) continue;

          // Try MarkdownV2 first, fall back to plain text on failure
          if (parseMode === 'markdown') {
            try {
              const escaped = escapeMarkdownV2(chunk);
              await this.bot.api.sendMessage(peerId, escaped, {
                parse_mode: 'MarkdownV2',
                ...(i === 0 ? replyParams : {}),
              });
            } catch {
              // MarkdownV2 failed — send as plain text (never lose a message)
              log.debug({ peerId }, 'MarkdownV2 send failed — falling back to plain text');
              await this.bot.api.sendMessage(peerId, chunk, {
                ...(i === 0 ? replyParams : {}),
              });
            }
          } else {
            const tgParseMode = parseMode === 'html' ? 'HTML' as const : undefined;
            await this.bot.api.sendMessage(peerId, chunk, {
              parse_mode: tgParseMode,
              ...(i === 0 ? replyParams : {}),
            });
          }
        }

        // Emit message:sent once per send call (not once per chunk).
        void this._safeEmit('message:sent', {
          channel: 'telegram' as const,
          meta: { peerId, chunks: chunks.length },
        });
      }
    } catch (err) {
      log.error({ peerId, err }, 'Telegram send failed');
      // Last resort: try sending plain text without any formatting
      try {
        if (this.bot && text.trim()) {
          await this.bot.api.sendMessage(peerId, text.substring(0, TELEGRAM_CHUNK_LIMIT));
          log.info({ peerId }, 'Sent plain text fallback after error');
        }
      } catch { /* truly failed */ }
      throw new ChannelError('Failed to send Telegram message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  /**
   * Send a message with a Telegram InlineKeyboard attached.
   * Falls back to plain send if keyboard fails.
   */
  async sendWithKeyboard(peerId: string, text: string, keyboard: InlineKeyboard): Promise<void> {
    if (!this.bot || !this._isConnected) {
      return this.send(peerId, text);
    }
    const chunks = chunkText(text, TELEGRAM_CHUNK_LIMIT);
    // Send all but last chunk as plain text
    for (let i = 0; i < chunks.length - 1; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      try {
        const escaped = escapeMarkdownV2(chunk);
        await this.bot.api.sendMessage(peerId, escaped, { parse_mode: 'MarkdownV2' });
      } catch {
        await this.bot.api.sendMessage(peerId, chunk);
      }
    }
    // Last chunk gets the keyboard
    const lastChunk = chunks[chunks.length - 1] ?? text.slice(0, 100);
    try {
      const escaped = escapeMarkdownV2(lastChunk);
      await this.bot.api.sendMessage(peerId, escaped, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      });
    } catch {
      try {
        await this.bot.api.sendMessage(peerId, lastChunk, { reply_markup: keyboard });
      } catch {
        await this.send(peerId, text); // final fallback — no keyboard
      }
    }
  }

  /**
   * Public wrapper around _sendMedia so external callers (e.g. cli.ts) can
   * send a file attachment directly without going through send() options.
   *
   * @param peerId     - Telegram chat/user ID to send to.
   * @param attachment - MediaAttachment carrying buffer or url plus type.
   */
  async sendMedia(peerId: string, attachment: MediaAttachment): Promise<void> {
    if (!this.bot || !this._isConnected) {
      throw new ChannelError('Telegram adapter is not connected', 'channel_not_connected', { peerId });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    await this._sendMedia(peerId, attachment, {});
  }

  // ---------------------------------------------------------------------------
  // Internal handler wiring
  // ---------------------------------------------------------------------------

  private _registerHandlers(bot: Bot): void {
    // Commands
    bot.command('start', (ctx) => this._handleCommand(ctx, 'start'));
    bot.command('help', (ctx) => this._handleCommand(ctx, 'help'));
    bot.command('status', (ctx) => this._handleCommand(ctx, 'status'));

    // Feedback inline keyboard callbacks  fb:{rating}:{feedbackId}
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data ?? '';
      if (!data.startsWith('fb:')) return;

      const parts = data.split(':');
      const rating = parts[1] as 'good' | 'bad' | 'skip' | undefined;
      const feedbackId = parts[2];

      if (!rating || !feedbackId) {
        await ctx.answerCallbackQuery({ text: 'Invalid feedback data.' });
        return;
      }

      try {
        // Update the pre-saved record from 'skip' to the actual rating
        saveFeedback({
          session_id: feedbackId, // use feedbackId as lookup key via notes
          channel: 'telegram',
          task_summary: `rating-update:${feedbackId}`,
          task_type: 'general',
          rating,
          notes: `updated from callback: ${feedbackId}`,
        });

        // Remove the keyboard from the original message
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch { /* message too old or already edited */ }

        if (rating === 'good') {
          await ctx.answerCallbackQuery({ text: '👍 Got it — great to know!', show_alert: false });
        } else if (rating === 'bad') {
          await ctx.answerCallbackQuery({ text: '👎 Noted — I\'ll do better. Reply with what was wrong.', show_alert: false });
          // Send a follow-up asking for notes
          try {
            await ctx.reply('What was wrong? (Reply to this message with details — I\'ll learn from it)');
          } catch { /* non-fatal */ }
        } else {
          await ctx.answerCallbackQuery({ text: '⏭️ Skipped', show_alert: false });
        }

        log.info({ feedbackId, rating }, 'Feedback callback processed');
      } catch (err) {
        log.error({ err: String(err) }, 'Feedback callback error');
        await ctx.answerCallbackQuery({ text: 'Could not save feedback.' });
      }
    });

    // Text messages
    bot.on('message:text', (ctx) => this._handleInbound(ctx, ctx.message.text, []));

    // Photos — download image, save to data/uploads/, append vision hint to text
    bot.on('message:photo', async (ctx) => {
      const photo = ctx.message.photo.at(-1); // largest size
      const caption = ctx.message.caption ?? '';

      let textWithHint = caption;
      const media: MediaAttachment[] = [];

      if (photo) {
        const token = process.env[this.tokenEnvKey] ?? '';
        const savedPath = token
          ? await downloadTelegramPhoto(bot, photo.file_id, token)
          : undefined;

        if (savedPath) {
          textWithHint = caption
            ? `${caption}\n[Image attached: ${savedPath}. Use browser.vision to analyze it if needed.]`
            : `[Image attached: ${savedPath}. Use browser.vision to analyze it if needed.]`;
          media.push({
            type: 'image',
            mimeType: 'image/jpeg',
            filename: savedPath.split('/').pop() ?? `${photo.file_id}.jpg`,
            url: savedPath,
          });
        } else {
          // fallback: pass file_id metadata only
          media.push({
            type: 'image',
            mimeType: 'image/jpeg',
            filename: `${photo.file_id}.jpg`,
            url: undefined,
          });
        }
      }

      return this._handleInbound(ctx, textWithHint, media);
    });

    // Documents
    bot.on('message:document', (ctx) => {
      const doc = ctx.message.document;
      const caption = ctx.message.caption ?? '';
      const media: MediaAttachment[] = [
        {
          type: 'document',
          mimeType: doc.mime_type ?? 'application/octet-stream',
          filename: doc.file_name ?? doc.file_id,
        },
      ];
      return this._handleInbound(ctx, caption, media);
    });

    // Voice messages — transcribe with Whisper then process as text
    bot.on('message:voice', async (ctx) => {
      const voice = ctx.message.voice;
      const token = process.env[this.tokenEnvKey] ?? '';
      const peerId = String(ctx.from?.id ?? ctx.chat.id);

      // Send a "listening..." indicator while transcribing
      let processingMsgId: number | undefined;
      try {
        const ack = await ctx.reply('🎙️ Listening...');
        processingMsgId = ack.message_id;
      } catch { /* non-fatal */ }

      try {
        const downloaded = token
          ? await downloadTelegramVoice(bot, voice.file_id, token)
          : undefined;

        if (!downloaded) {
          await ctx.reply('❌ Could not download voice message. Try again.');
          return;
        }

        // Transcribe
        const stt = getStt();
        const result = await stt.transcribe(downloaded.buffer);

        // Clean up temp file
        try { if (existsSync(downloaded.path)) unlinkSync(downloaded.path); } catch { /* ignore */ }

        if (!result.text.trim()) {
          await ctx.reply('❌ Could not understand the voice message. Please speak clearly or try again.');
          return;
        }

        // Delete the "listening..." message
        if (processingMsgId) {
          try { await bot.api.deleteMessage(peerId, processingMsgId); } catch { /* ignore */ }
        }

        log.info({ peerId, text: result.text, lang: result.language }, 'Voice message transcribed');

        // Pass the transcribed text through the normal message pipeline
        // Append a hint so the brain knows it came from voice (for voice reply logic)
        const textWithHint = `${result.text.trim()} [voice message — user may prefer a voice reply]`;
        return this._handleInbound(ctx, textWithHint, []);

      } catch (err) {
        log.error({ err: String(err) }, 'Voice message processing failed');
        if (processingMsgId) {
          try { await bot.api.deleteMessage(peerId, processingMsgId); } catch { /* ignore */ }
        }
        await ctx.reply('❌ Voice processing failed. Please try again or send a text message.');
      }
    });

    // Audio files (voice notes sent as audio, not the voice type)
    bot.on('message:audio', async (ctx) => {
      const audio = ctx.message.audio;
      const token = process.env[this.tokenEnvKey] ?? '';
      const caption = ctx.message.caption ?? '';

      const downloaded = token
        ? await downloadTelegramVoice(bot, audio.file_id, token)
        : undefined;

      if (downloaded) {
        try {
          const stt = getStt();
          const result = await stt.transcribe(downloaded.buffer);
          try { if (existsSync(downloaded.path)) unlinkSync(downloaded.path); } catch { /* ignore */ }
          if (result.text.trim()) {
            const text = caption
              ? `${caption}\n[Audio transcription: ${result.text.trim()}]`
              : result.text.trim();
            return this._handleInbound(ctx, text, []);
          }
        } catch { /* fall through to doc handling */ }
      }

      // Fallback: treat as document
      const media: MediaAttachment[] = [{
        type: 'audio',
        mimeType: audio.mime_type ?? 'audio/mpeg',
        filename: audio.file_name ?? audio.file_id,
      }];
      return this._handleInbound(ctx, caption, media);
    });

    // Catch-all error handler
    bot.catch((err) => {
      log.error({ err: err.error }, 'Grammy uncaught error');
    });
  }

  private _isAllowed(userId: string): boolean {
    // Deny by default when no allowlist is configured.
    if (this.allowedUsers.size === 0) return false;
    return this.allowedUsers.has(userId);
  }

  private async _handleCommand(ctx: Context, command: string): Promise<void> {
    const userId = String(ctx.from?.id ?? '');
    if (!this._isAllowed(userId)) {
      log.warn({ userId, command }, 'Unauthorized command attempt — ignored');
      return;
    }

    const commandTexts: Record<string, string> = {
      start: 'Hello! I am SUDO-AI. Send me a message to get started.',
      help: 'Send me any message and I will respond. Use /status to check my state.',
      status: 'SUDO-AI is online and operational.',
    };

    const response = commandTexts[command] ?? 'Unknown command.';
    try {
      await ctx.reply(response);
    } catch (err) {
      log.error({ command, userId, err }, 'Failed to reply to command');
    }

    // Treat commands as messages for the handler.
    await this._handleInbound(ctx, `/${command}`, []);
  }

  private async _handleInbound(
    ctx: Context,
    text: string,
    media: MediaAttachment[],
  ): Promise<void> {
    const from = ctx.from;
    const userId = String(from?.id ?? 'unknown');

    if (!this._isAllowed(userId)) {
      log.warn({ userId }, 'Message from non-allowlisted user — dropped');
      return;
    }

    // Per-peer rate limiting
    const rl = await rateLimiter.check('telegram', userId);
    if (!rl.allowed) {
      if (!rl.burstWarned) {
        const secs = Math.ceil((rl.retryAfterMs ?? 60000) / 1000);
        try { await ctx.reply(`Please slow down — try again in ${secs}s`); } catch { /* ignore */ }
      }
      return;
    }

    if (!this._handler) {
      log.warn({ userId }, 'No handler registered — message dropped');
      return;
    }

    const chatType: ChatType = ctx.chat?.type === 'private' ? 'dm' : 'group';
    const msg: UnifiedMessage = {
      id: String(ctx.message?.message_id ?? Date.now()),
      channel: 'telegram',
      peerId: userId,
      peerName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || userId,
      chatType,
      text,
      media: media.length > 0 ? media : undefined,
      replyToId: ctx.message?.reply_to_message?.message_id != null
        ? String(ctx.message.reply_to_message.message_id)
        : undefined,
      timestamp: new Date((ctx.message?.date ?? 0) * 1000),
    };

    log.debug({ peerId: userId, textLen: text.length, chatType }, 'inbound Telegram message');

    const chatId = String(ctx.chat?.id ?? userId);

    // Session ID ties this Telegram message to gateway progress events.
    // Use message ID so concurrent conversations are tracked independently.
    const sessionId = `tg-${userId}-${msg.id}`;

    // Emit message:received — fire-and-forget, must not block message processing.
    void this._safeEmit('message:received', {
      channel: 'telegram' as const,
      sessionId,
      meta: { peerId: userId, text: msg.text, mediaCount: media.length },
    });

    // Show typing indicator immediately and keep refreshing every 4s while processing.
    // Telegram's typing status disappears after ~5s so we must re-send it.
    const sendTyping = () => {
      this.bot?.api.sendChatAction(chatId, 'typing').catch(() => { /* non-fatal */ });
    };
    sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);
    const stopTyping = () => clearInterval(typingInterval);

    // Timestamp of last streaming update sent to avoid flooding Telegram
    let lastStreamingUpdateMs = 0;
    const STREAM_UPDATE_INTERVAL_MS = 5000;

    // Subscribe to gateway progress events for this session
    const unsubProgress = progress.subscribe(sessionId, (event: ProgressEvent) => {
      if (!this.bot || !this._isConnected) return;

      switch (event.type) {
        case 'thinking':
          // Refresh typing indicator immediately on thinking event
          this.bot.api.sendChatAction(chatId, 'typing').catch(() => { /* non-fatal */ });
          break;

        case 'streaming': {
          const now = Date.now();
          if (now - lastStreamingUpdateMs >= STREAM_UPDATE_INTERVAL_MS) {
            lastStreamingUpdateMs = now;
            // Refresh typing so user sees progress during long streams
            this.bot?.api.sendChatAction(chatId, 'typing').catch(() => { /* non-fatal */ });
            log.debug(
              { peerId: userId, sessionId, tokens: event.tokensGenerated, provider: event.provider },
              'Gateway streaming update',
            );
          }
          break;
        }

        case 'error':
          log.warn({ peerId: userId, sessionId, errMsg: event.message }, 'Gateway error event');
          // Non-fatal: main handler will surface the real error to the user
          break;

        default:
          break;
      }
    });

    // Slash command intercept — dispatch to CommandRegistry when text starts with '/'.
    if (this._commandRegistry?.isCommand(text) && this._commandContextFactory) {
      try {
        const cmdCtx = await this._commandContextFactory(msg);
        if (cmdCtx) {
          const response = await this._commandRegistry.execute(text, cmdCtx);
          stopTyping();
          unsubProgress();
          log.info({ peerId: userId, command: text.split(' ')[0] }, 'Slash command dispatched');
          await this.send(userId, response, { parseMode: 'plain' });
          return;
        }
      } catch (err) {
        stopTyping();
        unsubProgress();
        log.error({ userId, text, err }, 'Slash command dispatch error');
        try {
          await this.send(userId, `Error executing command: ${String(err)}`, { parseMode: 'plain' });
        } catch { /* swallow — best effort */ }
        return;
      }
    }

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ userId, err }, 'Message handler error');
    } finally {
      stopTyping();
      unsubProgress();
    }
  }

  private async _sendMedia(
    peerId: string,
    attachment: MediaAttachment,
    replyParams: Record<string, unknown>,
  ): Promise<void> {
    if (!this.bot) return;

    const source = attachment.buffer
      ? new InputFile(attachment.buffer, attachment.filename)
      : attachment.url ?? '';

    if (!source) {
      log.warn({ peerId }, 'Media attachment has no url or buffer — skipping');
      return;
    }

    if (attachment.type === 'image') {
      await this.bot.api.sendPhoto(peerId, source as string, replyParams);
    } else if (attachment.type === 'video') {
      await this.bot.api.sendVideo(peerId, source as string, replyParams);
    } else if (attachment.type === 'audio') {
      await this.bot.api.sendAudio(peerId, source as string, replyParams);
    } else {
      await this.bot.api.sendDocument(peerId, source as string, replyParams);
    }
  }
}
