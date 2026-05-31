/**
 * @file channels/github-issues.ts
 * @description GitHub Issues REST API v3 wrapper for AutoBugFix pipeline.
 *
 * Uses native fetch with Bearer token auth. Handles rate limiting (429 responses).
 * Token source: GITHUB_TOKEN env var (vault fallback supported via CredentialStore).
 * Owner/repo: GITHUB_OWNER/GITHUB_REPO env vars, or fallback to git remote.
 *
 * @module channels/github-issues
 */

import { createLogger } from '../shared/logger.js';
import { CredentialStore } from '../security/vault-credentials.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const log = createLogger('channels:github-issues');

const GITHUB_API = 'https://api.github.com';
const GITHUB_VAULT_NS = 'github';
const GITHUB_VAULT_URL = 'https://api.github.com';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface SearchIssuesOptions {
  labels?: string[];
  state?: 'open' | 'closed' | 'all';
  author?: string;
  since?: string; // ISO 8601 date
}

export interface IssueComment {
  body: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubSearchResult {
  total_count: number;
  items: GitHubIssue[];
}

export interface RateLimitStatus {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
  used: number;
}

export interface GitHubIssuesResult<T = unknown> {
  success: boolean;
  issue?: GitHubIssue;
  issues?: GitHubIssue[];
  count?: number;
  comment?: { id: number; url: string };
  rateLimitRemaining?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

async function resolveToken(): Promise<string | null> {
  // 1. Env var (primary)
  const envToken = process.env['GITHUB_TOKEN'];
  if (envToken) return envToken;

  // 2. Vault fallback
  try {
    const store = new CredentialStore(GITHUB_VAULT_NS);
    const cred = await store.getCredential(GITHUB_VAULT_URL);
    if (cred?.token) return cred.token;
    if (cred?.access_token) return cred.access_token;
  } catch {
    // Vault unavailable
  }

  return null;
}

// ---------------------------------------------------------------------------
// Owner/Repo resolution
// ---------------------------------------------------------------------------

async function resolveOwnerRepo(): Promise<{ owner: string; repo: string } | null> {
  // 1. Env vars (primary)
  const owner = process.env['GITHUB_OWNER'];
  const repo = process.env['GITHUB_REPO'];
  if (owner && repo) {
    return { owner, repo };
  }

  // 2. Git remote fallback
  try {
    const { stdout } = await execAsync('git remote get-url origin');
    const url = stdout.trim();

    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+)\/([^.]+)\.git/);
    if (sshMatch) {
      return { owner: sshMatch[1]!, repo: sshMatch[2]! };
    }

    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^.]+)\.git/);
    if (httpsMatch) {
      return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
    }
  } catch {
    // Not a git repo or no origin
  }

  return null;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface GitHubResponse<T> {
  data: T;
  rateLimitRemaining?: number;
}

