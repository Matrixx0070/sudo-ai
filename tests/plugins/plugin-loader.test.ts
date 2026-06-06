/**
 * Unit tests for PluginLoader and plugin manifest validation.
 *
 * Tests: manifest validation, plugin loading, lifecycle (enable/disable/unload),
 *        dependency resolution, state tracking, scan, loadAll, persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  PluginLoader,
  type PluginEntry,
  type PluginLoaderConfig,
} from '../../src/core/plugins/plugin-loader.js';
import {
  validateManifest,
  PluginState,
  type PluginManifest,
  type ManifestValidationResult,
} from '../../src/core/plugins/plugin-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpDir(): string {
  const dir = join(tmpdir(), `plugin-loader-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'ai.sudo.plugin.test',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin',
    author: 'test-author',
    category: 'development',
    hooks: [],
    skills: [],
    mcpServers: [],
    lspServers: [],
    source: { type: 'local', path: '/tmp/test' },
    ...overrides,
  };
}

function writePlugin(dir: string, manifest: PluginManifest, entryCode?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  const code = entryCode ?? `
    export const manifest = ${JSON.stringify(manifest)};
    export async function activate(ctx) { ctx.logger.info({ msg: 'activated' }); }
    export async function deactivate() {}
  `;
  writeFileSync(join(dir, 'index.js'), code, 'utf-8');
}

// ---------------------------------------------------------------------------
// validateManifest tests
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  it('validates a correct manifest', () => {
    const manifest = makeManifest();
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.hash).toBeTruthy();
  });

  it('rejects manifest missing required id', () => {
    const manifest = makeManifest({ id: '' });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects manifest with invalid version format', () => {
    const manifest = makeManifest({ version: '1.0' });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('rejects manifest with unknown category as a warning', () => {
    const manifest = makeManifest({ category: 'nonexistent' as any });
    const result = validateManifest(manifest);
    // Unknown category produces a warning, not an error
    expect(result.warnings.some((w) => w.includes('category'))).toBe(true);
  });

  it('rejects manifest missing source', () => {
    const manifest = makeManifest();
    delete (manifest as any).source;
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('source'))).toBe(true);
  });

  it('rejects manifest with invalid source type', () => {
    const manifest = makeManifest({ source: { type: 'ftp' as any } });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('source.type'))).toBe(true);
  });

  it('validates hook declarations with missing command for command type', () => {
    const manifest = makeManifest({
      hooks: [{ event: 'PreToolCall', type: 'command' as const }],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('command'))).toBe(true);
  });

  it('validates MCP server declarations with missing command', () => {
    const manifest = makeManifest({
      mcpServers: [{ id: 'test-mcp' } as any],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('mcpServers'))).toBe(true);
  });

  it('returns content hash', () => {
    const manifest = makeManifest();
    const result1 = validateManifest(manifest);
    const result2 = validateManifest(manifest);
    expect(result1.hash).toBe(result2.hash);
  });
});

// ---------------------------------------------------------------------------
// PluginLoader tests
// ---------------------------------------------------------------------------

describe('PluginLoader', () => {
  let pluginsDir: string;
  let loader: PluginLoader;

  beforeEach(() => {
    pluginsDir = mkTmpDir();
    loader = new PluginLoader({ pluginsDir, autoEnable: false, sandbox: false });
  });

  afterEach(() => {
    try {
      rmSync(pluginsDir, { recursive: true, force: true });
    } catch {}
  });

  it('scans an empty plugins directory', async () => {
    const dirs = await loader.scan();
    expect(dirs).toEqual([]);
  });

  it('scans and discovers plugin directories with manifest.json', async () => {
    writePlugin(join(pluginsDir, 'plugin-a'), makeManifest({ id: 'plugin.a' }));
    // Create a directory without manifest.json
    mkdirSync(join(pluginsDir, 'not-a-plugin'), { recursive: true });

    const dirs = await loader.scan();
    expect(dirs.length).toBe(1);
    expect(dirs[0]).toContain('plugin-a');
  });

  it('loads a plugin from a directory', async () => {
    const pluginDir = join(pluginsDir, 'test-plugin');
    writePlugin(pluginDir, makeManifest());

    const entry = await loader.load(pluginDir);
    expect(entry.manifest.id).toBe('ai.sudo.plugin.test');
    expect(entry.state).toBe(PluginState.Installed);
    expect(entry.loadedAt).toBeTruthy();
  });

  it('rejects loading the same plugin twice', async () => {
    const pluginDir = join(pluginsDir, 'dup-plugin');
    writePlugin(pluginDir, makeManifest());

    await loader.load(pluginDir);
    await expect(loader.load(pluginDir)).rejects.toThrow('already loaded');
  });

  it('rejects a plugin with invalid manifest', async () => {
    const pluginDir = join(pluginsDir, 'bad-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), '{}', 'utf-8');

    await expect(loader.load(pluginDir)).rejects.toThrow();
  });

  it('enables a plugin and transitions state to Enabled', async () => {
    const pluginDir = join(pluginsDir, 'enable-test');
    const manifest = makeManifest({ id: 'plugin.enable' });
    writePlugin(pluginDir, manifest);

    await loader.load(pluginDir);
    await loader.enable('plugin.enable');

    expect(loader.getState('plugin.enable')).toBe(PluginState.Enabled);
  });

  it('disables an enabled plugin and transitions to Disabled', async () => {
    const pluginDir = join(pluginsDir, 'disable-test');
    const manifest = makeManifest({ id: 'plugin.disable' });
    writePlugin(pluginDir, manifest);

    await loader.load(pluginDir);
    await loader.enable('plugin.disable');
    await loader.disable('plugin.disable');

    expect(loader.getState('plugin.disable')).toBe(PluginState.Disabled);
  });

  it('unloads a plugin and removes it from registry', async () => {
    const pluginDir = join(pluginsDir, 'unload-test');
    writePlugin(pluginDir, makeManifest({ id: 'plugin.unload' }));

    await loader.load(pluginDir);
    expect(loader.size).toBe(1);

    await loader.unload('plugin.unload');
    expect(loader.size).toBe(0);
    expect(loader.get('plugin.unload')).toBeUndefined();
  });

  it('resolves dependencies in topological order', async () => {
    const baseDir = join(pluginsDir, 'base');
    const extDir = join(pluginsDir, 'ext');

    writePlugin(baseDir, makeManifest({ id: 'plugin.base', dependencies: [] }));
    writePlugin(extDir, makeManifest({ id: 'plugin.ext', dependencies: ['plugin.base'] }));

    await loader.load(baseDir);
    await loader.load(extDir);

    const order = loader.resolveDependencies(['plugin.ext']);
    expect(order.indexOf('plugin.base')).toBeLessThan(order.indexOf('plugin.ext'));
  });

  it('detects circular dependencies', async () => {
    const aDir = join(pluginsDir, 'circular-a');
    const bDir = join(pluginsDir, 'circular-b');

    writePlugin(aDir, makeManifest({ id: 'plugin.circ.a', dependencies: ['plugin.circ.b'] }));
    writePlugin(bDir, makeManifest({ id: 'plugin.circ.b', dependencies: ['plugin.circ.a'] }));

    await loader.load(aDir);
    await loader.load(bDir);

    expect(() => loader.resolveDependencies()).toThrow('Circular dependency');
  });

  it('refuses to enable a plugin with unresolved dependencies', async () => {
    const pluginDir = join(pluginsDir, 'dep-test');
    writePlugin(
      pluginDir,
      makeManifest({ id: 'plugin.dep-test', dependencies: ['plugin.missing'] }),
    );

    await loader.load(pluginDir);
    await expect(loader.enable('plugin.dep-test')).rejects.toThrow('unresolved dependencies');
  });

  it('lists plugins by state', async () => {
    writePlugin(join(pluginsDir, 'a'), makeManifest({ id: 'plugin.list-a' }));
    writePlugin(join(pluginsDir, 'b'), makeManifest({ id: 'plugin.list-b' }));

    await loader.load(join(pluginsDir, 'a'));
    await loader.load(join(pluginsDir, 'b'));

    const installed = loader.listByState(PluginState.Installed);
    expect(installed.length).toBe(2);

    const enabled = loader.listByState(PluginState.Enabled);
    expect(enabled.length).toBe(0);
  });

  it('saves and loads plugin state', async () => {
    writePlugin(join(pluginsDir, 'persist-test'), makeManifest({ id: 'plugin.persist' }));
    await loader.load(join(pluginsDir, 'persist-test'));

    loader.saveState();

    const loader2 = new PluginLoader({ pluginsDir, autoEnable: false, sandbox: false });
    const count = await loader2.loadState();
    expect(count).toBe(1);
  });
});