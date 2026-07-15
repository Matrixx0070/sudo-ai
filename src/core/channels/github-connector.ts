/**
 * @file channels/github-connector.ts
 * @description GitHub Notifications API connector via PAT (Personal Access Token).
 *
 * Token source: vault namespace 'github', mcp_server_url 'https://api.github.com'.
 * Falls back to GITHUB_TOKEN env var if vault is not configured.
 *
 * API used: GET /notifications (GitHub REST API v3, no SDK — raw fetch only).
 * Zero new npm dependencies.
 *
 * Setup:
 *   Store your GitHub PAT in the vault:
 *     POST /v1/vaults/github/credentials
 *     { type: 'static_bearer', mcp_server_url: 'https://api.github.com', token: 'ghp_...' }
 *   OR set GITHUB_TOKEN env var.
 *
 * @module channels/github-connector
 */

import { createLogger } from '../shared/logger.js';
import { CredentialStore } from '../security/vault-credentials.js';
import { resolveEnvSecret } from '../secrets/secret-ref.js';

const log = createLogger('channels:github');

const GITHUB_API = 'https://api.github.com';
const GITHUB_VAULT_NS = 'github';
const GITHUB_VAULT_URL = 'https://api.github.com';
const MAX_NOTIFICATIONS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubNotification {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  subject: {
    title: string;
    type: string;
    url: string | null;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
}

export interface GitHubNotificationsResult {
  success: boolean;
  notifications?: GitHubNotification[];
  count?: number;
  output: string;
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

async function resolveToken(): Promise<string | null> {
  // 1. Vault-first
  try {
    const store = new CredentialStore(GITHUB_VAULT_NS);
    const cred = await store.getCredential(GITHUB_VAULT_URL);
    if (cred?.token) return cred.token;
    if (cred?.access_token) return cred.access_token;
  } catch {
    // Vault unavailable — fall through to env
  }

  // 2. Env fallback
  const envToken = resolveEnvSecret('GITHUB_TOKEN') ?? undefined;
  if (envToken) return envToken;

  return null;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function githubGet(
  path: string,
  token: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const qs = Object.keys(params).length > 0
    ? '?' + new URLSearchParams(params).toString()
    : '';

  const res = await fetch(`${GITHUB_API}${path}${qs}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sudo-ai-v5',
    },
    signal,
  });

  if (res.status === 304) {
    return [];
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List unread GitHub notifications for the authenticated user.
 *
 * @param limit  - Maximum notifications to return (capped at 50).
 * @param signal - Optional AbortSignal for timeout.
 * @returns Notification list or error result.
 */
export async function listGitHubNotifications(
  limit = 20,
  signal?: AbortSignal,
): Promise<GitHubNotificationsResult> {
  const token = await resolveToken();
  if (!token) {
    return {
      success: false,
      output: 'GitHub not configured — set GITHUB_TOKEN env var or store PAT in vault (namespace: github, url: https://api.github.com)',
    };
  }

  try {
    const data = await githubGet(
      '/notifications',
      token,
      { all: 'false', per_page: String(Math.min(limit, MAX_NOTIFICATIONS)) },
      signal,
    ) as GitHubNotification[];

    const notifications = Array.isArray(data) ? data : [];

    log.info({ count: notifications.length }, 'GitHub notifications fetched');

    return {
      success: true,
      notifications,
      count: notifications.length,
      output: `Found ${notifications.length} unread notification(s).`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'GitHub notifications fetch failed');
    return { success: false, output: `github-connector error: ${msg}` };
  }
}
