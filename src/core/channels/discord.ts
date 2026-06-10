/**
 * @file discord.ts
 * @description Discord channel adapter using discord.js v14.
 *
 * Features:
 *  - Responds to DMs and guild messages where the bot is @mentioned.
 *  - Allowlist enforcement via channel ID.
 *  - Message chunking at 2000 characters.
 *  - Slash commands: /ask and /status.
 *  - Graceful start / stop lifecycle.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  type Message,
  type Interaction,
} from 'discord.js';
import { createLogger } from '../shared/index.js';
import { ChannelError } from '../shared/index.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  ChatType,
  MediaAttachment,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';

import type { HookContext, HookEvent } from '../hooks/index.js';
import { rateLimiter } from './rate-limit.js';

// ---------------------------------------------------------------------------
// Hook emission support
// ---------------------------------------------------------------------------

/** Minimal hook-emission interface compatible with HookManager. */
export interface HookEmitterLike {
  emit(event: HookEvent, context: HookContext): Promise<void>;
}

const log = createLogger('channels:discord');

/** Discord maximum message length. */
const DISCORD_CHUNK_LIMIT = 2000;

/** Split text into chunks that fit within Discord's limit. */
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

/** Slash command definitions registered on startup. */
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask SUDO-AI a question')
    .addStringOption((opt) =>
      opt.setName('question').setDescription('Your question').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check SUDO-AI status')
    .toJSON(),
];

