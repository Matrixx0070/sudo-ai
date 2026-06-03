/**
 * Tests for profile-manager.ts and profile-routes.ts.
 *
 * Tests cover:
 * - createProfile, getProfile, listProfiles, deleteProfile
 * - activateProfile, getActiveProfile
 * - cloneProfile (deep copies config, env, skills)
 * - Kill-switch SUDO_PROFILES_DISABLE=1
 * - REST route handlers with mock req/res
 * - Profile isolation (different env vars per profile)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileManager, profileManager } from '../../src/core/profiles/profile-manager.js';
import { registerProfileRoutes } from '../../src/core/profiles/profile-routes.js';
import type { ProfileCreateOptions } from '../../src/core/profiles/profile-types.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testProfilesDir: string;

beforeEach(() => {
  // Create unique temp directory for each test
  testProfilesDir = mkdtempSync(join(tmpdir(), 'sudo-profiles-test-'));

  // Set test DATA_DIR to isolated temp directory
  process.env['DATA_DIR'] = testProfilesDir;
  delete process.env['SUDO_PROFILES_DISABLE'];
  delete process.env['SUDO_ACTIVE_PROFILE'];
});

afterEach(() => {
  // Clean up temp directory
  try {
    rmSync(testProfilesDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  delete process.env['SUDO_PROFILES_DISABLE'];
  delete process.env['SUDO_ACTIVE_PROFILE'];
});

// ---------------------------------------------------------------------------
// ProfileManager tests
// ---------------------------------------------------------------------------

describe('ProfileManager', () => {
  describe('createProfile', () => {
    it('creates a new profile with minimal options', () => {
      const manager = new ProfileManager();
      const profile = manager.createProfile({ name: 'test-profile' });

      expect(profile.name).toBe('test-profile');
      expect(profile.displayName).toBe('test-profile');
      expect(profile.config).toEqual({});
      expect(profile.env).toEqual({});
      expect(profile.skills).toEqual([]);
      expect(profile.enabled).toBe(true);
      expect(profile.createdAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();
    });

    it('creates a profile with all options', () => {
      const manager = new ProfileManager();
      const options: ProfileCreateOptions = {
        name: 'full-profile',
        displayName: 'Full Profile',
        config: { maxIterations: 50 },
        env: { CUSTOM_VAR: 'value' },
        soulMd: '# Custom SOUL',
        skills: ['skill-1', 'skill-2'],
      };

      const profile = manager.createProfile(options);

      expect(profile.name).toBe('full-profile');
      expect(profile.displayName).toBe('Full Profile');
      expect(profile.config).toEqual({ maxIterations: 50 });
      expect(profile.env).toEqual({ CUSTOM_VAR: 'value' });
      expect(profile.soulMd).toBe('# Custom SOUL');
      expect(profile.skills).toEqual(['skill-1', 'skill-2']);
    });

    it('throws on duplicate profile name', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'duplicate' });

      expect(() => manager.createProfile({ name: 'duplicate' })).toThrow('already exists');
    });

    it('throws on invalid profile name (path traversal)', () => {
      const manager = new ProfileManager();
      expect(() => manager.createProfile({ name: '../etc/passwd' })).toThrow('disallowed characters');
    });

    it('throws on empty profile name', () => {
      const manager = new ProfileManager();
      expect(() => manager.createProfile({ name: '' })).toThrow('cannot be empty');
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.createProfile({ name: 'blocked' })).toThrow('Profiles disabled');
    });
  });

  describe('getProfile', () => {
    it('returns profile by name', () => {
      const manager = new ProfileManager();
      const created = manager.createProfile({ name: 'get-test', displayName: 'Get Test' });

      const retrieved = manager.getProfile('get-test');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('get-test');
      expect(retrieved!.displayName).toBe('Get Test');
    });

    it('returns null for non-existent profile', () => {
      const manager = new ProfileManager();
      const result = manager.getProfile('non-existent');
      expect(result).toBeNull();
    });

    it('returns null when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      manager.createProfile({ name: 'blocked-get' });
      expect(manager.getProfile('blocked-get')).toBeNull();
    });
  });

  describe('listProfiles', () => {
    it('lists all profiles sorted by lastActive', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'alpha' });
      manager.createProfile({ name: 'beta' });

      const list = manager.listProfiles();

      expect(list.length).toBe(2);
      expect(list.map(p => p.name)).toEqual(['beta', 'alpha']); // Sorted by updatedAt desc
    });

    it('returns empty array when no profiles exist', () => {
      const manager = new ProfileManager();
      expect(manager.listProfiles()).toEqual([]);
    });

    it('returns empty array when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      manager.createProfile({ name: 'hidden' });
      expect(manager.listProfiles()).toEqual([]);
    });
  });

  describe('deleteProfile', () => {
    it('deletes existing profile', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'to-delete' });

      const result = manager.deleteProfile('to-delete');

      expect(result).toBe(true);
      expect(manager.getProfile('to-delete')).toBeNull();
    });

    it('returns false for non-existent profile', () => {
      const manager = new ProfileManager();
      expect(manager.deleteProfile('non-existent')).toBe(false);
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.deleteProfile('blocked')).toThrow('Profiles disabled');
    });
  });

  describe('activateProfile', () => {
    it('activates existing profile', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'activate-me' });

      const result = manager.activateProfile('activate-me');

      expect(result).toBe(true);
      expect(manager.getActiveProfile()).toBe('activate-me');
      expect(process.env['SUDO_ACTIVE_PROFILE']).toBe('activate-me');
    });

    it('returns false for non-existent profile', () => {
      const manager = new ProfileManager();
      expect(manager.activateProfile('non-existent')).toBe(false);
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.activateProfile('blocked')).toThrow('Profiles disabled');
    });
  });

  describe('getActiveProfile', () => {
    it('returns active profile name', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'active-profile' });
      manager.activateProfile('active-profile');

      expect(manager.getActiveProfile()).toBe('active-profile');
    });

    it('returns null when no profile is active', () => {
      const manager = new ProfileManager();
      expect(manager.getActiveProfile()).toBeNull();
    });

    it('reads from env if set externally', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'env-set' });
      process.env['SUDO_ACTIVE_PROFILE'] = 'env-set';

      expect(manager.getActiveProfile()).toBe('env-set');
    });

    it('returns null when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(manager.getActiveProfile()).toBeNull();
    });
  });

  describe('cloneProfile', () => {
    it('clones profile with deep copied config, env, skills', () => {
      const manager = new ProfileManager();
      const source = manager.createProfile({
        name: 'source',
        displayName: 'Source Profile',
        config: { original: true },
        env: { SOURCE_VAR: 'source-value' },
        soulMd: '# Source SOUL',
        skills: ['source-skill'],
      });

      const cloned = manager.cloneProfile('source', 'cloned', 'Cloned Profile');

      expect(cloned.name).toBe('cloned');
      expect(cloned.displayName).toBe('Cloned Profile');
      expect(cloned.config).toEqual({ original: true });
      expect(cloned.env).toEqual({ SOURCE_VAR: 'source-value' });
      expect(cloned.soulMd).toBe('# Source SOUL');
      expect(cloned.skills).toEqual(['source-skill']);

      // Verify deep copy - modifying source doesn't affect clone
      source.config.modified = true;
      expect(cloned.config).not.toHaveProperty('modified');
    });

    it('throws if source profile does not exist', () => {
      const manager = new ProfileManager();
      expect(() => manager.cloneProfile('non-existent', 'target')).toThrow('does not exist');
    });

    it('throws if target profile already exists', () => {
      const manager = new ProfileManager();
      manager.createProfile({ name: 'existing-target' });
      manager.createProfile({ name: 'source-for-clone' });

      expect(() => manager.cloneProfile('source-for-clone', 'existing-target')).toThrow('already exists');
    });

    it('throws when kill-switch is enabled', () => {
      process.env['SUDO_PROFILES_DISABLE'] = '1';
      const manager = new ProfileManager();
      expect(() => manager.cloneProfile('a', 'b')).toThrow('Profiles disabled');
    });
  });

  describe('profile isolation', () => {
    it('maintains separate env vars per profile', () => {
      const manager = new ProfileManager();

      manager.createProfile({
        name: 'profile-a',
        env: { PROFILE_ID: 'A', SHARED: 'from-a' },
        skills: ['skill-a'],
      });

      manager.createProfile({
        name: 'profile-b',
        env: { PROFILE_ID: 'B', SHARED: 'from-b' },
        skills: ['skill-b'],
      });

      manager.activateProfile('profile-a');
      const envA = manager.getActiveProfileEnv();
      const skillsA = manager.getActiveProfileSkills();

      expect(envA.PROFILE_ID).toBe('A');
      expect(envA.SHARED).toBe('from-a');
      expect(skillsA).toEqual(['skill-a']);

      manager.activateProfile('profile-b');
      const envB = manager.getActiveProfileEnv();
      const skillsB = manager.getActiveProfileSkills();

      expect(envB.PROFILE_ID).toBe('B');
      expect(envB.SHARED).toBe('from-b');
      expect(skillsB).toEqual(['skill-b']);
    });
  });
});

// ---------------------------------------------------------------------------
// Route handler tests (mock req/res)
// ---------------------------------------------------------------------------

describe('registerProfileRoutes', () => {
  function createMockReq(method: string, url: string, body?: Record<string, unknown>) {
    const listeners: Record<string, Array<(chunk: Buffer) => void>> = {};
    return {
      method,
      url,
      headers: { authorization: 'Bearer test-token' },
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
      }),
      destroy: vi.fn(),
      _emitData: (chunk: Buffer) => {
        listeners['data']?.forEach(cb => cb(chunk));
        listeners['end']?.forEach(cb => cb());
      },
      _emitError: (err: Error) => {
        listeners['error']?.forEach(cb => cb(err));
      },
    } as unknown as IncomingMessage & { _emitData: (chunk: Buffer) => void; _emitError: (err: Error) => void };
  }

  function createMockRes() {
    let statusCode = 200;
    let body = '';
    return {
      writeHead: vi.fn((code: number) => { statusCode = code; }),
      end: vi.fn((data: string) => { body = data; }),
      _getStatusCode: () => statusCode,
      _getBody: () => body,
    } as unknown as ServerResponse & { _getStatusCode: () => number; _getBody: () => string };
  }

  beforeEach(() => {
    process.env['GATEWAY_TOKEN'] = 'test-token';
  });

  afterEach(() => {
    delete process.env['GATEWAY_TOKEN'];
  });

  it('GET /v1/admin/profiles returns list', () => {
    const server = { on: vi.fn() } as unknown as HttpServer;
    registerProfileRoutes(server);

    const req = createMockReq('GET', '/v1/admin/profiles');
    const res = createMockRes();

    // Trigger the request listener
    const listener = (server.on as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'request'
    )?.[1];
    expect(listener).toBeDefined();
    listener!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getBody());
    expect(data.ok).toBe(true);
    expect(data.data.profiles).toBeDefined();
  });

  it('POST /v1/admin/profiles creates profile', () => {
    const server = { on: vi.fn() } as unknown as HttpServer;
    registerProfileRoutes(server);

    const req = createMockReq('POST', '/v1/admin/profiles');
    const res = createMockRes();

    const listener = (server.on as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'request'
    )?.[1];

    listener!(req, res);
    req._emitData(Buffer.from(JSON.stringify({ name: 'api-profile', displayName: 'API Profile' })));

    expect(res._getStatusCode()).toBe(201);
    const data = JSON.parse(res._getBody());
    expect(data.ok).toBe(true);
    expect(data.data.name).toBe('api-profile');
  });

  it('GET /v1/admin/profiles/:name returns profile', () => {
    const manager = new ProfileManager();
    manager.createProfile({ name: 'lookup-test' });

    const server = { on: vi.fn() } as unknown as HttpServer;
    registerProfileRoutes(server);

    const req = createMockReq('GET', '/v1/admin/profiles/lookup-test');
    const res = createMockRes();

    const listener = (server.on as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'request'
    )?.[1];
    listener!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getBody());
    expect(data.data.name).toBe('lookup-test');
  });

  it('DELETE /v1/admin/profiles/:name deletes profile', () => {
    const manager = new ProfileManager();
    manager.createProfile({ name: 'delete-via-api' });

    const server = { on: vi.fn() } as unknown as HttpServer;
    registerProfileRoutes(server);

    const req = createMockReq('DELETE', '/v1/admin/profiles/delete-via-api');
    const res = createMockRes();

    const listener = (server.on as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'request'
    )?.[1];
    listener!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getBody());
    expect(data.data.deleted).toBe(true);
  });

  it('POST /v1/admin/profiles/:name/activate activates profile', () => {
    const manager = new ProfileManager();
    manager.createProfile({ name: 'activate-via-api' });

    const server = { on: vi.fn() } as unknown as HttpServer;
    registerProfileRoutes(server);

    const req = createMockReq('POST', '/v1/admin/profiles/activate-via-api/activate');
    const res = createMockRes();

    const listener = (server.on as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'request'
    )?.[1];
    listener!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getBody());
    expect(data.data.active).toBe(true);
  });

  it('returns 401 without valid token', () => {
    const server = { on: vi.fn() } as unknown as HttpServer;
    registerProfileRoutes(server);

    const req = createMockReq('GET', '/v1/admin/profiles');
    req.headers = {}; // No auth header
    const res = createMockRes();

    const listener = (server.on as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'request'
    )?.[1];
    listener!(req, res);

    expect(res._getStatusCode()).toBe(401);
  });

  it('returns 503 when kill-switch is enabled', () => {
    process.env['SUDO_PROFILES_DISABLE'] = '1';

    const server = { on: vi.fn() } as unknown as HttpServer;
    registerProfileRoutes(server);

    const req = createMockReq('GET', '/v1/admin/profiles');
    const res = createMockRes();

    const listener = (server.on as ReturnType<typeof vi.fn>).mock.calls.find(
      call => call[0] === 'request'
    )?.[1];
    listener!(req, res);

    expect(res._getStatusCode()).toBe(503);

    delete process.env['SUDO_PROFILES_DISABLE'];
  });
});
