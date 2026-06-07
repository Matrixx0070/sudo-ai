/**
 * @file config-io.ts
 * @description Shared helpers for reading and writing the sudo-ai.json5 config
 * file. Used by models.handler.ts and settings.handler.ts.
 *
 * JSON5 is parsed with the json5 library. Writes are done as plain JSON
 * (loses comments, but keeps machine-written values reliable).
 */

import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:config-io');

export const CONFIG_PATH = path.join(process.cwd(), 'config', 'sudo-ai.json5');
export const ENV_PATH    = path.join(process.cwd(), '.env');

// ---------------------------------------------------------------------------
// Config read / write
// ---------------------------------------------------------------------------

/**
 * Read and parse the sudo-ai.json5 config file.
 * Throws on I/O error or JSON parse failure.
 */
export function readConfig(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  } catch (err) {
    log.error({ err, path: CONFIG_PATH }, 'readConfig: failed to read file');
    throw new Error(`Cannot read config file: ${(err as NodeJS.ErrnoException).message}`);
  }

  // Parse with the JSON5 library so single-quoted strings, comments,
  // trailing commas, and unquoted keys are all handled correctly.
  try {
    return JSON5.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.error({ err }, 'readConfig: JSON5 parse failed');
    throw new Error('Config file contains invalid JSON5');
  }
}

/**
 * Write the config object back to the config file as formatted JSON.
 * This overwrites the file (and its comments) with clean JSON.
 * Throws on I/O error.
 */
export function writeConfig(config: Record<string, unknown>): void {
  let json: string;
  try {
    json = JSON.stringify(config, null, 2);
  } catch (err) {
    log.error({ err }, 'writeConfig: serialisation failed');
    throw new Error('Config serialisation failed');
  }
  try {
    fs.writeFileSync(CONFIG_PATH, json + '\n', 'utf-8');
  } catch (err) {
    log.error({ err, path: CONFIG_PATH }, 'writeConfig: failed to write file');
    throw new Error(`Cannot write config file: ${(err as NodeJS.ErrnoException).message}`);
  }
  log.info({ path: CONFIG_PATH }, 'Config file updated');
}

// ---------------------------------------------------------------------------
// .env helpers
// ---------------------------------------------------------------------------

/**
 * Read current .env content as a string. Returns empty string if missing.
 */
export function readEnv(): string {
  try {
    return fs.readFileSync(ENV_PATH, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    log.warn({ err }, 'readEnv: unexpected read error');
    return '';
  }
}

/**
 * Set or update a key=value pair in the .env file.
 * Also sets the value in `process.env` for the current process.
 * Throws on I/O error.
 */
export function updateEnvVar(key: string, value: string): void {
  if (!key || typeof key !== 'string') {
    throw new TypeError('updateEnvVar: key must be a non-empty string');
  }
  const content = readEnv();
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    // Avoid leading blank line if file was empty
    if (lines.length === 1 && lines[0] === '') {
      lines[0] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  try {
    fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
  } catch (err) {
    log.error({ err, key }, 'updateEnvVar: write failed');
    throw new Error(`Cannot write .env: ${(err as NodeJS.ErrnoException).message}`);
  }
  process.env[key] = value;
  log.info({ key }, '.env variable updated');
}
