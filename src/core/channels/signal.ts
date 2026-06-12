/**
 * @file signal.ts
 * @description Signal channel adapter using signal-cli subprocess.
 *
 * Requires signal-cli to be installed and the account registered under
 * SIGNAL_PHONE_NUMBER.  If signal-cli is absent the adapter logs a warning
 * and no-ops gracefully.
 *
 * Receive path: polling `signal-cli receive --json` every 2 seconds.
 * Send path:    `signal-cli send -m "…" <recipient>`.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';
import { ChannelError } from '../shared/errors.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';

const execFileAsync = promisify(execFile);
const log = createLogger('channels:signal');

const POLL_INTERVAL_MS = 2_000;
const CLI_BINARY = 'signal-cli';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isCLIAvailable(): Promise<boolean> {
  try {
    await execFileAsync(CLI_BINARY, ['--version']);
    return true;
  } catch {
    return false;
  }
}

interface SignalEnvelope {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    dataMessage?: { message?: string; timestamp?: number };
    timestamp?: number;
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SignalAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'signal';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _cliAvailable = false;
  private readonly _phoneNumber: string;

  constructor() {
    const phone = process.env['SIGNAL_PHONE_NUMBER'];
    if (!phone) {
      throw new ChannelError(
        'SIGNAL_PHONE_NUMBER env var is required',
        'channel_auth_missing',
        { envKey: 'SIGNAL_PHONE_NUMBER' },
      );
    }
    this._phoneNumber = phone;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('Signal adapter already connected — skipping start');
      return;
    }

    this._cliAvailable = await isCLIAvailable();
    if (!this._cliAvailable) {
      log.warn(
        'signal-cli not found in PATH — Signal adapter running in no-op mode. ' +
          'Install signal-cli to enable Signal support.',
      );
      this._isConnected = true;
      return;
    }

    this._pollTimer = setInterval(() => void this._poll(), POLL_INTERVAL_MS);
    this._isConnected = true;
    log.info({ phone: this._phoneNumber }, 'Signal adapter connected (polling)');
  }

  async stop(): Promise<void> {
    try {
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
    } catch (err) {
      log.error({ err }, 'Error stopping Signal adapter');
    } finally {
      this._isConnected = false;
      log.info('Signal adapter stopped');
    }
  }

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    if (!this._isConnected) {
      throw new ChannelError('Signal adapter is not connected', 'channel_not_connected', {
        peerId,
      });
    }
    if (!this._cliAvailable) {
      log.warn({ peerId }, 'signal-cli unavailable — send skipped');
      return;
    }

    try {
      await execFileAsync(CLI_BINARY, ['-a', this._phoneNumber, 'send', '-m', text, peerId]);
      log.debug({ peerId, textLen: text.length }, 'Signal message sent');
    } catch (err) {
      log.error({ peerId, err }, 'Signal send failed');
      throw new ChannelError('Failed to send Signal message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private async _poll(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(CLI_BINARY, [
        '-a',
        this._phoneNumber,
        'receive',
        '--json',
        '--timeout',
        '1',
      ]);

      if (!stdout.trim()) return;

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as SignalEnvelope;
          await this._dispatch(parsed);
        } catch (parseErr) {
          log.warn({ line, parseErr }, 'Signal: could not parse receive output line');
        }
      }
    } catch (err) {
      // signal-cli returns exit-code 1 when no messages — that is normal.
      const msg = String(err);
      if (!msg.includes('exit code 1') && !msg.includes('No messages')) {
        log.error({ err }, 'Signal poll error');
      }
    }
  }

  private async _dispatch(envelope: SignalEnvelope): Promise<void> {
    const inner = envelope.envelope;
    if (!inner?.dataMessage?.message) return;
    if (!this._handler) {
      log.warn('No handler registered — Signal message dropped');
      return;
    }

    const sender = inner.sourceNumber ?? inner.source ?? 'unknown';
    const msg: UnifiedMessage = {
      id: String(inner.dataMessage.timestamp ?? inner.timestamp ?? Date.now()),
      channel: 'signal',
      peerId: sender,
      peerName: inner.sourceName ?? sender,
      chatType: 'dm',
      text: inner.dataMessage.message,
      timestamp: new Date(inner.dataMessage.timestamp ?? inner.timestamp ?? Date.now()),
    };

    log.debug({ sender, textLen: msg.text.length }, 'inbound Signal message');

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ sender, err }, 'Signal message handler error');
    }
  }
}
