/**
 * F125 (Wave H) — parameterized smoke test over EVERY builtin tool category.
 *
 * Mirrors the real loader contract (src/core/tools/loader.ts loadBuiltinTools):
 * each category dir under src/core/tools/builtin/ ships an index.ts whose
 * `register*Tools(registry)` exports register an array of ToolDefinitions.
 * (Note: categories do NOT use `export default` — the loader discovers
 * registration functions by name — so this suite collects the registered
 * tool definitions through a capture registry rather than a default export.)
 *
 * Assertions per tool: non-empty dotted name, non-empty description,
 * category string, parameters object, execute function. Globally: no
 * duplicate tool names across categories. Snapshot-free: no brittle counts.
 *
 * Import/registration failures FAIL the test unless the category is on the
 * explicit ENV_DEPENDENT_CATEGORIES skip-list (documented env requirement).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolDefinition } from '../../src/core/tools/types.js';
import type { ToolRegistry } from '../../src/core/tools/registry.js';

const BUILTIN_DIR = join(__dirname, '../../src/core/tools/builtin');

// Several categories gate REGISTRATION (not just execution) behind env flags,
// reading process.env at registrar-invoke time. Enable them here so the smoke
// test validates their real tool definitions instead of silently seeing zero:
//  - business/earning/finance: quarantined behind SUDO_ENABLE_PERSONA_TOOLS=1
//  - github:                   SUDO_GITHUB_TOOLS=1
//  - gdrive (F5 user files):   SUDO_GDRIVE=1 + SUDO_GDRIVE_USER_FILES=1
process.env['SUDO_ENABLE_PERSONA_TOOLS'] = '1';
process.env['SUDO_GITHUB_TOOLS'] = '1';
process.env['SUDO_GDRIVE'] = '1';
process.env['SUDO_GDRIVE_USER_FILES'] = '1';

/**
 * Categories that legitimately register ZERO tools even when enabled.
 *  - cognition: index.ts registers nothing — "category reserved for future use".
 */
const EMPTY_ALLOWED = new Set<string>(['cognition']);

/**
 * Categories allowed to fail on import/registration in a bare test env,
 * each with the documented env requirement that justifies the exemption.
 * Keep this list EMPTY unless a category genuinely cannot load without
 * external env/deps — do not use it to hide real defects.
 */
const ENV_DEPENDENT_CATEGORIES: Record<string, string> = {
  // (none currently — every category loads in a bare env; add entries only
  //  with a comment citing the required env var / external dependency)
};