/**
 * Discord channel adapter.
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'discord';

  private client: Client | null = null;
  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private readonly tokenEnvKey: string;
  private readonly allowedChannelIds: Set<string>;
  private _hooks: HookEmitterLike | null = null;

  /**
   * @param tokenEnvKey        - Env var holding the Discord bot token.
   * @param allowedChannelIds  - Channel IDs the bot may respond in.
   *                             Empty = allow all channels and DMs.
   */
  constructor(tokenEnvKey = 'DISCORD_TOKEN', allowedChannelIds: string[] = []) {
    this.tokenEnvKey = tokenEnvKey;
    this.allowedChannelIds = new Set(allowedChannelIds);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
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
      log.warn({ event, err: String(err) }, 'Discord hook emission failed — continuing');
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('Discord adapter already connected — skipping start');
      return;
    }

    const token = process.env[this.tokenEnvKey];
    if (!token) {
      throw new ChannelError(
        `Discord token not found in env var: ${this.tokenEnvKey}`,
        'channel_auth_missing',
        { envKey: this.tokenEnvKey },
      );
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this._wireEvents(this.client, token);

    try {
      await this.client.login(token);
      log.info('Discord client logged in');
    } catch (err) {
      this._isConnected = false;
      throw new ChannelError('Failed to login to Discord', 'channel_start_failed', {
        cause: String(err),
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.destroy();
      log.info('Discord client destroyed');
    } catch (err) {
      log.error({ err }, 'Discord destroy error (ignored)');
    } finally {
      this._isConnected = false;
      this.client = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async send(peerId: string, text: string, options?: SendOptions): Promise<void> {
    if (!this.client || !this._isConnected) {
      throw new ChannelError('Discord adapter is not connected', 'channel_not_connected', {
        peerId,
      });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }

    try {
      const channel = await this.client.channels.fetch(peerId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel ${peerId} is not a text channel`);
      }

      const chunks = chunkText(text, DISCORD_CHUNK_LIMIT);
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const replyOpts =
          options?.replyToId != null ? { reply: { messageReference: options.replyToId } } : {};
        await (channel as { send: (opts: unknown) => Promise<unknown> }).send({
          content: chunk,
          ...replyOpts,
        });
      }

      log.debug({ peerId, chunks: chunks.length }, 'Discord message sent');

      // Emit message:sent once per send call (not once per chunk).
      void this._safeEmit('message:sent', {
        channel: 'discord',
        meta: { peerId, chunks: chunks.length },
      });
    } catch (err) {
      log.error({ peerId, err }, 'Discord send failed');
      throw new ChannelError('Failed to send Discord message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _wireEvents(client: Client, token: string): void {
    client.once(Events.ClientReady, async (c) => {
      this._isConnected = true;
      log.info({ username: c.user.tag }, 'Discord bot ready');
      await this._registerSlashCommands(c.user.id, token);
    });

    client.on(Events.MessageCreate, (msg) => {
      void this._handleMessage(msg);
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void this._handleInteraction(interaction);
    });

    client.on(Events.Error, (err) => {
      log.error({ err }, 'Discord client error');
    });

    client.on(Events.Warn, (warn) => {
      log.warn({ warn }, 'Discord client warning');
    });
  }

  private _isAllowedChannel(channelId: string, isDM: boolean): boolean {
    // DMs always pass when allowlist is empty; when populated, DMs are passed through only if
    // explicitly listed (use 'dm' sentinel check below or empty allowlist).
    if (this.allowedChannelIds.size === 0) return true;
    if (isDM) return this.allowedChannelIds.has('dm'); // DMs only allowed when 'dm' sentinel is in allowlist
    return this.allowedChannelIds.has(channelId);
  }

  private async _handleMessage(msg: Message): Promise<void> {
    // Ignore bots (including self)
    if (msg.author.bot) return;

    const isDM = msg.channel.isDMBased();
    const isGuild = !isDM;

    // In guilds, only respond when mentioned
    if (isGuild && !msg.mentions.has(msg.client.user?.id ?? '')) return;

    if (!this._isAllowedChannel(msg.channelId, isDM)) {
      log.debug({ channelId: msg.channelId }, 'Discord message in non-allowed channel — ignored');
      return;
    }

    // Per-peer rate limiting
    const rl = await rateLimiter.check('discord', msg.channelId);
    if (!rl.allowed) {
      if (!rl.burstWarned) {
        const secs = Math.ceil((rl.retryAfterMs ?? 60000) / 1000);
        try { await (msg.channel as { send(s: string): Promise<unknown> }).send(
          `Please slow down — try again in ${secs}s`
        ); } catch { /* ignore */ }
      }
      return;
    }

    // Strip mention from text
    const cleanText = msg.content
      .replace(/<@!?[\d]+>/g, '')
      .trim();

    const media = this._extractMedia(msg);

    const unified: UnifiedMessage = {
      id: msg.id,
      channel: 'discord',
      peerId: msg.channelId,
      peerName: msg.author.displayName ?? msg.author.username,
      chatType: isDM ? 'dm' : ('group' as ChatType),
      text: cleanText,
      media: media.length > 0 ? media : undefined,
      replyToId: msg.reference?.messageId ?? undefined,
      timestamp: msg.createdAt,
    };

    log.debug({ peerId: msg.channelId, textLen: cleanText.length }, 'inbound Discord message');
    await this._dispatch(unified);
  }

  private async _handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, channelId } = interaction;
    const userId = interaction.user.id;

    if (!this._isAllowedChannel(channelId ?? '', interaction.channel?.isDMBased() ?? false)) {
      await interaction.reply({ content: 'This command is not available here.', ephemeral: true });
      return;
    }

    if (commandName === 'status') {
      await interaction.reply({ content: 'SUDO-AI is online and operational.', ephemeral: true });
      return;
    }

    if (commandName === 'ask') {
      // Rate-limit check BEFORE deferReply — once deferReply() is called,
      // interaction.reply() is no longer valid and we cannot send an ephemeral
      // rate-limit message.  Use userId (not channelId) since slash commands
      // are user-initiated actions.
      const rl = await rateLimiter.check('discord', userId);
      if (!rl.allowed) {
        if (!rl.burstWarned) {
          await interaction.reply({ content: `Please slow down — try again in ${Math.ceil(rl.retryAfterMs! / 1000)}s.`, ephemeral: true });
        } else {
          await interaction.reply({ content: 'Rate limited.', ephemeral: true });
        }
        return;
      }

      const question = interaction.options.getString('question', true);
      await interaction.deferReply();

      const unified: UnifiedMessage = {
        id: interaction.id,
        channel: 'discord',
        peerId: channelId ?? userId,
        peerName: interaction.user.displayName ?? interaction.user.username,
        chatType: interaction.channel?.isDMBased() ? 'dm' : 'group',
        text: question,
        timestamp: new Date(),
      };

      await this._dispatch(unified);
    }
  }

  private async _dispatch(msg: UnifiedMessage): Promise<void> {
    if (!this._handler) {
      log.warn({ peerId: msg.peerId }, 'No handler registered — Discord message dropped');
      return;
    }

    // Emit message:received — fire-and-forget, must not block message processing.
    void this._safeEmit('message:received', {
      channel: 'discord',
      meta: { peerId: msg.peerId, text: msg.text, mediaCount: msg.media?.length ?? 0 },
    });

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ peerId: msg.peerId, err }, 'Discord message handler error');
    }
  }

  private _extractMedia(msg: Message): MediaAttachment[] {
    const attachments: MediaAttachment[] = [];
    for (const [, att] of msg.attachments) {
      const mime = att.contentType ?? 'application/octet-stream';
      let type: MediaAttachment['type'] = 'document';
      if (mime.startsWith('image/')) type = 'image';
      else if (mime.startsWith('video/')) type = 'video';
      else if (mime.startsWith('audio/')) type = 'audio';

      attachments.push({
        type,
        mimeType: mime,
        url: att.url,
        filename: att.name ?? undefined,
      });
    }
    return attachments;
  }

  private async _registerSlashCommands(clientId: string, token: string): Promise<void> {
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(Routes.applicationCommands(clientId), { body: SLASH_COMMANDS });
      log.info('Discord slash commands registered globally');
    } catch (err) {
      log.error({ err }, 'Failed to register Discord slash commands (non-fatal)');
    }
  }
}
