/**
 * hot-load.test.ts — Unit tests for the hotLoad() export in loader.ts.
 *
 * Tests:
 *   1. Synthetic .mjs file in /tmp registers a tool via hotLoad → found in registry  (1 test)
 *   2. Attempting to overwrite a bundled (cold-loaded) tool name → throws ToolError   (1 test)
 *   3. Attempting to overwrite a previously hot-loaded tool name → succeeds            (1 test)
 *   4. Malformed / non-existent file path → returns [] not throws                     (2 tests)
 *   5. Module with no register*Tools exports → returns []                              (1 test)
 *   6. Partial success: second register*Tools throws, first names still returned       (1 test)
 *
 * Total: 7 tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Mock logger — suppress noise
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { hotLoad } from '../../src/core/tools/loader.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDir = os.tmpdir();

/** Build a minimal ToolDefinition for use in test fixtures. */
function makeToolDef(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    category: 'meta',
    parameters: {},
    execute: async (_params, _ctx) => ({ success: true, output: name }),
  };
}

/** Minimal ToolContext. */
const ctx: ToolContext = {
  sessionId: 'test-hot-load',
  workingDir: '/tmp',
};
// ctx is declared for type completeness but hotLoad doesn't use it; registry used directly.
void ctx;

// ---------------------------------------------------------------------------
// Fixture file management
// ---------------------------------------------------------------------------

/** Paths written during tests — cleaned up in afterAll. */
const writtenFiles: string[] = [];

async function writeMjsFixture(filename: string, content: string): Promise<string> {
  const filePath = join(tmpDir, filename);
  await writeFile(filePath, content, 'utf8');
  writtenFiles.push(filePath);
  return filePath;
}

afterAll(async () => {
  await Promise.allSettled(writtenFiles.map((f) => unlink(f)));
});

// ---------------------------------------------------------------------------
// Fixture content builders
// ---------------------------------------------------------------------------

/**
 * ESM fixture that exports one registerFooTools function registering a single tool.
 */
function simpleRegisterFixture(toolName: string): string {
  // Written as pure ESM (.mjs) so it exercises the native import() branch.
  return `
export function registerHotFixtureTools(registry) {
  registry.register({
    name: ${JSON.stringify(toolName)},
    description: 'hot-loaded test tool',
    category: 'meta',
    parameters: {},
    execute: async () => ({ success: true, output: 'hot' }),
  });
}
`;
}

/**
 * Fixture with TWO register*Tools exports — the first succeeds, the second throws.
 */
function partialSuccessFixture(firstToolName: string): string {
  return `
export function registerFirstTools(registry) {
  registry.register({
    name: ${JSON.stringify(firstToolName)},
    description: 'first hot tool',
    category: 'meta',
    parameters: {},
    execute: async () => ({ success: true, output: 'first' }),
  });
}
export function registerSecondTools(_registry) {
  throw new Error('intentional failure in second registrar');
}
`;
}

/**
 * Fixture with no register*Tools exports.
 */
