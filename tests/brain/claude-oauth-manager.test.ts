/**
 * Tests for ClaudeOAuthManager — PKCE generation, persistence, refresh.
 *
 * Network calls are stubbed via globalThis.fetch so we never hit Anthropic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeOAuthManager,
  generatePkceVerifier,
  pkceChallengeFor,
  buildAuthorizeUrl,
} from '../../src/core/brain/claude-oauth-manager.js';

const ORIG_FETCH = globalThis.fetch;
let tmpDir = '';
let storePath = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'claude-oauth-test-'));
  storePath = join(tmpDir, 'claude-oauth.json');
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('PKCE helpers', () => {
  it('generates a verifier of valid base64url length (43 chars)', () => {
    const v = generatePkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it('produces an S256 challenge whose length matches sha256 base64url (43)', () => {
    const v = generatePkceVerifier();
    const c = pkceChallengeFor(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c.length).toBe(43);
  });

  it('builds an authorize URL with all required PKCE params', () => {
    const v = generatePkceVerifier();
    const state = 'abc123';
    const redirectUri = 'http://localhost:39969/callback';
    const url = new URL(buildAuthorizeUrl(v, state, redirectUri));
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallengeFor(v));
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('scope')).toBe('user:inference');
  });
});

describe('ClaudeOAuthManager — login + persistence', () => {
  it('starts with no credentials when store does not exist', () => {
    const mgr = new ClaudeOAuthManager(storePath);
    expect(mgr.isAvailable()).toBe(false);
    expect(mgr.getAccessToken()).toBeNull();
    expect(mgr.getStatus().connected).toBe(false);
  });

  it('completeLogin exchanges code and persists credentials to disk', async () => {
    const mgr = new ClaudeOAuthManager(storePath);
    const pending = mgr.startLogin();
    expect(pending.authorizeUrl).toContain('claude.com/cai/oauth/authorize');
    expect(pending.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      expect(u).toBe('https://platform.claude.com/v1/oauth/token');
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body['grant_type']).toBe('authorization_code');
      expect(body['code_verifier']).toBe(pending.verifier);
      // Code is the raw value — no `#state` concatenation.
      expect(body['code']).toBe('USERCODE');
      expect(body['redirect_uri']).toBe(pending.redirectUri);
      expect(body['client_id']).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(body['state']).toBe(pending.state);
      return new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat-fresh',
          refresh_token: 'rt-fresh',
          expires_in: 3600,
          scope: 'user:inference',
          account: { subscription_type: 'pro' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const creds = await mgr.completeLogin('USERCODE');
    expect(creds.accessToken).toBe('sk-ant-oat-fresh');
    expect(creds.refreshToken).toBe('rt-fresh');
    expect(creds.subscriptionType).toBe('pro');
    expect(mgr.getAccessToken()).toBe('sk-ant-oat-fresh');
    expect(existsSync(storePath)).toBe(true);

    // Persistence: a second manager pointed at the same file picks up the same creds.
    const mgr2 = new ClaudeOAuthManager(storePath);
    expect(mgr2.isAvailable()).toBe(true);
    expect(mgr2.getAccessToken()).toBe('sk-ant-oat-fresh');
  });

  it('completeLogin throws when no login is pending', async () => {
    const mgr = new ClaudeOAuthManager(storePath);
    await expect(mgr.completeLogin('anything')).rejects.toThrow(/No Claude OAuth login in progress/);
  });

  it('completeLogin surfaces token-endpoint errors', async () => {
    const mgr = new ClaudeOAuthManager(storePath);
    mgr.startLogin();
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(mgr.completeLogin('bad-code')).rejects.toThrow(/HTTP 400/);
    expect(mgr.isAvailable()).toBe(false);
  });

  it('extracts the raw code from a pasted full callback URL', async () => {
    const mgr = new ClaudeOAuthManager(storePath);
    const pending = mgr.startLogin();
    let seenCode = '';
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenCode = (JSON.parse(init!.body as string) as { code: string }).code;
      return new Response(
        JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_in: 60 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    // User pastes the entire URL bar contents — we should pull just the code.
    await mgr.completeLogin(`http://localhost:39969/callback?code=USERCODE&state=${pending.state}`);
    expect(seenCode).toBe('USERCODE');
  });

  it('strips a query suffix from a bare pasted code', async () => {
    const mgr = new ClaudeOAuthManager(storePath);
    mgr.startLogin();
    let seenCode = '';
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenCode = (JSON.parse(init!.body as string) as { code: string }).code;
      return new Response(
        JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_in: 60 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await mgr.completeLogin('USERCODE&state=anything');
    expect(seenCode).toBe('USERCODE');
  });
});

describe('ClaudeOAuthManager — refresh + disconnect', () => {
  function seedStore(expiresAt: number): void {
    writeFileSync(
      storePath,
      JSON.stringify({
        accessToken: 'sk-ant-oat-old',
        refreshToken: 'rt-old',
        expiresAt,
        scopes: ['user:inference'],
      }),
    );
  }

  it('getAccessToken returns null inside the refresh buffer', () => {
    seedStore(Date.now() + 5 * 60 * 1000); // 5 min — within 10 min buffer
    const mgr = new ClaudeOAuthManager(storePath);
    expect(mgr.isAvailable()).toBe(true);
    expect(mgr.getAccessToken()).toBeNull();
  });

  it('getAccessToken returns the token outside the refresh buffer', () => {
    seedStore(Date.now() + 60 * 60 * 1000); // 1 hour
    const mgr = new ClaudeOAuthManager(storePath);
    expect(mgr.getAccessToken()).toBe('sk-ant-oat-old');
  });

  it('refreshToken rotates the access token and writes back to disk', async () => {
    seedStore(Date.now() + 60 * 60 * 1000);
    const mgr = new ClaudeOAuthManager(storePath);
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      expect(u).toBe('https://platform.claude.com/v1/oauth/token');
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body['grant_type']).toBe('refresh_token');
      expect(body['client_id']).toBe('claude-code'); // refresh client_id is the legacy slug
      expect(body['refresh_token']).toBe('rt-old');
      return new Response(
        JSON.stringify({ access_token: 'sk-ant-oat-new', refresh_token: 'rt-new', expires_in: 3600 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const ok = await mgr.refreshToken();
    expect(ok).toBe(true);
    expect(mgr.getAccessToken()).toBe('sk-ant-oat-new');

    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as { accessToken: string; refreshToken: string };
    expect(persisted.accessToken).toBe('sk-ant-oat-new');
    expect(persisted.refreshToken).toBe('rt-new');
  });

  it('refreshToken returns false on HTTP error and leaves the old token in place', async () => {
    seedStore(Date.now() + 60 * 60 * 1000);
    const mgr = new ClaudeOAuthManager(storePath);
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as unknown as typeof fetch;
    const ok = await mgr.refreshToken();
    expect(ok).toBe(false);
    expect(mgr.getAccessToken()).toBe('sk-ant-oat-old');
  });

  it('disconnect wipes credentials and the store', () => {
    seedStore(Date.now() + 60 * 60 * 1000);
    const mgr = new ClaudeOAuthManager(storePath);
    expect(mgr.isAvailable()).toBe(true);
    mgr.disconnect();
    expect(mgr.isAvailable()).toBe(false);
    expect(mgr.getStatus().connected).toBe(false);
    const onDisk = readFileSync(storePath, 'utf8');
    expect(onDisk).toBe('{}');
  });
});

describe('ClaudeOAuthManager — models + default selection', () => {
  function seedConnected(): void {
    writeFileSync(
      storePath,
      JSON.stringify({
        accessToken: 'sk-ant-oat-active',
        refreshToken: 'rt',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference'],
      }),
    );
  }

  it('refreshModels caches a trimmed view sorted newest-first', async () => {
    seedConnected();
    const mgr = new ClaudeOAuthManager(storePath);
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      expect(u).toBe('https://api.anthropic.com/v1/models');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-ant-oat-active');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-14T00:00:00Z' },
            { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-28T00:00:00Z' },
            { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-17T00:00:00Z' },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const models = await mgr.refreshModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6']);
    // Persisted to disk so a fresh manager picks them up.
    const mgr2 = new ClaudeOAuthManager(storePath);
    expect(mgr2.listModels().map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6']);
  });

  it('getDefaultModel returns the newest cached model when none picked', async () => {
    seedConnected();
    const mgr = new ClaudeOAuthManager(storePath);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'claude-opus-4-7', display_name: 'Opus 4.7', created_at: '2026-04-14T00:00:00Z' },
              { id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-05-28T00:00:00Z' },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await mgr.refreshModels();
    expect(mgr.getDefaultModel()).toBe('claude-opus-4-8');
  });

  it('setDefaultModel rejects ids not in the cache', async () => {
    seedConnected();
    const mgr = new ClaudeOAuthManager(storePath);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-05-28T00:00:00Z' }] }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await mgr.refreshModels();
    expect(mgr.setDefaultModel('claude-bogus-1')).toBe(false);
    expect(mgr.setDefaultModel('claude-opus-4-8')).toBe(true);
    expect(mgr.getDefaultModel()).toBe('claude-opus-4-8');
  });

  it('getDefaultModel falls back to newest when the picked id was removed', () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accessToken: 'a',
        refreshToken: 'b',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference'],
        defaultModel: 'claude-deprecated',
        models: [
          { id: 'claude-opus-4-7', displayName: 'Opus 4.7', createdAt: '2026-04-14T00:00:00Z' },
          { id: 'claude-opus-4-8', displayName: 'Opus 4.8', createdAt: '2026-05-28T00:00:00Z' },
        ],
        modelsFetchedAt: Date.now(),
      }),
    );
    const mgr = new ClaudeOAuthManager(storePath);
    expect(mgr.getDefaultModel()).toBe('claude-opus-4-8');
  });

  it('refreshModels surfaces HTTP errors verbatim', async () => {
    seedConnected();
    const mgr = new ClaudeOAuthManager(storePath);
    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(mgr.refreshModels()).rejects.toThrow(/HTTP 403/);
  });

  it('listModels returns empty when nothing has been refreshed yet', () => {
    seedConnected();
    const mgr = new ClaudeOAuthManager(storePath);
    expect(mgr.listModels()).toEqual([]);
    expect(mgr.getDefaultModel()).toBeNull();
  });
});

describe('ClaudeOAuthManager — status shape', () => {
  it('reports connected=false with sensible defaults when empty', () => {
    const mgr = new ClaudeOAuthManager(storePath);
    const s = mgr.getStatus();
    expect(s.connected).toBe(false);
    expect(s.expiresAtMs).toBeNull();
    expect(s.expiresInSec).toBeNull();
    expect(s.scopes).toEqual([]);
    expect(s.subscriptionType).toBeNull();
    expect(s.storePath).toBe(storePath);
    expect(s.defaultModel).toBeNull();
    expect(s.modelsCount).toBe(0);
  });

  it('reports connected=true with expiry fields populated when seeded', () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accessToken: 't',
        refreshToken: 'r',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      }),
    );
    const mgr = new ClaudeOAuthManager(storePath);
    const s = mgr.getStatus();
    expect(s.connected).toBe(true);
    expect(s.expiresInSec).toBeGreaterThan(3500);
    expect(s.subscriptionType).toBe('max');
  });
});
