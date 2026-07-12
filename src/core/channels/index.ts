/**
 * @file index.ts
 * @description Public barrel export for the channels module.
 */

export type {
  ChannelType,
  ChatType,
  MediaAttachment,
  UnifiedMessage,
  SendOptions,
  MessageHandler,
} from './types.js';

export type { ChannelAdapter } from './adapter.js';

export { MessageRouter } from './router.js';
export { TelegramAdapter } from './telegram.js';
export { WhatsAppAdapter } from './whatsapp.js';
export { DiscordAdapter } from './discord.js';

export { SlackAdapter } from './slack.js';
export { SignalAdapter } from './signal.js';
export { IMessageAdapter } from './imessage-adapter.js';
export { MatrixAdapter } from './matrix.js';
export { IRCAdapter } from './irc.js';
export { WebAdapter } from './web.js';
export { WebSocketChannel } from './websocket-channel.js';
export type { WSMessageHandler } from './websocket-channel.js';
export { EmailAdapter } from './email.js';
export { SmsAdapter } from './sms.js';