function noRegisterFixture(): string {
  return `
export const notARegistrar = 42;
export function helperFn() { return 'helper'; }
`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hotLoad()', () => {
  // -------------------------------------------------------------------------
  // 1. Happy path: synthetic .mjs registers a tool → found in registry
  // -------------------------------------------------------------------------
  it('registers a tool from a valid .mjs fixture', async () => {
    const toolName = `hot_tool_${Date.now()}`;
    const filePath = await writeMjsFixture(`fixture-happy-${toolName}.mjs`, simpleRegisterFixture(toolName));

    const registry = new ToolRegistry();
    const names = await hotLoad(filePath, registry);

    expect(names).toContain(toolName);
    expect(registry.get(toolName)).toBeDefined();
    expect(registry.get(toolName)!.name).toBe(toolName);
  });

  // -------------------------------------------------------------------------
  // 2. Bundled-tool collision → excluded from result, original preserved
  //
  //    hotLoad catches per-registrar errors internally (fail-open).  The
  //    observable contract is: the bundled name does NOT appear in the
  //    returned array, and the original bundled tool is NOT overwritten.
  // -------------------------------------------------------------------------
  it('does not overwrite a bundled (cold-loaded) tool and excludes name from result', async () => {
    const toolName = `bundled_tool_${Date.now()}`;
    const registry = new ToolRegistry();

    // Pre-register the "bundled" tool directly (simulates loadBuiltinTools).
    const bundledDef = makeToolDef(toolName);
    registry.register(bundledDef);

    // Try to hot-load a module that registers the same name.
    const filePath = await writeMjsFixture(`fixture-collision-${toolName}.mjs`, simpleRegisterFixture(toolName));
    const names = await hotLoad(filePath, registry);

    // Name must be excluded from the result.
    expect(names).not.toContain(toolName);
    // The original bundled definition must still be in the registry.
    expect(registry.get(toolName)).toBeDefined();
    expect(registry.get(toolName)!.description).toBe(bundledDef.description);
  });

  // -------------------------------------------------------------------------
  // 3. Hot-hot overwrite → succeeds
  // -------------------------------------------------------------------------
  it('allows overwriting a previously hot-loaded tool name', async () => {
    const toolName = `hot_overwrite_${Date.now()}`;
    const registry = new ToolRegistry();

    // First hot-load: registers toolName.
    const firstFixture = await writeMjsFixture(`fixture-first-${toolName}.mjs`, simpleRegisterFixture(toolName));
    const firstNames = await hotLoad(firstFixture, registry);
    expect(firstNames).toContain(toolName);

    // Second hot-load: same toolName → should succeed (hot-hot overwrite allowed).
    const overwriteContent = `
export function registerOverwriteTools(registry) {
  registry.register({
    name: ${JSON.stringify(toolName)},
    description: 'overwritten hot tool',
    category: 'meta',
    parameters: {},
    execute: async () => ({ success: true, output: 'overwritten' }),
  });
}
`;
    const secondFixture = await writeMjsFixture(`fixture-second-${toolName}.mjs`, overwriteContent);
    const secondNames = await hotLoad(secondFixture, registry);

    expect(secondNames).toContain(toolName);
    // The tool in the registry should reflect the overwritten version.
    const tool = registry.get(toolName);
    expect(tool).toBeDefined();
    expect(tool!.description).toBe('overwritten hot tool');
  });

  // -------------------------------------------------------------------------
  // 4. Non-existent file path → returns [] not throws
  // -------------------------------------------------------------------------
  it('returns [] for a non-existent file path', async () => {
    const registry = new ToolRegistry();
    const names = await hotLoad('/tmp/__nonexistent_sudo_ai_test_file__.mjs', registry);
    expect(names).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. Empty / invalid filePath argument → returns []
  // -------------------------------------------------------------------------
  it('returns [] when filePath is an empty string', async () => {
    const registry = new ToolRegistry();
    const names = await hotLoad('', registry);
    expect(names).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 6. Module with no register*Tools exports → returns []
  // -------------------------------------------------------------------------
  it('returns [] when module has no register*Tools exports', async () => {
    const filePath = await writeMjsFixture(`fixture-noregister-${Date.now()}.mjs`, noRegisterFixture());
    const registry = new ToolRegistry();
    const names = await hotLoad(filePath, registry);
    expect(names).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 7. Partial success: first registrar succeeds, second throws → first names returned
  // -------------------------------------------------------------------------
  it('returns names from successful registrars even when a later one throws', async () => {
    const firstToolName = `partial_first_${Date.now()}`;
    const filePath = await writeMjsFixture(
      `fixture-partial-${firstToolName}.mjs`,
      partialSuccessFixture(firstToolName),
    );
    const registry = new ToolRegistry();
    const names = await hotLoad(filePath, registry);

    // First tool was registered before the second function threw.
    expect(names).toContain(firstToolName);
    expect(registry.get(firstToolName)).toBeDefined();
  });
});
