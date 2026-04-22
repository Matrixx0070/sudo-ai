/**
 * @file adapter.ts
 * @description Abstract contract that every channel adapter must satisfy.
 * The MessageRouter depends only on this interface — never on concrete classes.
 */

import type { ChannelType, MessageHandler, SendOptions } from './types.js';

/**
 * Common interface implemented by Telegram, WhatsApp, Discord, and Electron
 * adapters. Callers interact exclusively with this surface; platform-specific
 * details live behind it.
 */
export interface ChannelAdapter {
  /** Which channel this adapter represents. Used as the registry key. */
  readonly channel: ChannelType;

  /** True once `start()` has completed without error and the bot is listening. */
  readonly isConnected: boolean;

  /**
   * Initialize the adapter and begin receiving messages.
   * Must be idempotent — calling start() on an already-connected adapter
   * should be a no-op or gracefully handle the duplicate call.
   *
   * @throws {ChannelError} if the underlying platform rejects authentication.
   */
  start(): Promise<void>;

  /**
   * Tear down the connection cleanly.
   * Must not throw — log and swallow any error internally.
   */
  stop(): Promise<void>;

  /**
   * Send a text message (and optional media) to a peer.
   *
   * @param peerId  - Platform-specific destination identifier.
   * @param text    - Message body (may be empty when sending media-only).
   * @param options - Optional reply-to, media, and parse-mode overrides.
   * @throws {ChannelError} on unrecoverable send failure.
   */
  send(peerId: string, text: string, options?: SendOptions): Promise<void>;

  /**
   * Register the single handler that will receive every normalized message.
   * Subsequent calls replace the previous handler.
   *
   * @param handler - Async callback; errors must be caught inside the adapter.
   */
  onMessage(handler: MessageHandler): void;
}
