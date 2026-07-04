/**
 * @file claude-token-manager.ts
 * @description Auto-refreshing OAuth token manager for Claude Max credentials.
 * Reads /root/.claude/.credentials.json, refreshes 10 min before expiry, writes back.
 * Never throws on missing/malformed credentials.
 */

import { readFileSync, existsSync } from 'node:fs';
import { writeFileAtomic } from '../shared/atomic-write.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:claude-token');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = '/root/.claude/.credentials.json';
// Endpoint host moved from console.anthropic.com → platform.claude.com.
// The old URL now 404s; the new host is the one claude-code itself uses
// (verified by intercepting `claude setup-token` on 2026-06-14).
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
// Refresh now requires the UUID client_id; the legacy 'claude-code' slug
// started returning 400 "Invalid request format" on 2026-06-15.
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh the token this many ms before it expires (10 minutes). */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** How often the auto-refresh timer checks expiry (30 minutes). */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** How often cli.ts polls for a newly refreshed token (1 minute). */
export const TOKEN_POLL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
}

interface RawCredentialsFile {
  claudeAiOauth?: ClaudeOAuthCredentials;
  [key: string]: unknown;
}

interface TokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  /** Lifetime in seconds. Anthropic default: 28800 (8 hours). */
  expires_in?: number;
}

// ---------------------------------------------------------------------------
// ClaudeTokenManager
// ---------------------------------------------------------------------------

export class ClaudeTokenManager {
  private credentials: ClaudeOAuthCredentials | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.loadCredentials();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Load credentials from Claude Code's credentials file.
   * Safe: logs warnings on any error; never throws.
   */
  private loadCredentials(): void {
    try {
      if (!existsSync(CREDENTIALS_PATH)) {
        log.warn(
          { path: CREDENTIALS_PATH },
          'Claude credentials file not found — Claude provider unavailable',
        );
        return;
      }

      const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as RawCredentialsFile;
      const creds = raw.claudeAiOauth ?? null;

      if (!creds) {
        log.warn('claudeAiOauth key missing in credentials file — Claude provider unavailable');
        return;
      }

      if (!creds.accessToken || !creds.refreshToken || !creds.expiresAt) {
        log.warn(
          { hasAccess: !!creds.accessToken, hasRefresh: !!creds.refreshToken },
          'Incomplete Claude credentials — Claude provider unavailable',
        );
        return;
      }

      this.credentials = creds;

      log.info(
        {
          subscriptionType: this.credentials.subscriptionType,
          scopes: this.credentials.scopes,
          expiresIn: Math.round((this.credentials.expiresAt - Date.now()) / 60_000) + ' min',
        },
        'Claude OAuth credentials loaded',
      );
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to load Claude credentials — Claude provider unavailable');
    }
  }