/** Enumerate category dirs on disk exactly like the loader does. */
function listCategoryDirs(): string[] {
  return readdirSync(BUILTIN_DIR)
    .filter((entry) => {
      try {
        return statSync(join(BUILTIN_DIR, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Category dirs that are tool categories (have an index.ts entry-point). */
const allDirs = listCategoryDirs();
const categoryDirs = allDirs.filter((d) => existsSync(join(BUILTIN_DIR, d, 'index.ts')));
const nonCategoryDirs = allDirs.filter((d) => !categoryDirs.includes(d));

interface CategoryResult {
  category: string;
  status: 'ok' | 'empty' | 'import-failed' | 'no-registrar';
  toolCount: number;
  error?: string;
}

const summary: CategoryResult[] = [];
const allToolsByName = new Map<string, string>(); // tool name -> category

/**
 * Minimal capture registry satisfying what register*Tools functions use
 * (register, registerMany, get, size).
 */
function makeCaptureRegistry(captured: ToolDefinition[]): ToolRegistry {
  const reg = {
    register(tool: ToolDefinition): void {
      captured.push(tool);
    },
    registerMany(tools: ToolDefinition[]): void {
      for (const t of tools) captured.push(t);
    },
    get(_name: string): ToolDefinition | undefined {
      return undefined;
    },
    get size(): number {
      return captured.length;
    },
  };
  return reg as unknown as ToolRegistry;
}

describe('builtin category smoke (F125)', () => {
  it('finds a plausible set of category directories on disk', () => {
    // Snapshot-free sanity: there are many categories, and known anchors exist.
    expect(categoryDirs.length).toBeGreaterThan(10);
    for (const anchor of ['system', 'coder', 'browser', 'fs-stat']) {
      expect(categoryDirs).toContain(anchor);
    }
  });

  describe.each(categoryDirs)('category: %s', (category) => {
    it('imports and registers a valid array of tool definitions', async () => {
      const indexUrl = pathToFileURL(join(BUILTIN_DIR, category, 'index.ts')).href;
      let mod: Record<string, unknown>;
      try {
        mod = (await import(indexUrl)) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.push({ category, status: 'import-failed', toolCount: 0, error: msg });
        if (category in ENV_DEPENDENT_CATEGORIES) {
          // Documented env requirement — import failure is acceptable but must
          // still be a clear Error, not a silent undefined.
          expect(err).toBeInstanceOf(Error);
          expect(msg.length).toBeGreaterThan(0);
          return;
        }
        throw new Error(`Category '${category}' failed to import in a bare env: ${msg}`);
      }

      // Loader contract: at least one register*Tools export per category.
      const registrars = Object.entries(mod).filter(
        ([name, value]) => /^register.+Tools$/.test(name) && typeof value === 'function',
      );
      if (registrars.length === 0) {
        summary.push({ category, status: 'no-registrar', toolCount: 0 });
        throw new Error(
          `Category '${category}' exports no register*Tools function — loader would load 0 tools`,
        );
      }

      const captured: ToolDefinition[] = [];
      const registry = makeCaptureRegistry(captured);
      for (const [name, fn] of registrars) {
        try {
          await Promise.resolve((fn as (r: ToolRegistry) => unknown)(registry));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary.push({ category, status: 'import-failed', toolCount: captured.length, error: msg });
          if (category in ENV_DEPENDENT_CATEGORIES) {
            expect(err).toBeInstanceOf(Error);
            return;
          }
          throw new Error(`Category '${category}' registrar ${name} threw in a bare env: ${msg}`);
        }
      }

      // The registered set is the category's tool-definition array.
      expect(Array.isArray(captured)).toBe(true);
      if (captured.length === 0) {
        expect(
          EMPTY_ALLOWED.has(category),
          `category '${category}' registered zero tools and is not on the EMPTY_ALLOWED list`,
        ).toBe(true);
        summary.push({ category, status: 'empty', toolCount: 0 });
        return;
      }

      for (const tool of captured) {
        const label = `${category} -> ${String((tool as { name?: unknown })?.name ?? '<unnamed>')}`;
        expect(tool, label).toBeTypeOf('object');
        // Non-empty dotted name.
        expect(tool.name, `${label}: name must be a non-empty string`).toBeTypeOf('string');
        expect(tool.name.length, `${label}: name empty`).toBeGreaterThan(0);
        expect(tool.name, `${label}: name must be dotted <category>.<action>`).toMatch(
          /^[^.\s]+\.[^\s]+$/,
        );
        // Non-empty description.
        expect(tool.description, `${label}: description must be a string`).toBeTypeOf('string');
        expect(tool.description.trim().length, `${label}: description empty`).toBeGreaterThan(0);
        // Category string.
        expect(tool.category, `${label}: category must be a non-empty string`).toBeTypeOf('string');
        expect(String(tool.category).length, `${label}: category empty`).toBeGreaterThan(0);
        // Parameters object present (may be empty for zero-arg tools).
        expect(tool.parameters, `${label}: parameters must be an object`).toBeTypeOf('object');
        expect(tool.parameters, `${label}: parameters must not be null`).not.toBeNull();
        expect(Array.isArray(tool.parameters), `${label}: parameters must not be an array`).toBe(
          false,
        );
        // Execute function.
        expect(tool.execute, `${label}: execute must be a function`).toBeTypeOf('function');

        // Cross-category duplicate tracking.
        const prior = allToolsByName.get(tool.name);
        expect(
          prior,
          `duplicate tool name '${tool.name}' registered by both '${prior}' and '${category}'`,
        ).toBeUndefined();
        allToolsByName.set(tool.name, category);
      }

      summary.push({ category, status: 'ok', toolCount: captured.length });
    });
  });

  it('has no duplicate tool names across all categories', () => {
    // Per-tool duplicate assertions above are the real guard; this re-checks
    // the aggregate map is internally consistent and non-trivial.
    const names = [...allToolsByName.keys()];
    expect(new Set(names).size).toBe(names.length);
    const exempt = Object.keys(ENV_DEPENDENT_CATEGORIES).length + EMPTY_ALLOWED.size;
    expect(names.length).toBeGreaterThan(categoryDirs.length - exempt - 1);
  });

  afterAll(() => {
    const lines = summary
      .sort((a, b) => a.category.localeCompare(b.category))
      .map(
        (r) =>
          `  ${r.category.padEnd(18)} ${r.status.padEnd(14)} tools=${r.toolCount}` +
          (r.error ? ` error=${r.error.slice(0, 120)}` : ''),
      );
    process.stdout.write(
      [
        '',
        `builtin category smoke summary (${summary.length} categories, ${allToolsByName.size} tools total):`,
        ...lines,
        nonCategoryDirs.length
          ? `  (non-category subdirs without index.ts, skipped like the loader does: ${nonCategoryDirs.join(', ')})`
          : '',
        '',
      ].join('\n') + '\n',
    );
  });
});
