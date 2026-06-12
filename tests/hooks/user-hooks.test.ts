/**
 * User hooks file — loading DATA_DIR/hooks.json declarations onto a real
 * HookManager via the plugin-hooks bridge. Command hooks run real shell
 * (cat/printf into tmpdir markers); the http hook hits a real local server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createServer, type Server } from 'http';
import { HookManager } from '../../src/core/hooks/index.js';
import { loadUserHooks, unloadUserHooks, USER_HOOKS_ID } from '../../src/core/hooks/user-hooks.js';
import { getPluginHookCount } from '../../src/core/plugins/plugin-hooks.js';

let dir: string;
let hooks: HookManager;

function writeHooksFile(content: unknown): string {
  const path = join(dir, 'hooks.json');
  writeFileSync(path, JSON.stringify(content), 'utf-8');
  return path;
}

beforeEach(() => {
  // Guard against singleton pollution from a test that skipped cleanup.
  expect(getPluginHookCount(USER_HOOKS_ID)).toBe(0);
  dir = join(tmpdir(), `user-hooks-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  hooks = new HookManager();
});

afterEach(() => {
  unloadUserHooks(hooks);
  rmSync(dir, { recursive: true, force: true });
});

describe('loadUserHooks', () => {
  it('treats a missing file as zero hooks, not an error', () => {
    const res = loadUserHooks(hooks, join(dir, 'does-not-exist.json'));
    expect(res).toEqual({ registered: 0, skipped: 0, errors: [] });
  });

  it('reports malformed JSON without registering anything', () => {
    const path = join(dir, 'hooks.json');
    writeFileSync(path, '{ not json', 'utf-8');
    const res = loadUserHooks(hooks, path);
    expect(res.registered).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('not valid JSON');
  });

  it('rejects a file that is neither an array nor {hooks: []}', () => {
    const path = writeHooksFile({ hello: 'world' });
    const res = loadUserHooks(hooks, path);
    expect(res.registered).toBe(0);
    expect(res.errors[0]).toContain('hooks');
  });

  it('accepts a bare array as well as the {hooks: []} wrapper', () => {
    const decl = { event: 'session:start', type: 'command', command: 'true' };
    expect(loadUserHooks(hooks, writeHooksFile([decl])).registered).toBe(1);
    expect(loadUserHooks(hooks, writeHooksFile({ hooks: [decl] })).registered).toBe(1);
  });

  it('command hook receives the HookContext on stdin and SUDO_HOOK_EVENT in env', async () => {
    const ctxMarker = join(dir, 'ctx.json');
    const envMarker = join(dir, 'event.txt');
    const path = writeHooksFile({
      hooks: [{
        event: 'session:start',
        type: 'command',
        command: `cat > "${ctxMarker}" && printf '%s' "$SUDO_HOOK_EVENT" > "${envMarker}"`,
      }],
    });

    expect(loadUserHooks(hooks, path).registered).toBe(1);
    await hooks.emit('session:start', { event: 'session:start', sessionId: 's-1' });

    const ctx = JSON.parse(readFileSync(ctxMarker, 'utf-8')) as { event: string; sessionId: string };
    expect(ctx.event).toBe('session:start');
    expect(ctx.sessionId).toBe('s-1');
    expect(readFileSync(envMarker, 'utf-8')).toBe('session:start');
  });

  it('command hook does not fire on other events', async () => {
    const marker = join(dir, 'fired.txt');
    const path = writeHooksFile({
      hooks: [{ event: 'session:end', type: 'command', command: `cat > "${marker}"` }],
    });
    loadUserHooks(hooks, path);

    await hooks.emit('session:start', { event: 'session:start' });
    expect(existsSync(marker)).toBe(false);
    await hooks.emit('session:end', { event: 'session:end' });
    expect(existsSync(marker)).toBe(true);
  });

  it('http hook POSTs the context as JSON', async () => {
    let received: { method?: string; body?: string } = {};
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        received = { method: req.method ?? '', body };
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      const path = writeHooksFile({
        hooks: [{ event: 'on:message', type: 'http', url: `http://127.0.0.1:${port}/hook` }],
      });
      expect(loadUserHooks(hooks, path).registered).toBe(1);
      await hooks.emit('on:message', { event: 'on:message', message: 'hello' });

      expect(received.method).toBe('POST');
      const body = JSON.parse(received.body ?? '{}') as { event: string; message: string };
      expect(body.event).toBe('on:message');
      expect(body.message).toBe('hello');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('skips invalid entries but still registers the valid ones', () => {
    const path = writeHooksFile({
      hooks: [
        { event: 'session:start', type: 'command' },                       // missing command
        { event: 'session:start', type: 'webhook', url: 'http://x' },      // bad type
        { event: 'session:start', type: 'function', functionName: 'f' },   // needs a plugin
        { event: 'session:start', type: 'http', url: 'ftp://example.com' }, // non-http(s)
        { event: '', type: 'command', command: 'true' },                   // empty event
        { event: 'session:start', type: 'command', command: 'true', timeout: -5 }, // bad timeout
        { event: 'session:start', type: 'command', command: 'true' },      // valid
      ],
    });
    const res = loadUserHooks(hooks, path);
    expect(res.registered).toBe(1);
    expect(res.errors).toHaveLength(6);
    expect(res.errors.join('\n')).toContain('plugin SDK');
  });

  it('honors enabled:false as skipped, not registered', async () => {
    const marker = join(dir, 'disabled.txt');
    const path = writeHooksFile({
      hooks: [{ event: 'session:start', type: 'command', command: `cat > "${marker}"`, enabled: false }],
    });
    const res = loadUserHooks(hooks, path);
    expect(res).toEqual({ registered: 0, skipped: 1, errors: [] });

    await hooks.emit('session:start', { event: 'session:start' });
    expect(existsSync(marker)).toBe(false);
  });

  it('reload is idempotent — no duplicate registrations', () => {
    const path = writeHooksFile({
      hooks: [{ event: 'session:start', type: 'command', command: 'true' }],
    });
    loadUserHooks(hooks, path);
    loadUserHooks(hooks, path);
    expect(getPluginHookCount(USER_HOOKS_ID)).toBe(1);
    expect(hooks.size).toBe(1);
  });

  it('unloadUserHooks removes everything and silences future emits', async () => {
    const marker = join(dir, 'after-unload.txt');
    const path = writeHooksFile({
      hooks: [{ event: 'session:start', type: 'command', command: `cat > "${marker}"` }],
    });
    loadUserHooks(hooks, path);

    expect(unloadUserHooks(hooks)).toBe(1);
    expect(getPluginHookCount(USER_HOOKS_ID)).toBe(0);
    expect(hooks.size).toBe(0);

    await hooks.emit('session:start', { event: 'session:start' });
    expect(existsSync(marker)).toBe(false);
  });
});
