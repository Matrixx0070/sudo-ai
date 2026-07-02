/**
 * Tests for the plugin SDK boot wiring (src/core/plugins/boot.ts).
 *
 * Covers: bootPlugins discovery + enable + hook bridging onto a real
 * HookManager, failure isolation for broken plugins, dependency ordering,
 * and shutdownPlugins hook cleanup + disable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { bootPlugins, shutdownPlugins } from '../../src/core/plugins/boot.js';
import { getPluginHookCount } from '../../src/core/plugins/plugin-hooks.js';
import { listMcpServers } from '../../src/core/plugins/mcp-registry.js';
import { PluginState, type PluginManifest } from '../../src/core/plugins/plugin-manifest.js';
import { HookManager } from '../../src/core/hooks/index.js';

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'ai.sudo.plugin.boot-test',
    name: 'Boot Test Plugin',
    version: '1.0.0',
    description: 'Plugin used by boot wiring tests',
    author: 'test-author',
    category: 'testing',
    hooks: [],
    skills: [],
    mcpServers: [],
    lspServers: [],
    source: { type: 'local', path: '/tmp/boot-test' },
    ...overrides,
  };
}

/** Plugin entry point: default-export module that records lifecycle to files. */
function entryCode(): string {
  return `
    import { writeFileSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const here = dirname(fileURLToPath(import.meta.url));
    export default {
      async activate() { writeFileSync(join(here, 'activated.txt'), 'yes'); },
      async deactivate() { writeFileSync(join(here, 'deactivated.txt'), 'yes'); },
      async onSessionStart(ctx) { writeFileSync(join(here, 'hook-fired.txt'), JSON.stringify(ctx)); },
    };
  `;
}

function writePlugin(dir: string, manifest: PluginManifest, code: string = entryCode()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  writeFileSync(join(dir, 'index.js'), code, 'utf-8');
}