async function githubRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GitHubResponse<T>> {
  const url = `${GITHUB_API}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sudo-ai-v5',
  };

  const options: RequestInit = {
    method,
    headers,
    signal,
  };

  if (body && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);

  // Extract rate limit info from headers
  const remaining = res.headers.get('x-ratelimit-remaining');
  const rateLimitRemaining = remaining ? parseInt(remaining, 10) : undefined;

  // Handle 429 Too Many Requests
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') || '60';
    throw new RateLimitError(
      `GitHub API rate limit exceeded. Retry after ${retryAfter}s.`,
      rateLimitRemaining ?? 0,
      parseInt(retryAfter, 10),
    );
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new GitHubApiError(res.status, bodyText.slice(0, 500));
  }

  // 204 No Content (e.g., successful label add)
  if (res.status === 204) {
    return { data: {} as T, rateLimitRemaining };
  }

  const data = (await res.json()) as T;
  return { data, rateLimitRemaining };
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GitHubApiError';
  }
}

export class RateLimitError extends GitHubApiError {
  constructor(
    message: string,
    public readonly remaining: number,
    public readonly retryAfterSeconds: number,
  ) {
    super(429, message);
    this.name = 'RateLimitError';
  }
}

export class GitHubNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// GitHubIssuesConnector
// ---------------------------------------------------------------------------

export class GitHubIssuesConnector {
  private token: string | null = null;
  private ownerRepo: { owner: string; repo: string } | null = null;
  private initialized = false;

  /**
   * Initialize connector by resolving token and owner/repo.
   * Call once at startup or before first use.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.token = await resolveToken();
    this.ownerRepo = await resolveOwnerRepo();
    this.initialized = true;

    if (this.token) {
      log.debug('GitHub token resolved');
    } else {
      log.debug('GitHub token not configured');
    }

    if (this.ownerRepo) {
      log.debug({ owner: this.ownerRepo.owner, repo: this.ownerRepo.repo }, 'GitHub repo resolved');
    } else {
      log.debug('GitHub owner/repo not configured');
    }
  }

  /**
   * Check if connector is properly configured.
   * @returns true if token and owner/repo are set
   */
  isConfigured(): boolean {
    return this.token !== null && this.ownerRepo !== null;
  }

  /**
   * Create a new issue.
   */
  async createIssue(options: CreateIssueOptions): Promise<GitHubIssuesResult<GitHubIssue>> {
    try {
      await this.initialize();

      if (!this.token || !this.ownerRepo) {
        return {
          success: false,
          error: 'GitHub not configured — set GITHUB_TOKEN and GITHUB_OWNER/GITHUB_REPO',
        };
      }

      const { data: issue, rateLimitRemaining } = await githubRequest<GitHubIssue>(
        'POST',
        `/repos/${this.ownerRepo.owner}/${this.ownerRepo.repo}/issues`,
        this.token,
        {
          title: options.title,
          body: options.body,
          labels: options.labels,
          assignees: options.assignees,
        },
      );

      log.info({ number: issue.number, title: issue.title }, 'GitHub issue created');

      return {
        success: true,
        issue,
        rateLimitRemaining,
      };
    } catch (err) {
      return this._handleError(err, 'createIssue');
    }
  }

  /**
   * Search issues using GitHub Search API.
   */
  async searchIssues(options: SearchIssuesOptions = {}): Promise<GitHubIssuesResult<GitHubSearchResult>> {
    try {
      await this.initialize();

      if (!this.token || !this.ownerRepo) {
        return {
          success: false,
          error: 'GitHub not configured — set GITHUB_TOKEN and GITHUB_OWNER/GITHUB_REPO',
        };
      }

      // Build search query
      const parts: string[] = [`repo:${this.ownerRepo.owner}/${this.ownerRepo.repo}`];

      if (options.labels && options.labels.length > 0) {
        for (const label of options.labels) {
          parts.push(`label:"${label.replace(/"/g, '\\"')}"`);
        }
      }

      if (options.state) {
        parts.push(`is:${options.state}`);
      } else {
        parts.push('is:issue');
      }

      if (options.author) {
        parts.push(`author:${options.author}`);
      }

      if (options.since) {
        parts.push(`created:>${options.since}`);
      }

      const q = encodeURIComponent(parts.join(' '));
      const { data: result, rateLimitRemaining } = await githubRequest<GitHubSearchResult>(
        'GET',
        `/search/issues?q=${q}&sort=created&order=desc`,
        this.token,
      );

      log.debug({ count: result.total_count }, 'GitHub issues search completed');

      return {
        success: true,
        issues: result.items,
        count: result.total_count,
        rateLimitRemaining,
      };
    } catch (err) {
      return this._handleError(err, 'searchIssues');
    }
  }

  /**
   * Add a comment to an issue.
   */
  async addComment(issueNumber: number, body: string): Promise<GitHubIssuesResult> {
    try {
      await this.initialize();

      if (!this.token || !this.ownerRepo) {
        return {
          success: false,
          error: 'GitHub not configured — set GITHUB_TOKEN and GITHUB_OWNER/GITHUB_REPO',
        };
      }

      const { data: comment, rateLimitRemaining } = await githubRequest<{ id: number; url: string }>(
        'POST',
        `/repos/${this.ownerRepo.owner}/${this.ownerRepo.repo}/issues/${issueNumber}/comments`,
        this.token,
        { body },
      );

      log.info({ issue: issueNumber, commentId: comment.id }, 'Comment added to GitHub issue');

      return {
        success: true,
        comment,
        rateLimitRemaining,
      };
    } catch (err) {
      return this._handleError(err, 'addComment');
    }
  }

  /**
   * Close an issue.
   */
  async closeIssue(issueNumber: number): Promise<GitHubIssuesResult> {
    try {
      await this.initialize();

      if (!this.token || !this.ownerRepo) {
        return {
          success: false,
          error: 'GitHub not configured — set GITHUB_TOKEN and GITHUB_OWNER/GITHUB_REPO',
        };
      }

      const { data: issue, rateLimitRemaining } = await githubRequest<GitHubIssue>(
        'PATCH',
        `/repos/${this.ownerRepo.owner}/${this.ownerRepo.repo}/issues/${issueNumber}`,
        this.token,
        { state: 'closed' },
      );

      log.info({ issue: issueNumber }, 'GitHub issue closed');

      return {
        success: true,
        issue,
        rateLimitRemaining,
      };
    } catch (err) {
      return this._handleError(err, 'closeIssue');
    }
  }

  /**
   * Add a label to an issue.
   */
  async addLabel(issueNumber: number, label: string): Promise<GitHubIssuesResult> {
    try {
      await this.initialize();

      if (!this.token || !this.ownerRepo) {
        return {
          success: false,
          error: 'GitHub not configured — set GITHUB_TOKEN and GITHUB_OWNER/GITHUB_REPO',
        };
      }

      const { data, rateLimitRemaining } = await githubRequest<unknown>(
        'POST',
        `/repos/${this.ownerRepo.owner}/${this.ownerRepo.repo}/issues/${issueNumber}/labels`,
        this.token,
        { labels: [label] },
      );

      log.info({ issue: issueNumber, label }, 'Label added to GitHub issue');

      return {
        success: true,
        rateLimitRemaining,
      };
    } catch (err) {
      return this._handleError(err, 'addLabel');
    }
  }

  /**
   * Get current rate limit status.
   */
  async getRateLimitStatus(): Promise<RateLimitStatus | null> {
    try {
      await this.initialize();

      if (!this.token) {
        return null;
      }

      const { data } = await githubRequest<{
        resources: {
          core: RateLimitStatus;
        };
      }>(
        'GET',
        '/rate_limit',
        this.token,
      );

      return data.resources.core;
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to get rate limit status');
      return null;
    }
  }

  /**
   * Internal error handler.
   */
  private _handleError(err: unknown, method: string): GitHubIssuesResult {
    if (err instanceof RateLimitError) {
      log.warn({ remaining: err.remaining, retryAfter: err.retryAfterSeconds }, `${method}: rate limited`);
      return {
        success: false,
        error: err.message,
        rateLimitRemaining: err.remaining,
      };
    }

    if (err instanceof GitHubApiError) {
      log.error({ status: err.status, method }, 'GitHub API error');
      return {
        success: false,
        error: err.message,
      };
    }

    if (err instanceof GitHubNotConfiguredError) {
      log.error({ method }, 'GitHub not configured');
      return {
        success: false,
        error: err.message,
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, method }, 'Unexpected error');
    return {
      success: false,
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const githubIssuesConnector = new GitHubIssuesConnector();
