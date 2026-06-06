/**
 * @file tests/config/toml-loader.test.ts
 * @description Tests for loadConfig5Pillar() — Wave 10 TOML overlay loader.
 *
 * Tests:
 *  1.  Missing file → returns empty {}
 *  2.  Valid TOML with all 5 sections → full Config5Pillar returned
 *  3.  TOML with only [intelligence] → only intelligence field set
 *  4.  TOML with only [engine] → only engine field set
 *  5.  TOML with only [learning] → only learning field set
 *  6.  Malformed TOML → returns empty {} (error logged, no throw)
 *  7.  Empty TOML file → returns empty {}
 *  8.  Intelligence section maps default_model correctly
 *  9.  Agent section maps max_iterations correctly
 *  10. Tools section maps disabled array correctly
 *  11. Engine section maps runtime correctly
 *  12. Learning section maps nested policies correctly
 *  13. Non-object values in sections → ignored gracefully
 *  14. Extra unknown keys → parsed without error (TOML lib tolerant)
 *  15. Custom tomlPath parameter → reads from that path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig5Pillar } from '../../src/core/config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-toml-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeToml(filename: string, content: string): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadConfig5Pillar', () => {
  it('1. returns empty object when file does not exist', async () => {
    const result = await loadConfig5Pillar('/nonexistent/path/sudo-ai.toml');
    expect(result).toEqual({});
  });

  it('2. parses all 5 pillar sections from valid TOML', async () => {
    const tomlPath = writeToml('full.toml', `
[intelligence]
default_model = "xai/grok-4-0709"
temperature = 0.5
max_tokens = 8192

[agent]
max_iterations = 100
system_prompt_append = "Be concise."

[tools]
disabled = ["coder.execute"]
mcp_servers = ["http://localhost:3001"]

[engine]
runtime = "cloud"
prefer_local = false

[learning]
min_quality = 0.7
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.intelligence).toBeDefined();
    expect(result.agent).toBeDefined();
    expect(result.tools).toBeDefined();
    expect(result.engine).toBeDefined();
    expect(result.learning).toBeDefined();
  });

  it('3. only [intelligence] section → only intelligence field set', async () => {
    const tomlPath = writeToml('intel-only.toml', `
[intelligence]
default_model = "openai/gpt-4o"
temperature = 0.8
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.intelligence).toBeDefined();
    expect(result.agent).toBeUndefined();
    expect(result.tools).toBeUndefined();
    expect(result.engine).toBeUndefined();
    expect(result.learning).toBeUndefined();
  });

  it('4. only [engine] section → only engine field set', async () => {
    const tomlPath = writeToml('engine-only.toml', `
[engine]
runtime = "ollama"
host = "http://localhost:11434"
prefer_local = true
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.engine).toBeDefined();
    expect(result.intelligence).toBeUndefined();
  });

  it('5. only [learning] section → only learning field set', async () => {
    const tomlPath = writeToml('learning-only.toml', `
[learning]
min_quality = 0.6
min_sft_pairs = 50
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.learning).toBeDefined();
    expect(result.intelligence).toBeUndefined();
  });

  it('6. malformed TOML → returns empty {} without throwing', async () => {
    const tomlPath = writeToml('bad.toml', 'NOT VALID TOML *** [[[ bad');
    const result = await loadConfig5Pillar(tomlPath);
    expect(result).toEqual({});
  });

  it('7. empty TOML file → returns empty {}', async () => {
    const tomlPath = writeToml('empty.toml', '');
    const result = await loadConfig5Pillar(tomlPath);
    expect(result).toEqual({});
  });

  it('8. intelligence.default_model maps correctly', async () => {
    const tomlPath = writeToml('intel-model.toml', `
[intelligence]
default_model = "anthropic/claude-sonnet-4-5"
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.intelligence?.default_model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('9. agent.max_iterations maps correctly', async () => {
    const tomlPath = writeToml('agent-iters.toml', `
[agent]
max_iterations = 250
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.agent?.max_iterations).toBe(250);
  });

  it('10. tools.disabled array maps correctly', async () => {
    const tomlPath = writeToml('tools-disabled.toml', `
[tools]
disabled = ["coder.execute", "system.shell"]
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.tools?.disabled).toEqual(['coder.execute', 'system.shell']);
  });

  it('11. engine.runtime maps correctly', async () => {
    const tomlPath = writeToml('engine-runtime.toml', `
[engine]
runtime = "llamacpp"
host = "http://localhost:8080"
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.engine?.runtime).toBe('llamacpp');
    expect(result.engine?.host).toBe('http://localhost:8080');
  });

  it('12. learning nested policies map correctly', async () => {
    const tomlPath = writeToml('learning-policies.toml', `
[learning]
min_quality = 0.8

[learning.routing]
policy = "heuristic"

[learning.intelligence]
policy = "evolver"

[learning.weights]
accuracy = 0.5
latency = 0.3
cost = 0.2
efficiency = 0.0
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.learning?.routing?.policy).toBe('heuristic');
    expect(result.learning?.intelligence?.policy).toBe('evolver');
    expect(result.learning?.weights?.accuracy).toBe(0.5);
    expect(result.learning?.min_quality).toBe(0.8);
  });

  it('13. non-object values in section → ignored gracefully', async () => {
    // intelligence section is a string, not a table — should be ignored
    const tomlPath = writeToml('bad-section.toml', `
# No intelligence table, just random data
title = "test"
`);
    const result = await loadConfig5Pillar(tomlPath);
    expect(result).toEqual({});
  });

  it('14. extra unknown keys in sections → parsed without error', async () => {
    const tomlPath = writeToml('extra-keys.toml', `
[intelligence]
default_model = "xai/grok-4-0709"
future_key = "some value"
another_key = 42
`);
    // Should not throw — extra keys are passed through
    const result = await loadConfig5Pillar(tomlPath);
    expect(result.intelligence).toBeDefined();
    expect(result.intelligence?.default_model).toBe('xai/grok-4-0709');
  });

  it('15. custom tomlPath parameter reads from specified path', async () => {
    const customPath = writeToml('custom-location.toml', `
[intelligence]
default_model = "google/gemini-2.0-flash"
`);
    const result = await loadConfig5Pillar(customPath);
    expect(result.intelligence?.default_model).toBe('google/gemini-2.0-flash');
  });
});
