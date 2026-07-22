/**
 * Fail-closed schema guard for the agent's self-configuration tools.
 *
 * Root cause (prod, 2026-07-22): meta.self-modify edit-config and
 * meta.self-config set persisted arbitrary top-level keys (e.g.
 * SUDO_TELEGRAM_GROK_VOICE) into config/sudo-ai.json5. The loader validates
 * against SudoConfigSchema ({ additionalProperties: false }) on every boot,
 * so the next pm2 restart crash-looped with "Unexpected property".
 *
 * These tests prove both write paths now validate against SudoConfigSchema
 * BEFORE persisting: valid edits still succeed, boot-breaking edits are
 * refused and leave the file byte-for-byte unchanged on disk.
 *
 * Both tools resolve the config path at module load (self-config via cwd,
 * self-modify via SUDO_AI_HOME), so each test pins a temp fixture dir via
 * env + chdir and dynamic-imports the tool after vi.resetModules().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { SudoConfigSchema } from '../../../src/core/config/schema.js';
import type { ToolContext } from '../../../src/core/tools/types.js';

function ctx(): ToolContext {
  return { sessionId: 'test', workingDir: '/tmp', config: {}, logger: {} } as unknown as ToolContext;
}

let tmp: string;
let configFile: string;
let originalCwd: string;
let savedHome: string | undefined;
let savedData: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  savedHome = process.env['SUDO_AI_HOME'];
  savedData = process.env['DATA_DIR'];

  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-config-guard-'));
  mkdirSync(path.join(tmp, 'config'), { recursive: true });
  configFile = path.join(tmp, 'config', 'sudo-ai.json5');

  // Minimal schema-valid fixture (never the repo's real config).
  const valid = Value.Create(SudoConfigSchema) as Record<string, unknown>;
  (valid['meta'] as Record<string, unknown>)['name'] = 'fixture';
  writeFileSync(configFile, JSON.stringify(valid, null, 2) + '\n', 'utf8');

  process.env['SUDO_AI_HOME'] = tmp; // self-modify anchors CONFIG_FILE here
  process.env['DATA_DIR'] = path.join(tmp, 'data'); // backups go to temp too
  process.chdir(tmp); // self-config resolves config path from cwd
  vi.resetModules(); // both modules capture paths at import time
});

afterEach(() => {
  process.chdir(originalCwd);
  if (savedHome === undefined) delete process.env['SUDO_AI_HOME'];
  else process.env['SUDO_AI_HOME'] = savedHome;
  if (savedData === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = savedData;
  rmSync(tmp, { recursive: true, force: true });
});

describe('meta.self-modify edit-config schema guard', () => {
  it('still allows a schema-valid edit', async () => {
    const { selfModifyTool } = await import('../../../src/core/tools/builtin/meta/self-modify.js');
    const res = await selfModifyTool.execute(
      { action: 'edit-config', configKey: 'meta.name', configValue: 'renamed-agent' },
      ctx(),
    );
    expect(res.success).toBe(true);
    expect(readFileSync(configFile, 'utf8')).toContain('renamed-agent');
  });

  it('refuses a boot-breaking top-level key and leaves the file unchanged', async () => {
    const { selfModifyTool } = await import('../../../src/core/tools/builtin/meta/self-modify.js');
    const before = readFileSync(configFile, 'utf8');
    const res = await selfModifyTool.execute(
      { action: 'edit-config', configKey: 'SUDO_TELEGRAM_GROK_VOICE', configValue: '1' },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain('SUDO_TELEGRAM_GROK_VOICE');
    expect(res.output).toContain('ecosystem.config.cjs');
    expect(readFileSync(configFile, 'utf8')).toBe(before); // byte-identical
  });
});

describe('meta.self-config set schema guard', () => {
  it('still allows a schema-valid set', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    const res = await selfConfigTool.execute(
      { action: 'set', path: 'meta.name', value: '"renamed-agent"' },
      ctx(),
    );
    expect(res.success).toBe(true);
    expect(readFileSync(configFile, 'utf8')).toContain('renamed-agent');
  });

  it('refuses a boot-breaking top-level key and leaves the file unchanged', async () => {
    const { selfConfigTool } = await import('../../../src/core/tools/builtin/meta/self-config.js');
    const before = readFileSync(configFile, 'utf8');
    const res = await selfConfigTool.execute(
      { action: 'set', path: 'SUDO_GROK_WEBSESSION', value: '"1"' },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain('SUDO_GROK_WEBSESSION');
    expect(res.output).toContain('ecosystem.config.cjs');
    expect(readFileSync(configFile, 'utf8')).toBe(before); // byte-identical
  });
});
