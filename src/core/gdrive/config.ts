/**
 * @file gdrive/config.ts
 * @description Env-driven configuration + fail-fast startup validation for the
 * Drive foundation layer.
 *
 * DECISION (Phase 0): env-only config with a dedicated validator, not a
 * TypeBox sub-schema in config/sudo-ai.json5 — matches how other integrations
 * (email, webhooks kill-switches) are toggled, and keeps the frozen
 * config/sudo-ai.json5 untouched. Revisit when F7 (control-panel) lands.
 *
 * Kill-switch idiom: default-OFF opt-in (`SUDO_GDRIVE=1`) until the
 * foundation is proven live; every later feature phase keeps its own switch.
 */

import { existsSync } from 'node:fs';
import type { GdriveAuthMode, GdriveConfig } from './types.js';

export class GdriveConfigError extends Error {
  constructor(message: string) {
    super(`gdrive config: ${message}`);
    this.name = 'GdriveConfigError';
  }
}

/** Whether the Drive layer is enabled at all (default OFF). */
export function isGdriveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_GDRIVE'] === '1';
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

/**
 * Read + validate the Drive config from env. Throws GdriveConfigError with an
 * actionable message when the layer is enabled but misconfigured. When the
 * layer is disabled, returns a benign disabled config without validating.
 */
export function loadGdriveConfig(env: NodeJS.ProcessEnv = process.env): GdriveConfig {
  const enabled = isGdriveEnabled(env);
  const authMode = (env['GDRIVE_AUTH_MODE'] ?? 'service_account') as GdriveAuthMode;

  const config: GdriveConfig = {
    enabled,
    authMode,
    credentialsPath: env['GOOGLE_APPLICATION_CREDENTIALS'],
    oauthClientFile: env['GDRIVE_OAUTH_CLIENT_FILE'],
    oauthTokenFile: env['GDRIVE_OAUTH_TOKEN_FILE'],
    rootFolderId: env['GDRIVE_ROOT_FOLDER_ID'],
    requestsPerSecond: intEnv(env, 'GDRIVE_RPS', 5, 1),
    burst: intEnv(env, 'GDRIVE_BURST', 10, 1),
    maxRetries: intEnv(env, 'GDRIVE_MAX_RETRIES', 5, 0),
    heartbeatIntervalMs: intEnv(env, 'GDRIVE_HEARTBEAT_MS', 5 * 60 * 1000, 10_000),
  };

  if (!enabled) return config;

  if (authMode !== 'service_account' && authMode !== 'oauth') {
    throw new GdriveConfigError(
      `GDRIVE_AUTH_MODE must be "service_account" or "oauth" (got "${String(authMode)}")`,
    );
  }
  if (authMode === 'service_account') {
    if (!config.credentialsPath) {
      throw new GdriveConfigError(
        'GOOGLE_APPLICATION_CREDENTIALS is required in service_account mode — ' +
          'set it to the service-account JSON key path (see docs/gdrive-setup.md)',
      );
    }
    if (!existsSync(config.credentialsPath)) {
      throw new GdriveConfigError(
        `GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${config.credentialsPath}`,
      );
    }
  } else {
    if (!config.oauthClientFile || !existsSync(config.oauthClientFile)) {
      throw new GdriveConfigError(
        'oauth mode requires GDRIVE_OAUTH_CLIENT_FILE pointing to the OAuth client-secret JSON',
      );
    }
    if (!config.oauthTokenFile) {
      throw new GdriveConfigError(
        'oauth mode requires GDRIVE_OAUTH_TOKEN_FILE (where the loopback flow stores tokens)',
      );
    }
  }
  if (!config.rootFolderId) {
    throw new GdriveConfigError(
      'GDRIVE_ROOT_FOLDER_ID is required — the fileId of the shared "sudo-ai" folder ' +
        '(open it in Drive; the id is the last path segment of the URL)',
    );
  }
  return config;
}
