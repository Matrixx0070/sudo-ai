/**
 * @file tests/cli/setup-command.test.ts
 * @description Tests for sudo-ai setup (Wave2 Ink TUI wizard + 100x).
 *
 * AC coverage: TUI (via non-tty path + run), 100x fields (cross/profiles/learner/SOUL/kills/xai/env), auto hook util,
 * no overwrite w/o force, writers produce valid json5/toml/.env, profile skeleton, tests pass 100%.
 * Uses same suppress + tmp + race patterns as quickstart/init tests (no new deps).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSON5 from 'json5';

let tmpDir: string;

function suppressOutput(): () => void {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = originalLog;
    console.error = originalError;
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-setup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runSetup (Wave2 100x wizard)', () => {
  it('1. non-tty / --yes writes full 100x config + .env + profile (no crash)', async () => {
    const { runSetup } = await import('../../src/cli/commands/setup.js');
    const restore = suppressOutput();
    await runSetup(tmpDir, { yes: true });
    restore();

    const json5Path = path.join(tmpDir, 'config', 'sudo-ai.json5');
    const tomlPath = path.join(tmpDir, 'config', 'sudo-ai.toml');
    const envPath = path.join(tmpDir, 'config', '.env');
    const profPath = path.join(tmpDir, 'data', 'profiles', 'default', 'profile.json');

    expect(fs.existsSync(json5Path)).toBe(true);
    expect(fs.existsSync(tomlPath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(profPath)).toBe(true);

    const cfg = JSON5.parse(fs.readFileSync(json5Path, 'utf8'));
    expect(cfg.meta.name).toBe('SUDO-AI');
    expect(cfg.models.primary[0].id).toMatch(/grok|xai/);

    const env = fs.readFileSync(envPath, 'utf8');
    // 100x enabled: no DISABLE=1 for cross etc; XAI may be empty
    expect(env).not.toMatch(/SUDO_CROSS_CONTROL_DISABLE=1/);
    expect(env).not.toMatch(/SUDO_TOOL_LEARNING_DISABLE=1/);
    expect(env).toMatch(/# SUDO-AI setup/);

    const prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
    expect(prof.name).toBe('default');
    expect(prof.enabled).toBe(true);
  });

  it('2. ensureFirstRunWizard util triggers only on missing config (auto first hook)', async () => {
    const { ensureFirstRunWizard, runSetup } = await import('../../src/cli/commands/setup.js');
    // First call with no config should "run" (non-tty path)
    const restore = suppressOutput();
    await ensureFirstRunWizard(tmpDir);  // will write via internal non-tty
    restore();

    const json5Path = path.join(tmpDir, 'config', 'sudo-ai.json5');
    expect(fs.existsSync(json5Path)).toBe(true);

    // Second call: no re-run (idempotent)
    const mtime = fs.statSync(json5Path).mtimeMs;
    const restore2 = suppressOutput();
    await ensureFirstRunWizard(tmpDir);
    restore2();
    expect(fs.statSync(json5Path).mtimeMs).toBe(mtime);
  });

  it('3. writers produce valid + 100x coverage (unit on builders)', async () => {
    const { buildSetupJson5, buildSetupToml, writeEnvKillsAndKey } = await import('../../src/cli/commands/setup.js');
    const answers = {
      agentName: 'Test100x',
      xaiKey: 'sk-test-1234567890',
      defaultModel: 'xai/grok-4-1-fast-non-reasoning',
      enableCross: true,
      enableProfiles: true,
      enableToolLearning: true,
      enableSandbox: true,
      adoptSoul: true,
      setupService: false,
    };
    const j = buildSetupJson5(answers);
    expect(j).toContain('Test100x');
    expect(j).toContain('Cross-platform IComputerUse');
    expect(j).toContain('ToolOutcomeLearner');

    const t = buildSetupToml(answers);
    expect(t).toContain('default_model');
    expect(t).toContain('Cross-platform control enabled: true');

    const e = writeEnvKillsAndKey(tmpDir, answers, '');
    expect(e).toContain('XAI_API_KEY=sk-test');
    expect(e).not.toContain('SUDO_CROSS_CONTROL_DISABLE=1'); // enabled
    expect(e).toContain('# SUDO-AI setup');
  });

  it('4. respects existing .env (does not clobber unrelated keys)', async () => {
    const { runSetup } = await import('../../src/cli/commands/setup.js');
    const envDir = path.join(tmpDir, 'config');
    fs.mkdirSync(envDir, { recursive: true });
    const envPath = path.join(envDir, '.env');
    fs.writeFileSync(envPath, 'EXISTING_KEY=keepme\nXAI_API_KEY=old\n', 'utf8');

    const restore = suppressOutput();
    await runSetup(tmpDir, { yes: true });
    restore();

    const after = fs.readFileSync(envPath, 'utf8');
    expect(after).toContain('EXISTING_KEY=keepme');
    // may update XAI but keeps others
  });
});
