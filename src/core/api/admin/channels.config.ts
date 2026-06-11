/**
 * @file channels.config.ts
 * @description Config file I/O helpers and constants for the channels admin handler.
 *
 * Intentionally free of route registration so it can be imported without
 * side-effects by other modules that need channel metadata.
 */

import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT, projectPath } from '../../shared/paths.js';

const log = createLogger('api:admin:channels:config');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const CONFIG_PATH = projectPath('config', 'sudo-ai.json5');
export const CONFIG_BAK  = CONFIG_PATH + '.bak';

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

/** Metadata for all channel types known to SUDO-AI. */
export const CHANNEL_TYPES = [
  { type: 'telegram',  name: 'Telegram', icon: 'send' },
  { type: 'discord',   name: 'Discord',  icon: 'hash' },
  { type: 'whatsapp',  name: 'WhatsApp', icon: 'phone' },
  { type: 'slack',     name: 'Slack',    icon: 'slack' },
  { type: 'signal',    name: 'Signal',   icon: 'lock' },
  { type: 'matrix',    name: 'Matrix',   icon: 'grid' },
  { type: 'irc',       name: 'IRC',      icon: 'terminal' },
  { type: 'web',       name: 'Web',      icon: 'globe' },
] as const;

export type ChannelEntry = (typeof CHANNEL_TYPES)[number];

/** Env-var keys for token-based channel authentication. */
export const TOKEN_ENV_KEYS: Record<string, string> = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord:  'DISCORD_BOT_TOKEN',
};

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse the JSON5 config from disk.
 * Returns a plain mutable object. Throws if the file cannot be read.
 */
export function readConfig(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON5.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.error({ err, path: CONFIG_PATH }, 'Failed to read config file');
    throw new Error('Config file unavailable');
  }
}

/**
 * Atomically write a config object back to disk as pretty-printed JSON.
 * Writes to a .bak file first, then renames to prevent partial writes.
 */
export function writeConfig(cfg: Record<string, unknown>): void {
  const serialised = JSON.stringify(cfg, null, 2);
  try {
    fs.writeFileSync(CONFIG_BAK, serialised, 'utf8');
    fs.renameSync(CONFIG_BAK, CONFIG_PATH);
    log.info({ path: CONFIG_PATH }, 'Config written to disk');
  } catch (err) {
    log.error({ err, path: CONFIG_PATH }, 'Failed to write config file');
    throw new Error('Config write failed');
  }
}

/**
 * Return the channels sub-section for a specific channel type.
 * Returns an empty object when the key is absent (e.g. slack, signal, irc).
 */
export function getChannelConfig(
  cfg: Record<string, unknown>,
  type: string,
): Record<string, unknown> {
  const channels = cfg['channels'] as Record<string, unknown> | undefined;
  if (!channels) return {};
  return (channels[type] as Record<string, unknown>) ?? {};
}

/**
 * Infer connection status for a channel.
 * A channel is considered "connected" when it is enabled AND the relevant
 * env var or session directory is present.
 */
export function isLikelyConnected(
  type: string,
  channelCfg: Record<string, unknown>,
): boolean {
  const tokenKey =
    (channelCfg['tokenEnvKey'] as string | undefined) ?? TOKEN_ENV_KEYS[type];
  if (tokenKey) return Boolean(process.env[tokenKey]);

  if (type === 'whatsapp') {
    const sessionPath =
      (channelCfg['sessionPath'] as string | undefined) ?? 'data/whatsapp-session';
    try {
      // path.resolve: returns sessionPath as-is when it is already absolute.
      fs.accessSync(path.resolve(PROJECT_ROOT, sessionPath));
      return true;
    } catch {
      return false;
    }
  }

  // In-process channel (web) — connected when enabled
  if (type === 'web') {
    return Boolean(channelCfg['enabled']);
  }

  return false;
}
