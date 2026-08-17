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

import { Bot, type Context, GrammyError, InputFile, InputMediaBuilder, InlineKeyboard } from 'grammy';
import type { Update as TelegramUpdate } from 'grammy/types';
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
import { getPairingManager } from './pairing.js';
import { buildDocumentInbound, pickTelegramSendMethod } from './telegram-media.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandContext } from '../commands/types.js';

import type { HookContext, HookEvent } from '../hooks/index.js';
import { rateLimiter } from './rate-limit.js';
import { resolveEnvSecret } from '../secrets/secret-ref.js';
import { useGrokVoiceFor, grokRealtimeEnabledFor, grokRealtimeVoiceReply } from './telegram-grok-voice.js';

// ---------------------------------------------------------------------------
// Hook emission support
// ---------------------------------------------------------------------------

/** Minimal hook-emission interface compatible with HookManager. */
export interface HookEmitterLike {
  emit(event: HookEvent, context: HookContext): Promise<void>;
}

const log = createLogger('channels:telegram');

/** Maximum characters per Telegram message (platform limit). */
import { chunkText, TELEGRAM_CHUNK_LIMIT, MD_SOURCE_CHUNK_LIMIT } from './long-reply.js';
import { renderMdWithinLimit } from './telegram-format.js';
import { getCheckpointProtocol } from './checkpoint-registry.js';
import {
  handleRunControlCallback,
  makeReasonKeyboard,
  wantsReasonKeyboard,
  RegenGuard,
  type RegenerateRequest,
  type RegenReasonCode,
} from './telegram-run-controls.js';
import { getRunRegistry } from '../agent/run-registry.js';

/**
 * Update types requested from getUpdates.
 *
 * Telegram delivers ONLY the types listed here — anything omitted is dropped
 * server-side and never reaches the bot. `callback_query` was missing until
 * 2026-07-29, which silently made EVERY inline button dead on arrival (the
 * 👍👎⏭ feedback keyboard, TX1 Stop, TX3 Details): the buttons rendered, taps
 * were accepted by the client, and the updates were discarded before polling.
 * Any new interactive surface must add its update type here.
 */
export const POLL_ALLOWED_UPDATES = ['message', 'callback_query'] as const;

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

/**
 * Download a Telegram document (any uploaded file) to disk. Returns the saved
 * path + raw bytes. Preserves the original (sanitised) filename so the agent can
 * tell the file type and read it back if needed.
 */
