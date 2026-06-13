/**
 * Claude/Cursor compat (gap #13) — ingest .mcp.json + Cursor mcp.json,
 * Claude settings.json hooks, ~/.claude/skills + project .claude/skills,
 * and .claude-plugin/marketplace.json catalogs.
 *
 * Tests use a tmpdir for both project root and synthetic $HOME so they
 * never read the real user's Claude config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { HookManager } from '../../src/core/hooks/index.js';
import {
  ingestClaudeCompat,
  parseMcpServersMap,
  parseClaudeSettingsHooks,
  parseMarketplaceCatalog,
  mapClaudeHookEvent,
  CLAUDE_COMPAT_HOOKS_ID,
} from '../../src/core/plugins/claude-compat.js';
import {
  getPluginHookCount,
  unregisterPluginHooks,
} from '../../src/core/plugins/plugin-hooks.js';
import {
  listMcpServers,
  removeMcpServer,
} from '../../src/core/plugins/mcp-registry.js';

let projectRoot: string;
let homeDir: string;
let hooks: HookManager;
let priorSkillsEnv: string | undefined;

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf-8');
}

function syntheticManifest() {
  return {
    id: CLAUDE_COMPAT_HOOKS_ID,
    name: 'x',
    version: '1.0.0',
    description: 'x',
    author: 'x',
    category: 'productivity' as const,
    hooks: [],
    skills: [],
    mcpServers: [],
    lspServers: [],
    source: { type: 'local' as const },
  };
}

function clearCompatHooks() {
  // Force-drop any registration left from a previous test
  unregisterPluginHooks(syntheticManifest(), hooks);
}

function clearMcpRegistry() {
  for (const s of listMcpServers()) removeMcpServer(s.id);
}

beforeEach(() => {
  const id = randomUUID();
  projectRoot = join(tmpdir(), `claude-compat-proj-${id}`);
  homeDir = join(tmpdir(), `claude-compat-home-${id}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  hooks = new HookManager();
  priorSkillsEnv = process.env['SUDO_SKILLS_DIRS'];
  delete process.env['SUDO_SKILLS_DIRS'];
  clearMcpRegistry();
});

afterEach(() => {
  clearCompatHooks();
  clearMcpRegistry();
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  if (priorSkillsEnv === undefined) {
    delete process.env['SUDO_SKILLS_DIRS'];
  } else {
    process.env['SUDO_SKILLS_DIRS'] = priorSkillsEnv;
  }
});

// ---------------------------------------------------------------------------
// mapClaudeHookEvent
// ---------------------------------------------------------------------------

describe('mapClaudeHookEvent', () => {
  it('maps every Claude event to a real HookEvent union member', () => {
    // Every target string must be in core/hooks/index.ts HookEvent union.
    // An off-target string registers a handler on an event that never fires.
    expect(mapClaudeHookEvent('PreToolUse')).toBe('before:tool-call');
    expect(mapClaudeHookEvent('PostToolUse')).toBe('after:tool-call');
    expect(mapClaudeHookEvent('UserPromptSubmit')).toBe('message:received');
    expect(mapClaudeHookEvent('SessionStart')).toBe('session:start');
    expect(mapClaudeHookEvent('SessionEnd')).toBe('session:end');
    expect(mapClaudeHookEvent('Stop')).toBe('command:stop');
    expect(mapClaudeHookEvent('SubagentStop')).toBe('swarm:complete');
    expect(mapClaudeHookEvent('Notification')).toBe('on:message');
    expect(mapClaudeHookEvent('PreCompact')).toBe('pre:compact');
  });

  it('passes unknown event names through unchanged', () => {
    expect(mapClaudeHookEvent('SomethingNew')).toBe('SomethingNew');
  });
});

// ---------------------------------------------------------------------------
// parseMcpServersMap
// ---------------------------------------------------------------------------

describe('parseMcpServersMap', () => {
  it('rejects non-object inputs', () => {
    const errs: string[] = [];
    expect(parseMcpServersMap([] as unknown, 's', errs)).toEqual([]);
    expect(errs[0]).toContain('must be an object');
  });

  it('handles stdio servers (command + args → stdio: url)', () => {
    const errs: string[] = [];
    const out = parseMcpServersMap(
      { 'fs-server': { command: 'mcp-fs', args: ['--root', '/srv'] } },
      'f',
      errs,
    );
    expect(errs).toEqual([]);
    expect(out).toEqual([
      { id: 'fs-server', url: 'stdio:mcp-fs --root /srv', transport: 'stdio' },
    ]);
  });

  it('handles HTTP servers with explicit type', () => {
    const errs: string[] = [];
    const out = parseMcpServersMap(
      { weather: { type: 'http', url: 'https://example.com/mcp' } },
      'f',
      errs,
    );
    expect(errs).toEqual([]);
    expect(out[0]).toMatchObject({ id: 'weather', transport: 'http', url: 'https://example.com/mcp' });
  });

  it('infers http transport from a bare url (no command, no type)', () => {
    const errs: string[] = [];
    const out = parseMcpServersMap(
      { weather: { url: 'https://example.com/mcp' } },
      'f',
      errs,
    );
    expect(errs).toEqual([]);
    expect(out[0]?.transport).toBe('http');
  });

  it('passes sse and websocket type through', () => {
    const errs: string[] = [];
    const out = parseMcpServersMap(
      {
        a: { type: 'sse', url: 'https://e.x/sse' },
        b: { type: 'websocket', url: 'wss://e.x/ws' },
      },
      'f',
      errs,
    );
    expect(out.find((e) => e.id === 'a')?.transport).toBe('sse');
    expect(out.find((e) => e.id === 'b')?.transport).toBe('websocket');
  });

  it('records errors for entries with neither url nor command', () => {
    const errs: string[] = [];
    const out = parseMcpServersMap({ bad: { env: { X: '1' } } }, 'f', errs);
    expect(out).toEqual([]);
    expect(errs[0]).toContain('neither url nor command');
  });

  it('records errors for explicit http type without url', () => {
    const errs: string[] = [];
    parseMcpServersMap({ broken: { type: 'http' } }, 'f', errs);
    expect(errs.some((e) => e.includes('no url'))).toBe(true);
  });

  it('shell-quotes stdio args with spaces (lossless reconstruction)', () => {
    const errs: string[] = [];
    const out = parseMcpServersMap(
      { svc: { command: 'mcp-fs', args: ['--root', '/path with spaces', "with'apostrophe"] } },
      'f',
      errs,
    );
    expect(errs).toEqual([]);
    // POSIX single-quote idiom: space-bearing token wrapped, apostrophe escaped as '\''
    expect(out[0]?.url).toBe("stdio:mcp-fs --root '/path with spaces' 'with'\\''apostrophe'");
  });

  it('warns + uses command when both url and command are present', () => {
    const errs: string[] = [];
    const out = parseMcpServersMap(
      { both: { command: 'cmd', url: 'https://e.x/mcp' } },
      'f',
      errs,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.transport).toBe('stdio');
    expect(errs.some((e) => e.includes('both url and command'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeSettingsHooks
// ---------------------------------------------------------------------------

describe('parseClaudeSettingsHooks', () => {
  it('returns empty when settings has no hooks block', () => {
    const errs: string[] = [];
    const r = parseClaudeSettingsHooks({ env: { X: '1' } }, 'f', errs);
    expect(r.decls).toEqual([]);
    expect(errs).toEqual([]);
  });

  it('extracts a single PreToolUse command hook with the correct mapped event', () => {
    const errs: string[] = [];
    const r = parseClaudeSettingsHooks(
      {
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
          ],
        },
      },
      'f',
      errs,
    );
    expect(errs).toEqual([]);
    expect(r.decls).toHaveLength(1);
    expect(r.decls[0]).toMatchObject({
      event: 'before:tool-call',
      type: 'command',
      command: 'echo hi',
    });
  });

  it('maps PreCompact to pre:compact (not before:compact, which would be dead)', () => {
    const errs: string[] = [];
    const r = parseClaudeSettingsHooks(
      { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
      'f',
      errs,
    );
    expect(r.decls[0]?.event).toBe('pre:compact');
  });

  it('rejects http hooks with invalid url protocols', () => {
    const errs: string[] = [];
    const r = parseClaudeSettingsHooks(
      {
        hooks: {
          PostToolUse: [
            { hooks: [{ type: 'http', url: 'file:///bad' }] },
          ],
        },
      },
      'f',
      errs,
    );
    expect(r.decls).toHaveLength(0);
    expect(errs[0]).toContain('http(s)');
  });

  it('counts enabled:false entries under skipped', () => {
    const errs: string[] = [];
    const r = parseClaudeSettingsHooks(
      {
        hooks: {
          SessionStart: [
            { hooks: [
              { type: 'command', command: 'true', enabled: false },
              { type: 'command', command: 'true' },
            ] },
          ],
        },
      },
      'f',
      errs,
    );
    expect(r.decls).toHaveLength(1);
    expect(r.skipped).toBe(1);
    expect(errs).toEqual([]);
  });

  it('preserves Claude event names that have no map entry', () => {
    const errs: string[] = [];
    const r = parseClaudeSettingsHooks(
      {
        hooks: {
          FutureEvent: [
            { hooks: [{ type: 'command', command: 'true' }] },
          ],
        },
      },
      'f',
      errs,
    );
    expect(r.decls[0]?.event).toBe('FutureEvent');
  });

  it('reports errors for malformed inner shapes without aborting siblings', () => {
    const errs: string[] = [];
    const r = parseClaudeSettingsHooks(
      {
        hooks: {
          PreToolUse: [
            { hooks: [
              { type: 'command' }, // missing command field
              { type: 'command', command: 'true' }, // valid
            ] },
          ],
        },
      },
      'f',
      errs,
    );
    expect(r.decls).toHaveLength(1);
    expect(errs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseMarketplaceCatalog
// ---------------------------------------------------------------------------

describe('parseMarketplaceCatalog', () => {
  it('returns empty array when no plugins field', () => {
    const errs: string[] = [];
    expect(parseMarketplaceCatalog({ name: 'shop' }, 'f', errs)).toEqual([]);
    expect(errs).toEqual([]);
  });

  it('extracts plugins with id+name+source+description', () => {
    const errs: string[] = [];
    const out = parseMarketplaceCatalog(
      {
        name: 'shop',
        plugins: [
          { name: 'foo', source: 'github:o/r', description: 'hi' },
          { id: 'bar', name: 'Bar', source: 'github:o/r2' },
        ],
      },
      '/tmp/m.json',
      errs,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'foo', source: 'github:o/r', description: 'hi' });
    expect(out[0]?.name).toBeUndefined(); // name === id, omitted
    expect(out[1]).toMatchObject({ id: 'bar', name: 'Bar' });
    expect(out[0]?.catalogPath).toBe('/tmp/m.json');
  });

  it('rejects entries without id or name', () => {
    const errs: string[] = [];
    const out = parseMarketplaceCatalog({ plugins: [{ source: 'x' }] }, 'f', errs);
    expect(out).toEqual([]);
    expect(errs[0]).toContain('needs an id or name');
  });
});

// ---------------------------------------------------------------------------
// End-to-end ingest
// ---------------------------------------------------------------------------

describe('ingestClaudeCompat', () => {
  it('reports zero counts when nothing exists on disk', async () => {
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.mcp.registered).toBe(0);
    expect(r.hooks.registered).toBe(0);
    expect(r.skillRootsAdded).toEqual([]);
    expect(r.marketplacePlugins).toEqual([]);
  });

  it('registers .mcp.json servers with the in-process registry', async () => {
    writeJson(join(projectRoot, '.mcp.json'), {
      mcpServers: {
        'project-fs': { command: 'mcp-fs', args: ['--root', '.'] },
        weather: { type: 'http', url: 'https://example.com/mcp' },
      },
    });
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.mcp.registered).toBe(2);
    const inRegistry = listMcpServers().map((s) => s.name).sort();
    expect(inRegistry).toEqual(['project-fs', 'weather']);
  });

  it('also reads Cursor .cursor/mcp.json', async () => {
    writeJson(join(projectRoot, '.cursor', 'mcp.json'), {
      mcpServers: { cursor: { command: 'cursor-mcp' } },
    });
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.mcp.registered).toBe(1);
    expect(listMcpServers()[0]?.transport).toBe('stdio');
  });

  it('de-duplicates server names across files (first wins)', async () => {
    writeJson(join(projectRoot, '.mcp.json'), {
      mcpServers: { shared: { command: 'a' } },
    });
    writeJson(join(projectRoot, '.cursor', 'mcp.json'), {
      mcpServers: { shared: { command: 'b' } },
    });
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.mcp.registered).toBe(1);
    expect(r.mcp.skipped).toBe(1);
  });

  it('ingests ~/.claude/settings.json hooks onto HookManager', async () => {
    writeJson(join(homeDir, '.claude', 'settings.json'), {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'true' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: 'true' }] },
        ],
      },
    });
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.hooks.registered).toBe(2);
    expect(getPluginHookCount(CLAUDE_COMPAT_HOOKS_ID)).toBe(2);
  });

  it('appends ~/.claude/skills and project .claude/skills to SUDO_SKILLS_DIRS', async () => {
    mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude', 'skills'), { recursive: true });

    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.skillRootsAdded.length).toBe(2);

    const env = process.env['SUDO_SKILLS_DIRS'] ?? '';
    expect(env).toContain(join(homeDir, '.claude', 'skills'));
    expect(env).toContain(join(projectRoot, '.claude', 'skills'));
  });

  it('does not duplicate skill roots already in SUDO_SKILLS_DIRS', async () => {
    const homeSkills = join(homeDir, '.claude', 'skills');
    mkdirSync(homeSkills, { recursive: true });
    process.env['SUDO_SKILLS_DIRS'] = homeSkills;

    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.skillRootsAdded).toEqual([]);
    expect(process.env['SUDO_SKILLS_DIRS']).toBe(homeSkills);
  });

  it('enumerates .claude-plugin/marketplace.json entries without auto-installing', async () => {
    writeJson(join(projectRoot, '.claude-plugin', 'marketplace.json'), {
      name: 'demo',
      plugins: [
        { name: 'p1', source: 'github:o/r', description: 'd' },
      ],
    });
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.marketplacePlugins).toHaveLength(1);
    expect(r.marketplacePlugins[0]).toMatchObject({
      id: 'p1',
      source: 'github:o/r',
      description: 'd',
    });
    expect(r.marketplacePlugins[0]?.catalogPath).toContain('marketplace.json');
  });

  it('is idempotent: a second call replaces previous hook registration and does not grow skill roots', async () => {
    mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true });
    writeJson(join(homeDir, '.claude', 'settings.json'), {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] },
    });

    await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(getPluginHookCount(CLAUDE_COMPAT_HOOKS_ID)).toBe(1);
    const after1 = process.env['SUDO_SKILLS_DIRS'] ?? '';

    await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(getPluginHookCount(CLAUDE_COMPAT_HOOKS_ID)).toBe(1);
    const after2 = process.env['SUDO_SKILLS_DIRS'] ?? '';

    // SUDO_SKILLS_DIRS must not grow on repeat ingest.
    expect(after2).toBe(after1);
    const occurrences = after2.split(':').filter(p => p === join(homeDir, '.claude', 'skills')).length;
    expect(occurrences).toBe(1);
  });

  it('captures a malformed .mcp.json error but still ingests settings hooks', async () => {
    writeFileSync(join(projectRoot, '.mcp.json'), '{ broken json', 'utf-8');
    writeJson(join(homeDir, '.claude', 'settings.json'), {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] },
    });
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.mcp.errors.length).toBeGreaterThan(0);
    expect(r.hooks.registered).toBe(1);
  });

  it('routes marketplace parse errors to the marketplaceErrors lane (not hooks.errors)', async () => {
    mkdirSync(join(projectRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.claude-plugin', 'marketplace.json'),
      '{ broken json',
      'utf-8',
    );
    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.marketplaceErrors.length).toBeGreaterThan(0);
    expect(r.hooks.errors).toEqual([]);
    expect(r.mcp.errors).toEqual([]);
  });

  it('rejects symlinked config files without following them', async () => {
    const { symlinkSync } = await import('fs');
    // Create a real elsewhere-file and symlink .mcp.json to it
    const elsewhere = join(homeDir, 'elsewhere.json');
    writeJson(elsewhere, { mcpServers: { fake: { command: 'evil' } } });
    symlinkSync(elsewhere, join(projectRoot, '.mcp.json'));

    const r = await ingestClaudeCompat(hooks, { projectRoot, homeDir });
    expect(r.mcp.registered).toBe(0);
    expect(r.mcp.errors.some((e) => e.includes('symlinks are not followed'))).toBe(true);
  });
});