  /**
   * Persist updated credentials back to disk so Claude Code CLI stays in sync.
   * Safe: logs errors; never throws.
   */
  private saveCredentials(): void {
    if (!this.credentials) return;

    try {
      const raw: RawCredentialsFile = existsSync(CREDENTIALS_PATH)
        ? (JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as RawCredentialsFile)
        : {};

      raw.claudeAiOauth = this.credentials;
      // Atomic: a torn write here would corrupt the shared Claude credentials and
      // break auth (the 401-storm failure mode).
      writeFileAtomic(CREDENTIALS_PATH, JSON.stringify(raw, null, 2));
      log.debug({ path: CREDENTIALS_PATH }, 'Claude credentials saved to disk');
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to save Claude credentials — token still active in memory');
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the current access token if valid and not within the refresh buffer.
   * Returns null when credentials are absent or when a refresh is imminently needed.
   */
  getAccessToken(): string | null {
    if (!this.credentials) return null;

    const timeLeft = this.credentials.expiresAt - Date.now();
    if (timeLeft < REFRESH_BUFFER_MS) {
      log.debug(
        { timeLeftMin: Math.round(timeLeft / 60_000) },
        'Claude token expired or expiring soon — refresh needed',
      );
      return null;
    }

    return this.credentials.accessToken;
  }

  /**
   * Attempt to refresh the access token via Anthropic's OAuth endpoint.
   * Updates in-memory credentials and writes to disk on success.
   *
   * @returns true on success, false on any failure.
   */
  async refreshToken(): Promise<boolean> {
    if (!this.credentials?.refreshToken) {
      log.warn('No refresh token available — cannot refresh Claude token');
      return false;
    }

    log.info('Refreshing Claude OAuth token...');

    let res: Response;
    try {
      res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: this.credentials.refreshToken,
          client_id: CLAUDE_CODE_CLIENT_ID,
        }),
      });
    } catch (err) {
      log.error({ err: String(err) }, 'Claude token refresh network error');
      return false;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)');
      log.error(
        { status: res.status, statusText: res.statusText, body: errText.substring(0, 300) },
        'Claude token refresh HTTP error',
      );
      return false;
    }

    let data: TokenRefreshResponse;
    try {
      data = (await res.json()) as TokenRefreshResponse;
    } catch (err) {
      log.error({ err: String(err) }, 'Claude token refresh response is not valid JSON');
      return false;
    }

    if (!data.access_token) {
      log.error({ data }, 'Claude token refresh response missing access_token');
      return false;
    }

    // Apply the new token values.
    this.credentials.accessToken = data.access_token;
    if (data.refresh_token) {
      this.credentials.refreshToken = data.refresh_token;
    }
    // expires_in is in seconds; default 8 hours if omitted.
    this.credentials.expiresAt = Date.now() + (data.expires_in ?? 28_800) * 1_000;

    this.saveCredentials();

    log.info(
      { expiresIn: Math.round((this.credentials.expiresAt - Date.now()) / 60_000) + ' min' },
      'Claude token refreshed successfully',
    );

    return true;
  }

  /**
   * Start the background timer that checks token expiry every 30 minutes.
   * Performs an immediate check on start.
   * Safe to call multiple times — only one timer runs at a time.
   */
  startAutoRefresh(): void {
    if (this.refreshTimer) {
      log.debug('Claude token auto-refresh already running — skipping duplicate start');
      return;
    }

    // Immediate check: refresh now if already within buffer.
    if (this.credentials) {
      const timeLeft = this.credentials.expiresAt - Date.now();
      if (timeLeft < REFRESH_BUFFER_MS) {
        log.info('Token within refresh buffer at startup — refreshing immediately');
        this.refreshToken().catch((err: unknown) => {
          log.error({ err: String(err) }, 'Immediate token refresh failed');
        });
      }
    }

    this.refreshTimer = setInterval(() => {
      void this.checkAndRefresh();
    }, CHECK_INTERVAL_MS);

    // Prevent this timer from keeping the process alive if everything else exits.
    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }

    log.info(
      { checkIntervalMin: CHECK_INTERVAL_MS / 60_000, bufferMin: REFRESH_BUFFER_MS / 60_000 },
      'Claude token auto-refresh started',
    );
  }

  /**
   * Stop the background auto-refresh timer.
   */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      log.info('Claude token auto-refresh stopped');
    }
  }

  /**
   * Check expiry and refresh if within the buffer window.
   * Called by the interval timer; also available for testing.
   */
  async checkAndRefresh(): Promise<void> {
    if (!this.credentials) {
      // Try loading again — user may have signed in to Claude Code after boot.
      log.debug('No credentials in memory — attempting reload from disk');
      this.loadCredentials();
      return;
    }

    const timeLeft = this.credentials.expiresAt - Date.now();

    if (timeLeft < REFRESH_BUFFER_MS) {
      log.info(
        { timeLeftMin: Math.round(timeLeft / 60_000) },
        'Claude token within refresh buffer — refreshing',
      );
      const ok = await this.refreshToken();
      if (!ok) {
        log.warn('Auto-refresh failed — will retry on next interval');
      }
    } else {
      log.debug(
        { expiresIn: Math.round(timeLeft / 60_000) + ' min' },
        'Claude token still valid — no refresh needed',
      );
    }
  }

  /**
   * Return true when credentials are loaded and the access token is non-empty.
   * Does not check expiry — use getAccessToken() for a validity-checked token.
   */
  isAvailable(): boolean {
    return this.credentials !== null && this.credentials.accessToken.length > 0;
  }
}