async function downloadTelegramDocument(
  bot: Bot,
  fileId: string,
  token: string,
  fileName?: string,
): Promise<{ path: string; buffer: Buffer } | undefined> {
  try {
    mkdirSync(UPLOAD_DIR, { recursive: true });

    const fileInfo = await bot.api.getFile(fileId);
    const filePath = fileInfo.file_path;
    if (!filePath) {
      log.warn({ fileId }, 'getFile returned no file_path for document');
      return undefined;
    }

    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      log.error({ fileId, status: res.status }, 'Document download HTTP error');
      return undefined;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = filePath.split('.').pop() ?? 'bin';
    // Keep the user's original filename (sanitised) prefixed with a short file-id
    // slice for uniqueness, so collisions are avoided but the extension/type survives.
    const safeName = (fileName ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
    const filename = safeName ? `${fileId.slice(-8)}-${safeName}` : `doc-${fileId.slice(-12)}.${ext}`;
    const savePath = join(UPLOAD_DIR, filename);
    writeFileSync(savePath, buffer);

    log.info({ fileId, savePath, bytes: buffer.length }, 'Telegram document downloaded');
    return { path: savePath, buffer };
  } catch (err) {
    log.error({ fileId, err: String(err) }, 'Failed to download Telegram document');
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
  /** GW-6: original (owner) allowlist — only these may run /pair admin commands. */
  private readonly ownerUsers: Set<string>;
  /** TX2 — regeneration seam (set from cli.ts) + one-regen-per-feedbackId guard. */
  private _onRegenerate: ((req: RegenerateRequest) => void | Promise<void>) | null = null;
  private readonly _regenGuard = new RegenGuard();
  /** GW-6: DM admission posture for unknown senders (TELEGRAM_DM_POLICY). */
  private readonly dmPolicy: 'allowlist' | 'pairing' | 'open';
  private readonly tokenEnvKey: string;
  private _commandRegistry: CommandRegistry | null = null;
  private _commandContextFactory: CommandContextFactory | null = null;
  private _pollAbort: AbortController | null = null;
  private _pollOffset = 0;
  private _hooks: HookEmitterLike | null = null;
  /**
   * Peers whose most-recent inbound was a voice/audio note and who are owed a
   * voice reply. peerId → expiry epoch-ms. The next non-empty text reply to
   * that peer is synthesised (Kokoro TTS) and sent as a voice note, then the
   * marker is consumed. Auto voice-in → voice-out; disable with
   * SUDO_TELEGRAM_VOICE_REPLY=0.
   */
  private readonly _voiceReplyPending = new Map<string, number>();
  /** How long a pending voice-reply marker stays valid after the voice note. */
  private static readonly VOICE_REPLY_TTL_MS = 120_000;

  /** True unless explicitly disabled — voice-in triggers an auto voice reply. */
  private get _autoVoiceReply(): boolean {
    return process.env['SUDO_TELEGRAM_VOICE_REPLY'] !== '0'
      && process.env['SUDO_TELEGRAM_VOICE_REPLY'] !== 'false';
  }

  /** Mark a peer as owed a voice reply (called when a voice/audio note arrives). */
  private _markVoiceReply(peerId: string): void {
    if (this._autoVoiceReply) {
      this._voiceReplyPending.set(peerId, Date.now() + TelegramAdapter.VOICE_REPLY_TTL_MS);
    }
  }

  /** Consume the pending voice-reply marker for a peer (true once, within TTL). */
  private _consumeVoiceReply(peerId: string): boolean {
    const expiry = this._voiceReplyPending.get(peerId);
    if (expiry == null) return false;
    this._voiceReplyPending.delete(peerId);
    return expiry >= Date.now();
  }

  /**
   * @param tokenEnvKey  - Environment variable holding the bot token.
   * @param allowedUsers - Allowlisted Telegram user IDs (as strings).
   *                       Empty array = allow everyone (use with caution).
   */
  constructor(tokenEnvKey = 'TELEGRAM_BOT_TOKEN', allowedUsers: string[] = []) {
    this.tokenEnvKey = tokenEnvKey;
    this.allowedUsers = new Set(allowedUsers);
    // GW-6: remember the original owner allowlist BEFORE merging paired peers —
    // only owners may run /pair admin commands.
    this.ownerUsers = new Set(allowedUsers);
    const rawPolicy = process.env['TELEGRAM_DM_POLICY'];
    this.dmPolicy = rawPolicy === 'pairing' || rawPolicy === 'open' ? rawPolicy : 'allowlist';
    // GW-6: admit previously-approved (paired) peers so approvals survive restart.
    try {
      for (const peer of getPairingManager().pairedPeers('telegram', this.tokenEnvKey)) this.allowedUsers.add(peer);
    } catch { /* pairing store optional */ }
    if (this.allowedUsers.size === 0 && this.dmPolicy === 'allowlist') {
      log.warn('Telegram allowedUsers is empty — all messages will be DENIED by default. Set TELEGRAM_CHAT_ID to allow users, or TELEGRAM_DM_POLICY=pairing to hand out pairing codes.');
    }
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /** Is this user id on the owner list (constructor allowlist, not pairing-admitted)? */
  isOwnerUser(userId: string): boolean {
    return this.ownerUsers.has(userId);
  }

  /**
   * TX2 (`SUDO_TG_BAD_REGEN=1`) — injectable regeneration seam. The adapter
   * cannot reach the agent loop; cli.ts sets this to run a bounded revision
   * turn and edit the rejected reply in place. Null → 👎 keeps legacy behavior.
   */
  setRegenerateHandler(handler: (req: RegenerateRequest) => void | Promise<void>): void {
    this._onRegenerate = handler;
  }

  /** The bot's @username once authenticated; null before start() completes. */
  get botUsername(): string | null {
    try {
      // Grammy's botInfo getter throws when accessed before bot.init().
      return this.bot?.botInfo.username ?? null;
    } catch {
      return null;
    }
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  /**
   * Decide whether inbound text should dispatch to the CommandRegistry, and
   * with what text. Returns the (possibly normalized) command text, or null
   * to fall through to the regular agent handler.
   *
   * - Telegram group chats address commands as "/cmd@BotName"; when the
   *   mention is OUR authenticated bot username it is stripped so the
   *   registered name matches ("/help@SudoBot args" → "/help args"). A
   *   mention of a DIFFERENT bot is left as-is (never registered → falls
   *   through like any other text; group chatter is governed by the
   *   mention-gating layer, not here).
   * - REGISTERED commands only — an unregistered slash-shaped message falls
   *   through so the agent (and anchored skill triggers) can handle it. A
   *   duck-typed registry that predates isRegisteredCommand falls back to
   *   the syntactic check, i.e. exactly the legacy consume-all behavior.
   */
  private _resolveCommandText(text: string): string | null {
    const registry = this._commandRegistry;
    if (!registry) return null;
    let candidate = text;
    const botName = this.botUsername;
    if (botName) {
      const m = text.trimStart().match(/^(\/[A-Za-z0-9_]+)@([A-Za-z0-9_]+)([\s][\s\S]*)?$/);
      if (m && m[2]!.toLowerCase() === botName.toLowerCase()) {
        candidate = m[1]! + (m[3] ?? '');
      }
    }
    const dispatchable = registry.isRegisteredCommand?.(candidate) ?? registry.isCommand(candidate);
    return dispatchable ? candidate : null;
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

    const token = resolveEnvSecret(this.tokenEnvKey) ?? undefined;
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
          const url = `${baseUrl}/getUpdates?offset=${this._pollOffset}&timeout=30`
            + `&allowed_updates=${encodeURIComponent(JSON.stringify(POLL_ALLOWED_UPDATES))}`;
          let res: Response;
          try {
            res = await fetch(url, { signal: abort.signal });
          } catch (fetchErr: unknown) {
            const isAbort = fetchErr instanceof Error && fetchErr.name === 'AbortError';
            if (abort.signal.aborted || isAbort) break;
            log.warn({ err: String(fetchErr) }, 'Poll fetch error — retrying in 3s');
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }

          let data: { ok: boolean; result?: TelegramUpdate[]; description?: string };
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
            // Dispatch messages AND callback queries (inline-button taps).
            // A `!update.message` guard here silently dropped every button
            // tap even once allowed_updates requested them — the second half
            // of the 2026-07-29 dead-button bug. Keep this in sync with
            // POLL_ALLOWED_UPDATES.
            if (!update.message && !update.callback_query) continue;

            try {
              if (this.bot) {
                await this.bot.handleUpdate(update);
              }
            } catch (err) {
              log.error({ updateId: update.update_id, err: String(err) }, 'Error handling update');
            }
          }
        } catch (err: unknown) {
          if (abort.signal.aborted) break;
          if (err instanceof Error && err.name === 'AbortError') break;
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

    // Voice reply when the caller asked explicitly, OR when this peer just sent
    // a voice/audio note (auto voice-in → voice-out, consumed once within TTL).
    // Gated on having text so an empty/media-only send never burns the marker.
    const wantVoiceReply =
      text.trim().length > 0
      && (options?.['voiceReply'] === true || this._consumeVoiceReply(peerId));

    try {
      // Voice reply — synthesise text and send as Telegram voice note
      if (wantVoiceReply) {
        try {
          const tts = getTts();
          const gVoice = useGrokVoiceFor(this.ownerUsers, peerId) ? { provider: 'grok' as const } : {};
          const ttsResult = await tts.synthesize(text.trim().slice(0, 4000), gVoice);
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

      // Send text (chunked if necessary). Zero-width chars (U+200B-D, U+2060, U+FEFF)
      // are stripped before the empty check — `String.prototype.trim()` does not
      // remove them and Telegram 400s on `text must be non-empty`.
      if (text.replace(/[​-‍⁠﻿]/g, '').trim().length > 0) {
        // Markdown chunks are budgeted BELOW the wire cap: rendering adds tag
        // characters (~7% on bold-heavy prose), so a 4096-char source chunk
        // renders past Telegram's limit. Splitting earlier keeps every
        // character (more messages) instead of truncating one.
        const chunks = chunkText(text, parseMode === 'markdown' ? MD_SOURCE_CHUNK_LIMIT : TELEGRAM_CHUNK_LIMIT);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk) continue;

          // Render markdown → Telegram HTML (bold/code/headings display
          // properly instead of literal ** markers); plain-text fallback on
          // any rejection so a message is never lost.
          if (parseMode === 'markdown') {
            try {
              const html = renderMdWithinLimit(chunk, { collapse: options?.collapse === true });
              await this.bot.api.sendMessage(peerId, html, {
                parse_mode: 'HTML',
                ...(i === 0 ? replyParams : {}),
              });
            } catch (htmlErr) {
              log.warn({ peerId, err: String(htmlErr) }, 'HTML send failed — falling back to plain text');
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
        if (this.bot && text.replace(/[​-‍⁠﻿]/g, '').trim()) {
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
   * Streaming-mode placeholder (gap #19). Sends `placeholder` as a regular
   * message and returns its Telegram `message_id` as a string so the
   * channel-agnostic stream sink can later edit it in place. The returned
   * id is base-10 so it can round-trip through the `StreamSink.edit`
   * signature (string | number) without surprises.
   */
  async sendForStream(peerId: string, placeholder: string): Promise<string> {
    if (!this.bot || !this._isConnected) {
      throw new ChannelError('Telegram adapter is not connected', 'channel_not_connected', { peerId });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    const visible = placeholder?.replace(/[​-‍⁠﻿]/g, '').trim();
    const safePlaceholder = visible?.length ? placeholder : '⋯';
    const sent = await this.bot.api.sendMessage(peerId, safePlaceholder);
    return String(sent.message_id);
  }

  /**
   * Streaming-mode edit (gap #19). Wraps `bot.api.editMessageText` so the
   * stream sink can update the placeholder in place. The `messageId`
   * param is the value returned by `sendForStream`. Empty / unchanged
   * text is the caller's responsibility — Telegram returns HTTP 400 on a
   * noop edit, which the BufferedEditSink already prevents.
   */
  async editText(peerId: string, messageId: string | number, text: string, opts?: { format?: 'plain' | 'md' | 'md-collapse'; keyboard?: InlineKeyboard }): Promise<void> {
    if (!this.bot || !this._isConnected) {
      throw new ChannelError('Telegram adapter is not connected', 'channel_not_connected', { peerId });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    const msgIdNum = typeof messageId === 'number' ? messageId : parseInt(String(messageId), 10);
    if (!Number.isFinite(msgIdNum)) {
      throw new ChannelError('messageId must parse to a finite integer', 'channel_invalid_peer', { messageId });
    }
    // Telegram hard-caps message bodies at 4096 chars; longer edits 400.
    const clamped = text.length > 4096 ? text.slice(0, 4080) + '\n…[truncated]' : text;
    // format:'md' renders markdown → HTML (mid-stream partials are safe: the
    // converter leaves unbalanced markers as literal text); 'md-collapse'
    // additionally folds the tail into an expandable blockquote ("Read
    // More"). Plain retry on 400 either way.
    // TX1: editMessageText REPLACES reply_markup (absent → removed), so a
    // working card that carries a Stop button must re-send it on every edit.
    const markup = opts?.keyboard ? { reply_markup: opts.keyboard } : {};
    if (opts?.format === 'md' || opts?.format === 'md-collapse') {
      try {
        // Fit the RENDERED html to Telegram's cap — tag expansion on a
        // source-clamped body used to overflow and 400, silently degrading
        // the message to plain text (literal ** markers).
        const html = renderMdWithinLimit(clamped, { collapse: opts.format === 'md-collapse' });
        await this.bot.api.editMessageText(peerId, msgIdNum, html, { parse_mode: 'HTML', ...markup });
        return;
      } catch (htmlErr) {
        // Never silent: a swallowed 400 here is exactly what hid the
        // literal-asterisk regression in prod.
        log.warn({ peerId, err: String(htmlErr) }, 'editText HTML render/edit failed — falling back to plain');
      }
    }
    await this.bot.api.editMessageText(peerId, msgIdNum, clamped, { ...markup });
  }

  /**
   * Attach an InlineKeyboard to an EXISTING message (gap #19 follow-up).
   * Lets the feedback keyboard ride on the finalized streamed reply instead
   * of a separate junk '⋯' message.
   */
  async editReplyMarkup(peerId: string, messageId: string | number, keyboard: InlineKeyboard): Promise<void> {
    if (!this.bot || !this._isConnected) {
      throw new ChannelError('Telegram adapter is not connected', 'channel_not_connected', { peerId });
    }
    const msgIdNum = typeof messageId === 'number' ? messageId : parseInt(String(messageId), 10);
    if (!Number.isFinite(msgIdNum)) {
      throw new ChannelError('messageId must parse to a finite integer', 'channel_invalid_peer', { messageId });
    }
    await this.bot.api.editMessageReplyMarkup(peerId, msgIdNum, { reply_markup: keyboard });
  }

  /**
   * Best-effort delete of a working/placeholder message (never throws) so
   * error paths can clean up their status card instead of littering the chat.
   */
  async deleteMessageSafe(peerId: string, messageId: string | number): Promise<void> {
    try {
      const msgIdNum = typeof messageId === 'number' ? messageId : parseInt(String(messageId), 10);
      if (!Number.isFinite(msgIdNum)) return;
      await this.bot?.api.deleteMessage(peerId, msgIdNum);
    } catch { /* best effort */ }
  }

  /**
   * TX6: best-effort pin of a message (never throws — the pinned live
   * status card degrades to an unpinned message if the bot lacks pin
   * rights). Silent notification so pinning never buzzes the owner.
   */
  async pinMessageSafe(peerId: string, messageId: string | number): Promise<void> {
    try {
      const msgIdNum = typeof messageId === 'number' ? messageId : parseInt(String(messageId), 10);
      if (!Number.isFinite(msgIdNum)) return;
      await this.bot?.api.pinChatMessage(peerId, msgIdNum, { disable_notification: true });
    } catch { /* best effort */ }
  }

  /**
   * TX11: send the browser-viewport photo bubble (first screencast frame).
   * Returns the message id (base-10 string, like sendForStream) so the
   * viewport can edit it in place. PRIVACY: callers must only target an
   * OWNER DM — enforced upstream in cli.ts (owner + chatType 'dm' gate).
   */
  async sendPhotoForStream(peerId: string, photo: Buffer, caption?: string): Promise<string> {
    if (!this.bot || !this._isConnected) {
      throw new ChannelError('Telegram adapter is not connected', 'channel_not_connected', { peerId });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    const sent = await this.bot.api.sendPhoto(
      peerId,
      new InputFile(photo, 'viewport.jpg'),
      caption ? { caption: caption.slice(0, 1024) } : {},
    );
    return String(sent.message_id);
  }

  /**
   * TX11: swap a fresh screencast frame into the EXISTING viewport photo
   * bubble via editMessageMedia. Only works on a message that already
   * carries media (a text message can never become a photo — which is why
   * the viewport is a separate bubble, not the working card).
   */
  async editPhotoInPlace(peerId: string, messageId: string | number, photo: Buffer, caption?: string): Promise<void> {
    if (!this.bot || !this._isConnected) {
      throw new ChannelError('Telegram adapter is not connected', 'channel_not_connected', { peerId });
    }
    const msgIdNum = typeof messageId === 'number' ? messageId : parseInt(String(messageId), 10);
    if (!Number.isFinite(msgIdNum)) {
      throw new ChannelError('messageId must parse to a finite integer', 'channel_invalid_peer', { messageId });
    }
    await this.bot.api.editMessageMedia(
      peerId,
      msgIdNum,
      InputMediaBuilder.photo(new InputFile(photo, 'viewport.jpg'), caption ? { caption: caption.slice(0, 1024) } : {}),
    );
  }

  /**
   * Send a message with a Telegram InlineKeyboard attached.
   * Falls back to plain send if keyboard fails.
   */
  async sendWithKeyboard(peerId: string, text: string, keyboard: InlineKeyboard): Promise<void> {
    if (!this.bot || !this._isConnected) {
      return this.send(peerId, text);
    }
    // Source budget leaves room for markdown→HTML tag expansion (see
    // MD_SOURCE_CHUNK_LIMIT); rendering is fitted to the wire cap as a backstop.
    const chunks = chunkText(text, MD_SOURCE_CHUNK_LIMIT);
    // Send all but last chunk without the keyboard
    for (let i = 0; i < chunks.length - 1; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      try {
        await this.bot.api.sendMessage(peerId, renderMdWithinLimit(chunk), { parse_mode: 'HTML' });
      } catch (htmlErr) {
        log.warn({ peerId, err: String(htmlErr) }, 'sendWithKeyboard HTML chunk failed — plain fallback');
        await this.bot.api.sendMessage(peerId, chunk);
      }
    }
    // Last chunk gets the keyboard
    const lastChunk = chunks[chunks.length - 1] ?? text.slice(0, 100);
    try {
      await this.bot.api.sendMessage(peerId, renderMdWithinLimit(lastChunk), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (htmlErr) {
      log.warn({ peerId, err: String(htmlErr) }, 'sendWithKeyboard HTML final failed — plain fallback');
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
    // TX4: pass the artifact caption through (Telegram caps captions at 1024).
    await this._sendMedia(peerId, attachment, attachment.caption ? { caption: attachment.caption.slice(0, 1024) } : {});
  }

  // ---------------------------------------------------------------------------
  // Internal handler wiring
  // ---------------------------------------------------------------------------

  private _registerHandlers(bot: Bot): void {
    // Commands
    bot.command('start', (ctx) => this._handleCommand(ctx, 'start'));
    bot.command('help', (ctx) => this._handleCommand(ctx, 'help'));
    bot.command('status', (ctx) => this._handleCommand(ctx, 'status'));
    // TX14/TX27: /memory + /institution — read-only knowledge cards (owner-only).
    for (const [cmd, builder] of [['memory', 'buildMemoryCard'], ['institution', 'buildInstitutionCard']] as const) {
      bot.command(cmd, async (ctx) => {
        const uid = String(ctx.from?.id ?? '');
        if (!this.ownerUsers.has(uid)) return;
        try {
          const cards = await import('./memory-cards.js');
          const { DATA_DIR } = await import('../shared/paths.js');
          const path = await import('node:path');
          const text = builder === 'buildMemoryCard'
            ? cards.buildMemoryCard(path.join(DATA_DIR, 'mind.db'))
            : cards.buildInstitutionCard({
                mindDb: path.join(DATA_DIR, 'mind.db'),
                gatewayDb: path.join(DATA_DIR, 'gateway.db'),
                tracesDb: path.join(DATA_DIR, 'traces.db'),
              });
          await this.send(String(ctx.chat.id), text, { parseMode: 'markdown' });
        } catch (err) {
          log.warn({ cmd, err: String(err) }, 'memory card command failed');
        }
      });
    }

    // TX25: /soul — read-only identity card (owner-only; frozen surfaces).
    bot.command('soul', async (ctx) => {
      const uid = String(ctx.from?.id ?? '');
      if (!this.ownerUsers.has(uid)) return;
      try {
        const { buildSoulCard } = await import('./soul-card.js');
        const { WORKSPACE_DIR } = await import('../shared/paths.js');
        await this.send(String(ctx.chat.id), await buildSoulCard(WORKSPACE_DIR), { parseMode: 'markdown' });
      } catch (err) {
        log.warn({ err: String(err) }, 'TX25 /soul card failed');
      }
    });

    // Inline keyboard callbacks. One grammy handler (an early-returning
    // middleware without next() swallows later ones): TX1 stop taps and TX2
    // reason taps dispatch first, then the fb:{rating}:{feedbackId} feedback taps.
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data ?? '';

      // TX1 (⏹ Stop) / TX2 (👎 reasons) — flag-gated, owner-only inside.
      if (data.startsWith('tx1:') || data.startsWith('tx2:')) {
        const cbMsg = ctx.callbackQuery.message;
        await handleRunControlCallback(
          {
            data,
            fromId: String(ctx.from.id),
            ...(ctx.chat?.id !== undefined ? { chatId: String(ctx.chat.id) } : {}),
            ...(cbMsg?.message_id !== undefined ? { messageId: cbMsg.message_id } : {}),
            ...(cbMsg && 'text' in cbMsg && typeof cbMsg.text === 'string' ? { messageText: cbMsg.text } : {}),
            answer: async (text?: string) => { await ctx.answerCallbackQuery(text ? { text, show_alert: false } : {}); },
            editReplyMarkup: async (kb) => { await ctx.editMessageReplyMarkup({ reply_markup: kb }); },
          },
          {
            isOwner: (id) => this.ownerUsers.has(id),
            getActiveRun: (runKey) => getRunRegistry().get(runKey),
            guard: this._regenGuard,
            onRegenerate: this._onRegenerate,
            recordReason: (feedbackId: string, code: RegenReasonCode) => {
              // Store convention (see fb: handler below): link rows carry the
              // feedbackId in session_id + a typed task_summary marker.
              saveFeedback({
                session_id: feedbackId,
                channel: 'telegram',
                task_summary: `regen-requested:${feedbackId}`,
                task_type: 'general',
                rating: 'skip',
                notes: `tx2 reason=${code}`,
              });
            },
          },
        );
        return;
      }

      // TX10 checkpoint taps  tx10:cp:{id}:{optIdx}. Owner-only; the decision
      // artifact persists BEFORE the waiter unblocks (invariant 8). Stale or
      // double taps are acknowledged but ignored by the protocol.
      if (data.startsWith('tx10:')) {
        if (!this.ownerUsers.has(String(ctx.from.id))) {
          await ctx.answerCallbackQuery({ text: 'Owner only.', show_alert: false });
          return;
        }
        const proto = getCheckpointProtocol();
        const handled = proto ? proto.handleCallback(data, String(ctx.from.id)) : false;
        await ctx.answerCallbackQuery({ text: handled ? 'Recorded ✅' : 'Checkpoint unavailable/decided.', show_alert: false });
        try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* keyboard may be gone */ }
        return;
      }

      // TX13 generative-UI taps  tx13:a:{token} → typed [CANVAS EVENT] fed
      // back as an inbound message (same wire format as the web bridge).
      if (data.startsWith('tx13:')) {
        const uid = String(ctx.from?.id ?? '');
        if (!this._isAllowed(uid)) { await ctx.answerCallbackQuery({ text: 'Not available.', show_alert: false }); return; }
        const { resolveTx13Callback, canvasEventText, telegramGenuiEnabled } = await import('./telegram-genui.js');
        const resolved = telegramGenuiEnabled() ? resolveTx13Callback(data) : null;
        if (!resolved) { await ctx.answerCallbackQuery({ text: 'Expired.', show_alert: false }); return; }
        await ctx.answerCallbackQuery({ text: '▶️', show_alert: false });
        await this._handleInbound(ctx, canvasEventText(resolved.actionId), []);
        return;
      }

      // TX28 provenance taps  tx28:p:{sessionId} → toast, no chat message.
      if (data.startsWith('tx28:')) {
        const uid = String(ctx.from?.id ?? '');
        const { provenanceEnabled, parseProvenanceCallback, lookupProvenance, renderProvenanceToast } = await import('./provenance.js');
        if (!provenanceEnabled() || !this._isAllowed(uid)) { await ctx.answerCallbackQuery({ text: 'Not available.', show_alert: false }); return; }
        const sid = parseProvenanceCallback(data);
        const { DATA_DIR } = await import('../shared/paths.js');
        const path = await import('node:path');
        const row = sid ? lookupProvenance(path.join(DATA_DIR, 'traces.db'), sid) : null;
        await ctx.answerCallbackQuery({ text: renderProvenanceToast(row), show_alert: true });
        return;
      }

      // TX3 (SUDO_TG_DETAIL_TOGGLE=1, default OFF): per-turn working-card
      // detail toggle  tx3:t:{token}. Owner-only; the token maps to the live
      // turn's render state via the working-card-state registry.
      if (data.startsWith('tx3:')) {
        try {
          const uid = String(ctx.from?.id ?? '');
          if (process.env['SUDO_TG_DETAIL_TOGGLE'] !== '1' || !this.ownerUsers.has(uid)) {
            await ctx.answerCallbackQuery({ text: 'Not available.', show_alert: false });
            return;
          }
          const { parseTx3CallbackData, buildWorkingCardRows } = await import('./working-card-keyboard.js');
          const token = parseTx3CallbackData(data);
          if (!token) {
            await ctx.answerCallbackQuery({ text: 'Invalid toggle data.', show_alert: false });
            return;
          }
          const { toggleWorkingCardDetail } = await import('./working-card-state.js');
          const next = toggleWorkingCardDetail(token);
          if (next === null) {
            await ctx.answerCallbackQuery({ text: 'This turn has finished.', show_alert: false });
            return;
          }
          // Refresh the button labels (cosmetic). Prefer the turn owner's
          // full-set builder so a shared card keeps its ⏹ Stop button too.
          try {
            const { getWorkingCardRows } = await import('./working-card-state.js');
            const rows = getWorkingCardRows(token) ?? buildWorkingCardRows({ detail: { token, detailNow: next } });
            const kb = new InlineKeyboard(rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.callbackData }))));
            await ctx.editMessageReplyMarkup({ reply_markup: kb });
          } catch { /* label refresh best-effort — toggle already applied */ }
          await ctx.answerCallbackQuery({ text: next ? '🔎 Step detail on' : '▪ Compact view', show_alert: false });
        } catch (err) {
          log.warn({ err: String(err) }, 'TX3 detail-toggle callback failed');
          try { await ctx.answerCallbackQuery({ text: 'Could not toggle.', show_alert: false }); } catch { /* noop */ }
        }
        return;
      }

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

        // TX2 (SUDO_TG_BAD_REGEN=1): an owner 👎 swaps in the one-tap reason
        // keyboard (Wrong / Too long / Missed the point / Skip reasons) instead
        // of removing the keyboard; the reason tap triggers the regeneration.
        const offerReasons = wantsReasonKeyboard({
          rating: rating,
          isOwnerUser: this.ownerUsers.has(String(ctx.from.id)),
          hasRegenHandler: this._onRegenerate !== null,
        });

        // Remove (or for TX2 bad: replace) the keyboard on the original message
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: offerReasons ? makeReasonKeyboard(feedbackId) : undefined });
        } catch { /* message too old or already edited */ }

        if (rating === 'good') {
          await ctx.answerCallbackQuery({ text: '👍 Got it — great to know!', show_alert: false });
        } else if (rating === 'bad') {
          if (offerReasons) {
            await ctx.answerCallbackQuery({ text: '👎 Noted — what was wrong?', show_alert: false });
          } else {
            await ctx.answerCallbackQuery({ text: '👎 Noted — I\'ll do better. Reply with what was wrong.', show_alert: false });
            // Send a follow-up asking for notes
            try {
              await ctx.reply('What was wrong? (Reply to this message with details — I\'ll learn from it)');
            } catch { /* non-fatal */ }
          }
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
        const token = resolveEnvSecret(this.tokenEnvKey) ?? '';
        const savedPath = token
          ? await downloadTelegramPhoto(bot, photo.file_id, token)
          : undefined;

        if (savedPath) {
          const hint = `[Image attached at ${savedPath}. To see it you MUST call the tool ` +
            `browser.vision with imagePath="${savedPath}" — do NOT use browser.navigate, ` +
            `system.exec, or read the file yourself; those cannot see images and are sandboxed ` +
            `away from this path. browser.vision is the only working way to view it.]`;
          textWithHint = caption ? `${caption}\n${hint}` : hint;
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

    // Documents / files — download, then deliver a non-empty message that names
    // the file (a caption-less file previously arrived as empty content, which
    // AgentLoop.run rejects: "message must be a non-empty string"). Small
    // text-like files get their contents inlined.
    bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const caption = ctx.message.caption ?? '';
      const token = resolveEnvSecret(this.tokenEnvKey) ?? '';
      const dl = token
        ? await downloadTelegramDocument(bot, doc.file_id, token, doc.file_name)
        : undefined;
      const { text, media } = buildDocumentInbound({
        caption,
        filename: doc.file_name ?? doc.file_id,
        mimeType: doc.mime_type ?? 'application/octet-stream',
        savedPath: dl?.path,
        buffer: dl?.buffer,
      });
      return this._handleInbound(ctx, text, media);
    });

    // Voice messages — transcribe with Whisper then process as text
    bot.on('message:voice', async (ctx) => {
      const voice = ctx.message.voice;
      const token = resolveEnvSecret(this.tokenEnvKey) ?? '';
      // The "listening" ack and the eventual voice reply must target the chat
      // (group id in groups), not the sender's user id — otherwise deleteMessage
      // hits the wrong chat and the voice-reply flag (consumed by send() keyed on
      // the delivery target) never fires in groups.
      const chatId = this._replyTargetOf(ctx);

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

        // Owner realtime: route the note through grok's OWN voice agent (grok-as-agent).
        if (grokRealtimeEnabledFor(this.ownerUsers, chatId)) {
          const replyOgg = await grokRealtimeVoiceReply(downloaded.buffer);
          try { if (existsSync(downloaded.path)) unlinkSync(downloaded.path); } catch { /* ignore */ }
          if (replyOgg) {
            if (processingMsgId) { try { await bot.api.deleteMessage(chatId, processingMsgId); } catch { /* ignore */ } }
            await bot.api.sendVoice(chatId, new InputFile(replyOgg, 'voice.ogg'));
            return;
          }
        }
        const stt = getStt(); // owner voice may route STT through the free grok seat
        const result = await stt.transcribe(downloaded.buffer, useGrokVoiceFor(this.ownerUsers, chatId) ? { provider: 'grok' } : {});

        // Clean up temp file
        try { if (existsSync(downloaded.path)) unlinkSync(downloaded.path); } catch { /* ignore */ }

        if (!result.text.trim()) {
          await ctx.reply('❌ Could not understand the voice message. Please speak clearly or try again.');
          return;
        }

        // Delete the "listening..." message
        if (processingMsgId) {
          try { await bot.api.deleteMessage(chatId, processingMsgId); } catch { /* ignore */ }
        }

        log.info({ chatId, text: result.text, lang: result.language }, 'Voice message transcribed');

        // Auto voice-out: mark this peer so the agent's reply is sent back as a
        // Kokoro TTS voice note (consumed by send()). Disable: SUDO_TELEGRAM_VOICE_REPLY=0.
        this._markVoiceReply(chatId);

        // Pass the transcribed text through the normal message pipeline
        // Append a hint so the brain knows it came from voice (for voice reply logic)
        const textWithHint = `${result.text.trim()} [voice message — user may prefer a voice reply]`;
        return this._handleInbound(ctx, textWithHint, []);

      } catch (err) {
        log.error({ err: String(err) }, 'Voice message processing failed');
        if (processingMsgId) {
          try { await bot.api.deleteMessage(chatId, processingMsgId); } catch { /* ignore */ }
        }
        await ctx.reply('❌ Voice processing failed. Please try again or send a text message.');
      }
    });

    // Audio files (voice notes sent as audio, not the voice type)
    bot.on('message:audio', async (ctx) => {
      const audio = ctx.message.audio;
      const token = resolveEnvSecret(this.tokenEnvKey) ?? '';
      const caption = ctx.message.caption ?? '';

      const downloaded = token
        ? await downloadTelegramVoice(bot, audio.file_id, token)
        : undefined;

      if (downloaded) {
        try {
          const stt = getStt();
          const result = await stt.transcribe(downloaded.buffer, useGrokVoiceFor(this.ownerUsers, this._replyTargetOf(ctx)) ? { provider: 'grok' } : {});
          try { if (existsSync(downloaded.path)) unlinkSync(downloaded.path); } catch { /* ignore */ }
          if (result.text.trim()) {
            // Auto voice-out for audio notes too (consumed by send()).
            this._markVoiceReply(this._replyTargetOf(ctx));
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

  /**
   * The reply/delivery target for an inbound update: the chat id (a group id in
   * groups), falling back to the sender id. This is the single source of truth
   * for "where does a reply go" — the voice/audio handlers key the voice-reply
   * marker on it, and `_handleInbound` sets `UnifiedMessage.chatId` from it, so
   * they never drift (a group must not reply into the sender's DM).
   */
  private _replyTargetOf(ctx: Context): string {
    return String(ctx.chat?.id ?? ctx.from?.id ?? 'unknown');
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

  /**
   * GW-6: an unknown sender messaged a pairing-policy channel. Issue (or re-issue)
   * a pairing code and tell them to ask the owner. No agent turn is scheduled.
   */
  private async _handleUnknownSenderPairing(ctx: Context, userId: string, text: string): Promise<void> {
    const outcome = getPairingManager().requestPairing({
      channel: 'telegram', accountId: this.tokenEnvKey, peerId: userId, preview: text,
    });
    if (outcome.status === 'created' || outcome.status === 'pending-exists') {
      try {
        await ctx.reply(
          `You are not approved to message this assistant yet.\n\nShare this pairing code with the owner to be approved:\n\n${outcome.code}\n\n(valid for 1 hour). Your message was NOT delivered — please resend after the owner approves you.`,
        );
      } catch (err) { log.warn({ err }, 'GW-6: pairing code reply failed'); }
      log.info({ userId, status: outcome.status }, 'GW-6: pairing code issued to unknown Telegram sender');
    } else {
      // capped / rate-limited / already-paired → no reply (avoid amplification).
      log.warn({ userId, status: outcome.status }, 'GW-6: pairing request not issued');
    }
  }

  /** GW-6: owner /pair list|approve|deny handler. Adapter-level, zero LLM. */
  private async _handlePairAdmin(ctx: Context, text: string): Promise<void> {
    const parts = text.split(/\s+/);
    const sub = (parts[1] ?? '').toLowerCase();
    const pm = getPairingManager();
    let reply: string;
    if (sub === 'list') {
      const pend = pm.listPending('telegram', this.tokenEnvKey);
      reply = pend.length === 0
        ? 'No pending pairing requests.'
        : 'Pending pairing requests:\n' + pend.map((x) => `• ${x.code} — "${x.firstMessagePreview}"`).join('\n');
    } else if (sub === 'approve' && parts[2]) {
      const entry = pm.approve(parts[2]);
      if (entry) {
        this.allowedUsers.add(entry.peerId);
        reply = `Approved ${entry.code.toUpperCase()}. The sender may now message you — ask them to resend.`;
      } else {
        reply = `No pending request for code ${parts[2]} (expired or already handled).`;
      }
    } else if (sub === 'deny' && parts[2]) {
      reply = pm.deny(parts[2]) ? `Denied ${parts[2]}.` : `No pending request for code ${parts[2]}.`;
    } else {
      reply = 'Usage: /pair list | /pair approve <code> | /pair deny <code>';
    }
    try { await ctx.reply(reply); } catch (err) { log.warn({ err }, 'GW-6: pair admin reply failed'); }
  }

  private async _handleInbound(
    ctx: Context,
    text: string,
    media: MediaAttachment[],
  ): Promise<void> {
    const from = ctx.from;
    const userId = String(from?.id ?? 'unknown');

    if (!this._isAllowed(userId)) {
      // GW-6: on a pairing channel, an unknown sender gets a one-time code
      // (pure adapter-level reply, ZERO LLM) instead of a silent drop. The
      // triggering message is NOT processed — it arrived pre-trust.
      if (this.dmPolicy === 'pairing') {
        await this._handleUnknownSenderPairing(ctx, userId, text);
      } else {
        log.warn({ userId }, 'Message from non-allowlisted user — dropped');
      }
      return;
    }

    // GW-6: owner pairing-admin commands (/pair list|approve|deny). Adapter-level,
    // never an agent turn. Restricted to the original owner allowlist.
    if (text.trim().startsWith('/pair') && this.ownerUsers.has(userId)) {
      await this._handlePairAdmin(ctx, text.trim());
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

    // Safety net: never hand the agent an empty message. AgentLoop.run rejects
    // empty strings ("message must be a non-empty string"), so a media-only
    // message (a file/photo with no caption, or one whose download failed) would
    // surface that error to the user. Describe the attachment(s) instead.
    const safeText = text.trim()
      ? text
      : media.length > 0
        ? `[Received ${media.map((m) => (m.filename ? `${m.type} "${m.filename}"` : m.type)).join(', ')} with no caption.]`
        : '[empty message]';

    const chatType: ChatType = ctx.chat?.type === 'private' ? 'dm' : 'group';
    // Delivery target: the chat the message came from. In a group this is the
    // group id (≠ userId); in a DM it equals userId. Replies MUST go here, not
    // to peerId (the sender), or group replies land in the sender's DM.
    const chatId = this._replyTargetOf(ctx);
    const msg: UnifiedMessage = {
      id: String(ctx.message?.message_id ?? Date.now()),
      channel: 'telegram',
      peerId: userId,
      chatId,
      peerName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || userId,
      chatType,
      text: safeText,
      // Owner attribution for the agent loop (god mode + owner-only policy
      // read this). Sourced from the constructor allowlist — pairing-admitted
      // users are deliberately NOT owners. Without it every Telegram turn,
      // including the owner's own DMs, was unattributed.
      isOwner: this.ownerUsers.has(userId),
      media: media.length > 0 ? media : undefined,
      replyToId: ctx.message?.reply_to_message?.message_id != null
        ? String(ctx.message.reply_to_message.message_id)
        : undefined,
      timestamp: new Date((ctx.message?.date ?? 0) * 1000),
    };

    log.debug({ peerId: userId, chatId, textLen: text.length, chatType }, 'inbound Telegram message');

    // Session ID ties this Telegram message to gateway progress events.
    // Use message ID so concurrent conversations are tracked independently.
    const sessionId = `tg-${userId}-${msg.id}`;

    // Emit message:received — fire-and-forget, must not block message processing.
    void this._safeEmit('message:received', {
      channel: 'telegram' as const,
      sessionId,
      meta: { peerId: userId, text: msg.text, mediaCount: media.length },
    });

    // Instant acknowledgment: react 👀 to the user's message the moment the
    // turn starts (SUDO_TG_REACT_ACK=0 disables). One cheap API call; the
    // user sees uptake before the working card even appears.
    if (process.env['SUDO_TG_REACT_ACK'] !== '0' && ctx.message?.message_id != null) {
      this.bot?.api
        .setMessageReaction(chatId, ctx.message.message_id, [{ type: 'emoji', emoji: '👀' }])
        .catch(() => { /* reactions unavailable in some chats — non-fatal */ });
    }

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

    // Slash command intercept — REGISTERED commands only. An unregistered
    // slash-shaped message ("/summarize this thread") falls through to the
    // agent turn where skill activation can anchor-match it, instead of an
    // "Unknown command" dead end. Telegram's group form "/cmd@OurBot" is
    // normalized before the check (see _resolveCommandText).
    const commandRegistry = this._commandRegistry;
    const commandText = this._resolveCommandText(text);
    if (commandRegistry && commandText !== null && this._commandContextFactory) {
      try {
        const cmdCtx = await this._commandContextFactory(msg);
        if (cmdCtx) {
          const response = await commandRegistry.execute(commandText, cmdCtx);
          stopTyping();
          unsubProgress();
          log.info({ peerId: userId, command: text.split(' ')[0] }, 'Slash command dispatched');
          await this.send(chatId, response, { parseMode: 'plain' });
          return;
        }
      } catch (err) {
        stopTyping();
        unsubProgress();
        log.error({ userId, text, err }, 'Slash command dispatch error');
        try {
          await this.send(chatId, `Error executing command: ${String(err)}`, { parseMode: 'plain' });
        } catch { /* swallow — best effort */ }
        return;
      }
    }

    // BO11/S13: optional progressive-edit working message (SUDO_TG_PROGRESS=1,
    // default OFF → typing-only behavior unchanged). Edits ONE message in place
    // as a live activity timeline: spinner + phase + elapsed + model/context
    // chip, then one line per agent tool step (fed by the gateway turn
    // handler's progress bridge on the `telegram:<peerId>` key). Whimsy verbs
    // surface on the waiting phase when SUDO_WHIMSY=1. SUDO_TG_PROGRESS_KEEP=1
    // leaves a collapsed "✅ Done • Ns • k steps" summary instead of deleting.
    // Fully best-effort: any failure degrades to typing-only.
    // When channel streaming is on (SUDO_STREAM_CHANNELS, prod default), the
    // stream sink's placeholder IS the live activity card (cli.ts wires the
    // timeline into it) — rendering a second card here would double-bubble.
    let stopProgress: (() => void) | null = null;
    if (process.env['SUDO_TG_PROGRESS'] === '1' && process.env['SUDO_STREAM_CHANNELS'] === '0') {
      try {
        const { formatModelContextChip } = await import('./live-state.js');
        const { ActivityTimeline } = await import('./activity-timeline.js');
        const { collectStatusCard, getStatusSources } = await import('../commands/builtin/status-card.js');
        let chip: string | undefined;
        try {
          const card = await collectStatusCard({ ...(getStatusSources() ?? {}) });
          chip = formatModelContextChip(card.model, card.context);
        } catch { /* chip best-effort */ }
        const startMs = Date.now();
        const timeline = new ActivityTimeline();
        let tick = 0;
        const timelineDetail = process.env['SUDO_TG_TIMELINE_DETAIL'] === '1';
        const renderNow = (): string =>
          timeline.render({ nowMs: Date.now(), startMs, tick, detail: timelineDetail, ...(chip ? { chip } : {}), verbIndex: tick });
        // Initial send is plain text (sendForStream has no parse mode) — strip
        // the bold markers there; every subsequent edit renders md → HTML.
        const workingId = await this.sendForStream(chatId, renderNow().replace(/\*\*/g, ''));

        // Edit throttle: the 3s tick keeps elapsed live; tool events request a
        // prompt refresh but never closer than 2s apart (Telegram edit limits).
        let lastEditMs = Date.now();
        const pushEdit = (minGapMs: number): void => {
          const now = Date.now();
          if (now - lastEditMs < minGapMs) return;
          lastEditMs = now;
          void this.editText(chatId, workingId, renderNow(), { format: 'md' }).catch(() => { /* noop/closed edit */ });
        };
        const unsubTimeline = progress.subscribe(`telegram:${userId}`, (ev: ProgressEvent) => {
          timeline.onProgress(ev, Date.now());
          if (ev.type === 'tool_call' || ev.type === 'tool_result') pushEdit(2000);
        });
        const iv = setInterval(() => {
          tick++;
          pushEdit(0);
        }, 3000);
        stopProgress = () => {
          clearInterval(iv);
          unsubTimeline();
          if (process.env['SUDO_TG_PROGRESS_KEEP'] === '1' && timeline.hasActivity) {
            void this.editText(chatId, workingId, timeline.renderFinal({ nowMs: Date.now(), startMs }))
              .catch(() => { /* best effort */ });
          } else {
            void this.bot?.api.deleteMessage(chatId, Number(workingId)).catch(() => { /* best effort */ });
          }
        };
      } catch { /* progressive edit is best-effort */ }
    }

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ userId, err }, 'Message handler error');
    } finally {
      stopTyping();
      unsubProgress();
      stopProgress?.();
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

    // GIFs are classified 'image' but Telegram flattens sendPhoto'd GIFs to a
    // static frame — pickTelegramSendMethod routes them to sendAnimation instead.
    const method = pickTelegramSendMethod(attachment.type, attachment.filename ?? attachment.url ?? undefined);
    switch (method) {
      case 'sendAnimation':
        await this.bot.api.sendAnimation(peerId, source as string, replyParams);
        break;
      case 'sendVideo':
        await this.bot.api.sendVideo(peerId, source as string, replyParams);
        break;
      case 'sendAudio':
        await this.bot.api.sendAudio(peerId, source as string, replyParams);
        break;
      case 'sendDocument':
        await this.bot.api.sendDocument(peerId, source as string, replyParams);
        break;
      default:
        await this.bot.api.sendPhoto(peerId, source as string, replyParams);
    }
  }
}