describe('bootPlugins', () => {
  let pluginsDir: string;
  let hooks: HookManager;

  beforeEach(() => {
    pluginsDir = join(tmpdir(), `plugin-boot-test-${randomUUID()}`);
    mkdirSync(pluginsDir, { recursive: true });
    hooks = new HookManager();
  });

  afterEach(() => {
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  it('returns zero counts for an empty plugins directory', async () => {
    const result = await bootPlugins(hooks, pluginsDir);
    expect(result.loaded).toBe(0);
    expect(result.enabled).toBe(0);
    expect(result.hooksRegistered).toBe(0);
  });

  it('Phase 0: bridges manifest skills/ dir onto SUDO_SKILLS_DIRS and mcpServers onto the MCP registry', async () => {
    const id = 'ai.sudo.plugin.caps';
    const savedSkills = process.env['SUDO_SKILLS_DIRS'];
    try {
      const dir = join(pluginsDir, 'caps');
      writePlugin(dir, makeManifest({
        id,
        skills: [{ id: 's1', name: 'Skill One', description: 'a declared skill' }],
        mcpServers: [{ id: 'srv', command: 'my-mcp-server', args: ['--root', '/p with space'] }],
      }));
      // The skill markdown lives in the plugin's own skills/ dir.
      mkdirSync(join(dir, 'skills'), { recursive: true });
      writeFileSync(join(dir, 'skills', 's1.md'), '# Skill One\n', 'utf-8');

      const result = await bootPlugins(hooks, pluginsDir);

      // Skills dir appended to the live loader's search path.
      expect(result.skillRootsAdded).toBe(1);
      expect((process.env['SUDO_SKILLS_DIRS'] ?? '').split(':')).toContain(join(dir, 'skills'));

      // MCP server registered, namespaced, stdio, unreviewed (tracked not auto-connected).
      expect(result.mcpServersRegistered).toBe(1);
      const server = listMcpServers().find((s) => s.name === `${id}:srv`);
      expect(server).toBeDefined();
      expect(server!.transport).toBe('stdio');
      expect(server!.trustTier).toBe('unreviewed');
      // Launch config encoded in the url; the space-bearing arg is shell-quoted.
      expect(server!.url).toContain('stdio:my-mcp-server');
      expect(server!.url).toContain("'/p with space'");
    } finally {
      if (savedSkills === undefined) delete process.env['SUDO_SKILLS_DIRS'];
      else process.env['SUDO_SKILLS_DIRS'] = savedSkills;
    }
  });

  it('Phase 0: warns and skips skill wiring when the manifest declares skills but ships no skills/ dir', async () => {
    const id = 'ai.sudo.plugin.noskilldir';
    const savedSkills = process.env['SUDO_SKILLS_DIRS'];
    try {
      const dir = join(pluginsDir, 'noskilldir');
      writePlugin(dir, makeManifest({
        id,
        skills: [{ id: 's1', name: 'Skill', description: 'declared but no dir' }],
      }));
      const result = await bootPlugins(hooks, pluginsDir);
      expect(result.skillRootsAdded).toBe(0);
      expect(result.enabled).toBe(1); // boot still succeeds
    } finally {
      if (savedSkills === undefined) delete process.env['SUDO_SKILLS_DIRS'];
      else process.env['SUDO_SKILLS_DIRS'] = savedSkills;
    }
  });

  it('loads, enables, and bridges function hooks onto the HookManager', async () => {
    const id = 'ai.sudo.plugin.alpha';
    const dir = join(pluginsDir, 'alpha');
    writePlugin(
      dir,
      makeManifest({
        id,
        hooks: [{ event: 'session:start', type: 'function', functionName: 'onSessionStart' }],
      }),
    );

    const result = await bootPlugins(hooks, pluginsDir);

    expect(result.loaded).toBe(1);
    expect(result.enabled).toBe(1);
    expect(result.hooksRegistered).toBe(1);
    expect(existsSync(join(dir, 'activated.txt'))).toBe(true);
    expect(result.loader.isEnabled(id)).toBe(true);
    expect(getPluginHookCount(id)).toBe(1);

    // The bridged hook fires only via the HookManager emit, not during activate().
    expect(existsSync(join(dir, 'hook-fired.txt'))).toBe(false);
    await hooks.emit('session:start', { event: 'session:start' });
    expect(existsSync(join(dir, 'hook-fired.txt'))).toBe(true);

    await shutdownPlugins(result.loader, hooks);
  });

  it('isolates a broken plugin without aborting the rest of boot', async () => {
    writePlugin(join(pluginsDir, 'good'), makeManifest({ id: 'ai.sudo.plugin.good' }));
    // Broken: manifest validates but the entry point throws on activate.
    writePlugin(
      join(pluginsDir, 'bad'),
      makeManifest({ id: 'ai.sudo.plugin.bad' }),
      `export default { async activate() { throw new Error('boom'); } };`,
    );

    const result = await bootPlugins(hooks, pluginsDir);

    expect(result.loaded).toBe(2);
    expect(result.enabled).toBe(1);
    expect(result.loader.isEnabled('ai.sudo.plugin.good')).toBe(true);
    expect(result.loader.getState('ai.sudo.plugin.bad')).toBe(PluginState.Error);

    await shutdownPlugins(result.loader, hooks);
  });

  it('enables dependencies before dependents', async () => {
    writePlugin(join(pluginsDir, 'base'), makeManifest({ id: 'ai.sudo.plugin.base' }));
    writePlugin(
      join(pluginsDir, 'child'),
      makeManifest({ id: 'ai.sudo.plugin.child', dependencies: ['ai.sudo.plugin.base'] }),
    );

    const result = await bootPlugins(hooks, pluginsDir);

    expect(result.enabled).toBe(2);
    expect(result.loader.isEnabled('ai.sudo.plugin.base')).toBe(true);
    expect(result.loader.isEnabled('ai.sudo.plugin.child')).toBe(true);

    await shutdownPlugins(result.loader, hooks);
  });

  it('persists plugin state to disk after boot', async () => {
    writePlugin(join(pluginsDir, 'alpha'), makeManifest({ id: 'ai.sudo.plugin.persist' }));
    const result = await bootPlugins(hooks, pluginsDir);
    expect(existsSync(join(pluginsDir, 'plugin-state.json'))).toBe(true);
    await shutdownPlugins(result.loader, hooks);
  });
});

describe('shutdownPlugins', () => {
  let pluginsDir: string;
  let hooks: HookManager;

  beforeEach(() => {
    pluginsDir = join(tmpdir(), `plugin-shutdown-test-${randomUUID()}`);
    mkdirSync(pluginsDir, { recursive: true });
    hooks = new HookManager();
  });

  afterEach(() => {
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  it('unregisters bridged hooks and disables plugins', async () => {
    const id = 'ai.sudo.plugin.teardown';
    const dir = join(pluginsDir, 'teardown');
    writePlugin(
      dir,
      makeManifest({
        id,
        hooks: [{ event: 'session:start', type: 'function', functionName: 'onSessionStart' }],
      }),
    );

    const result = await bootPlugins(hooks, pluginsDir);
    expect(getPluginHookCount(id)).toBe(1);

    await shutdownPlugins(result.loader, hooks);

    expect(getPluginHookCount(id)).toBe(0);
    expect(result.loader.getState(id)).toBe(PluginState.Disabled);
    expect(existsSync(join(dir, 'deactivated.txt'))).toBe(true);

    // Emitting after shutdown does not fire the plugin hook.
    rmSync(join(dir, 'hook-fired.txt'), { force: true });
    await hooks.emit('session:start', { event: 'session:start' });
    expect(existsSync(join(dir, 'hook-fired.txt'))).toBe(false);
  });
});
