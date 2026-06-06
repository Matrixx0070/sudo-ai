/**
 * @file tests/cli/init-command.test.ts
 * @description Tests for sudo-ai init command.
 *
 * Tests:
 *  1.  runInit without --preset lists available presets
 *  2.  runInit with unknown preset returns 1
 *  3.  runInit with preset=coding loads coding.toml
 *  4.  runInit with preset=research loads research.toml
 *  5.  runInit with preset=chat loads chat.toml
 *  6.  runInit writes config/sudo-ai.toml to project root
 *  7.  Written TOML file contains [intelligence] section
 *  8.  runInit --force overwrites existing TOML without prompting
 *  9.  runInit returns 0 on success
 *  10. runInit with missing recipe file returns 1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function setupWorkspaceRecipes(projectRoot: string): void {
  const recipesDir = path.join(projectRoot, 'workspace', 'recipes');
  fs.mkdirSync(recipesDir, { recursive: true });

  const codingToml = `
id = "coding"
name = "Coding Preset"
description = "Coding preset for testing"
author = "test"
version = "1.0.0"
[config.intelligence]
default_model = "xai/grok-code-fast-1"
temperature = 0.3
max_tokens = 16384
[config.agent]
max_iterations = 200
[config.engine]
runtime = "cloud"
`;

  const researchToml = `
id = "research"
name = "Research Preset"
description = "Research preset for testing"
author = "test"
version = "1.0.0"
[config.intelligence]
default_model = "xai/grok-4-0709"
temperature = 0.7
max_tokens = 16384
[config.engine]
runtime = "cloud"
`;

  const chatToml = `
id = "chat"
name = "Chat Preset"
description = "Chat preset for testing"
author = "test"
version = "1.0.0"
[config.intelligence]
default_model = "xai/grok-4-1-fast-non-reasoning"
temperature = 0.8
max_tokens = 4096
[config.tools]
disabled = ["coder.execute"]
[config.engine]
runtime = "cloud"
`;

  fs.writeFileSync(path.join(recipesDir, 'coding.toml'), codingToml, 'utf8');
  fs.writeFileSync(path.join(recipesDir, 'research.toml'), researchToml, 'utf8');
  fs.writeFileSync(path.join(recipesDir, 'chat.toml'), chatToml, 'utf8');

  // Also ensure config/ exists
  fs.mkdirSync(path.join(projectRoot, 'config'), { recursive: true });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-init-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInit', () => {
  it('1. without --preset lists available presets', async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    const { runInit } = await import('../../src/cli/commands/init.js');
    const code = await runInit(tmpDir, {});
    console.log = originalLog;

    expect(code).toBe(0);
    const combined = output.join('\n');
    expect(combined).toMatch(/coding|research|chat/i);
    expect(combined).toMatch(/preset/i);
  });

  it('2. unknown preset returns 1', async () => {
    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    const code = await runInit(tmpDir, { preset: 'nonexistent-preset' });
    restore();
    expect(code).toBe(1);
  });

  it('3. preset=coding loads and writes TOML', async () => {
    setupWorkspaceRecipes(tmpDir);
    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    const code = await runInit(tmpDir, { preset: 'coding', force: true });
    restore();

    expect(code).toBe(0);
    const tomlPath = path.join(tmpDir, 'config', 'sudo-ai.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
  });

  it('4. preset=research loads and writes TOML', async () => {
    setupWorkspaceRecipes(tmpDir);
    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    const code = await runInit(tmpDir, { preset: 'research', force: true });
    restore();

    expect(code).toBe(0);
    const tomlPath = path.join(tmpDir, 'config', 'sudo-ai.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
  });

  it('5. preset=chat loads and writes TOML', async () => {
    setupWorkspaceRecipes(tmpDir);
    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    const code = await runInit(tmpDir, { preset: 'chat', force: true });
    restore();

    expect(code).toBe(0);
    const tomlPath = path.join(tmpDir, 'config', 'sudo-ai.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
  });

  it('6. runInit writes config/sudo-ai.toml', async () => {
    setupWorkspaceRecipes(tmpDir);
    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    await runInit(tmpDir, { preset: 'coding', force: true });
    restore();

    const tomlPath = path.join(tmpDir, 'config', 'sudo-ai.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    const content = fs.readFileSync(tomlPath, 'utf8');
    expect(content.length).toBeGreaterThan(50);
  });

  it('7. written TOML file contains [intelligence] section', async () => {
    setupWorkspaceRecipes(tmpDir);
    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    await runInit(tmpDir, { preset: 'coding', force: true });
    restore();

    const tomlPath = path.join(tmpDir, 'config', 'sudo-ai.toml');
    const content = fs.readFileSync(tomlPath, 'utf8');
    expect(content).toContain('[intelligence]');
    expect(content).toContain('default_model');
  });

  it('8. --force overwrites existing TOML without prompting', async () => {
    setupWorkspaceRecipes(tmpDir);
    const tomlPath = path.join(tmpDir, 'config', 'sudo-ai.toml');
    fs.writeFileSync(tomlPath, '# old content', 'utf8');

    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    await runInit(tmpDir, { preset: 'coding', force: true });
    restore();

    const content = fs.readFileSync(tomlPath, 'utf8');
    expect(content).not.toBe('# old content');
    expect(content).toContain('[intelligence]');
  });

  it('9. returns 0 on success', async () => {
    setupWorkspaceRecipes(tmpDir);
    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    const code = await runInit(tmpDir, { preset: 'coding', force: true });
    restore();
    expect(code).toBe(0);
  });

  it('10. missing recipe file returns 1', async () => {
    // Don't set up recipes — coding.toml won't exist
    fs.mkdirSync(path.join(tmpDir, 'workspace', 'recipes'), { recursive: true });

    const restore = suppressOutput();
    const { runInit } = await import('../../src/cli/commands/init.js');
    const code = await runInit(tmpDir, { preset: 'coding', force: true });
    restore();

    expect(code).toBe(1);
  });
});
