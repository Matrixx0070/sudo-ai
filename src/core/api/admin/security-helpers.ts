/**
 * @file admin/security-helpers.ts
 * @description Token store and credential helpers for security.handler.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readConfig, writeConfig } from './config-io.js';
import { createLogger } from '../../shared/logger.js';
import { DATA_DIR } from '../../shared/paths.js';

const log = createLogger('api:admin:security-helpers');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TOKENS_FILE = path.join(DATA_DIR, 'api-tokens.json');

export const SENSITIVE_KEYS = [
  'XAI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'SUDO_AI_VAULT_KEY',
  'SUDO_AI_DASHBOARD_TOKEN',
  'SUDO_AI_API_TOKEN',
  'YOUTUBE_API_KEY',
  'XAI_VOICE_API_KEY',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredToken {
  id: string;
  name: string;
  prefix: string;    // first 8 chars of the raw token
  hash: string;      // SHA-256(raw token) as hex
  createdAt: string;
  lastUsed: string | null;
}

// ---------------------------------------------------------------------------
// Token store helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  const dir = DATA_DIR;
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.error({ err }, 'ensureDataDir: failed to create data/');
    }
  }
}

export function loadTokens(): StoredToken[] {
  ensureDataDir();
  try {
    if (!fs.existsSync(TOKENS_FILE)) return [];
    const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredToken[];
  } catch (err) {
    log.warn({ err }, 'loadTokens: returning empty list');
    return [];
  }
}

export function saveTokens(tokens: StoredToken[]): void {
  ensureDataDir();
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2) + '\n', 'utf-8');
  } catch (err) {
    log.error({ err }, 'saveTokens: write failed');
    throw new Error('Failed to persist token store');
  }
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateTokenId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Credential masking
// ---------------------------------------------------------------------------

export function maskValue(value: string): string {
  if (!value || value.length <= 8) return '***';
  return value.slice(0, 4) + '...' + value.slice(-4);
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

export function getCorsOrigins(): string[] {
  const envVal = process.env['SUDO_AI_CORS_ORIGINS'];
  if (envVal) {
    return envVal.split(',').map((o) => o.trim()).filter(Boolean);
  }

  try {
    const config = readConfig();
    const server = config['server'] as Record<string, unknown> | undefined;
    if (!server) return [];
    const origins = server['corsOrigins'];
    if (Array.isArray(origins)) {
      return origins.filter((o): o is string => typeof o === 'string');
    }
    if (typeof origins === 'string') return [origins];
    return [];
  } catch (err) {
    log.warn({ err }, 'getCorsOrigins: failed to read config');
    return [];
  }
}

export function setCorsOrigins(origins: string[]): void {
  const joined = origins.join(',');
  process.env['SUDO_AI_CORS_ORIGINS'] = joined;

  try {
    const config = readConfig();
    const server = (config['server'] as Record<string, unknown>) ?? {};
    server['corsOrigins'] = origins;
    config['server'] = server;
    writeConfig(config);
  } catch (err) {
    log.warn({ err }, 'setCorsOrigins: could not persist to config file — env var updated');
  }
}
