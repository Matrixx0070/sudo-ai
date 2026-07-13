/**
 * @file types.ts
 * @description Core type definitions for the SUDO-AI channel abstraction layer.
 * All channel adapters normalize their platform-specific payloads into these
 * unified types so the rest of the system never has to care which transport
 * delivered a message.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Identifies which messaging platform delivered / will deliver a message. */
export type ChannelType =
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'slack'
  | 'signal'
  | 'imessage'
  | 'matrix'
  | 'irc'
  | 'web'
  | 'email'
  | 'sms'
  | 'ide'
  /** Internal channel for autonomous background goal-work sessions (no adapter). */
  | 'autonomy'
  /** Inbound-webhook-triggered agent turns (Spec 4 — POST /v1/hooks/:hookId). */
  | 'hook';

/** Whether the conversation is a direct message or a group/guild channel. */
export type ChatType = 'dm' | 'group';

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * A single media file attached to a message.
 * Either `url` OR `buffer` will be populated depending on the platform;
 * adapters should prefer `url` when available to avoid memory pressure.
 */
export interface MediaAttachment {
  /** MIME type of the media (e.g. "image/jpeg", "video/mp4"). */
  mimeType: string;
  /** Media category for quick-switch routing in the brain. */
  type: 'image' | 'video' | 'audio' | 'document';
  /** Public / signed URL the brain can pass to a vision model. */
  url?: string;
  /** Raw bytes — only populated when a URL is unavailable. */
  buffer?: Buffer;
  /** Original filename if the platform provides one. */
  filename?: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Platform-agnostic representation of an inbound message.
 * Every adapter converts its native event into this shape before handing
 * it to the router.
 */
export interface UnifiedMessage {
  /** Unique message ID (platform-native, stringified). */
  id: string;
  /** Which channel delivered this message. */
  channel: ChannelType;
  /** Platform-specific peer/chat identifier (user ID, JID, DM channel ID…). */
  peerId: string;
  /**
   * Platform conversation/delivery target — where a reply must be sent. On
   * Telegram this is the chat id (a group id for group messages), which differs
   * from `peerId` (the sender's user id) in groups. Absent for channels that do
   * not distinguish the sender from the conversation; callers replying should
   * use `chatId ?? peerId`. `peerId` remains the session/identity key.
   */
  chatId?: string;
  /**
   * Network address of the sender when the transport exposes one (e.g. the web
   * channel's socket remoteAddress). The web peerId is a synthetic `web-<uuid>`
   * that never reveals loopback, so this carries the real IP for the
   * diagnostic-peer / daily-log skip gate. Absent for channels without an IP.
   */
  peerIp?: string;
  /** Human-readable display name of the sender. */
  peerName: string;
  /** Whether this arrived in a DM or a group/guild channel. */
  chatType: ChatType;
  /** Plain-text body of the message. Empty string if media-only. */
  text: string;
  /** Any attached media files. */
  media?: MediaAttachment[];
  /** ID of the message this is a reply to, if any. */
  replyToId?: string;
  /** Wall-clock time when the message was created on the platform. */
  timestamp: Date;
  /**
   * Resolved by the gateway's ChannelAccessPolicy before the handler runs: true
   * when the sender is a configured owner of this channel. Undefined when no
   * access policy is active. Handlers/tools may use this for owner-gated actions.
   */
  isOwner?: boolean;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Options that control how an outgoing message is formatted and sent. */
export interface SendOptions {
  /** Platform message ID to reply to (thread linking). */
  replyToId?: string;
  /** Media attachments to include in the outgoing message. */
  media?: MediaAttachment[];
  /** Preferred text formatting for the outgoing message. */
  parseMode?: 'markdown' | 'html' | 'plain';
  /** If true, synthesise text to speech and send as a voice note (Telegram only). */
  voiceReply?: boolean;
}

// ---------------------------------------------------------------------------
// Handler callback
// ---------------------------------------------------------------------------

/**
 * Async callback invoked by an adapter each time a normalized message arrives.
 * Implementations must not throw — any error should be caught internally.
 */
export type MessageHandler = (msg: UnifiedMessage) => Promise<void>;
