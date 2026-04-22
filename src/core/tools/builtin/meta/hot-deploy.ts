/**
 * @file hot-deploy.ts
 * @description meta.hot-deploy — compile a TypeScript skill file and register
 * it into the live ToolRegistry without any restart.
 *
 * Flow:
 *   1. Write TypeScript source to src/core/tools/builtin/custom/<name>.ts
 *   2. Compile with esbuild (fast, in-process) to dist/core/tools/builtin/custom/<name>.js
 *   3. Dynamic import() the compiled JS
 *   4. Find exported ToolDefinition (any export ending in "Tool" or "tool")
 *   5. Register it in ToolRegistry.getGlobal() — immediately available to the agent
 *   6. Return confirmation with tool name and schema summary
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../../shared/logger.js';
import { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const logger = createLogger('meta:hot-deploy');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const CUSTOM_SRC_DIR  = path.join(PROJECT_ROOT, 'src/core/tools/builtin/custom');
const CUSTOM_DIST_DIR = path.join(PROJECT_ROOT, 'dist/core/tools/builtin/custom');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDirs(): Promise<void> {
  await mkdir(CUSTOM_SRC_DIR,  { recursive: true });
  await mkdir(CUSTOM_DIST_DIR, { recursive: true });
}

/** Compile a single TS file to JS using esbuild (already a dep of the project). */
async function compileTs(srcPath: string, outPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Dynamically import esbuild — it's already installed as a build dep
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [srcPath],
      outfile: outPath,
      bundle: false,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      sourcemap: false,
      logLevel: 'silent',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Find the first exported ToolDefinition in a dynamically imported module. */
function findToolExport(mod: Record<string, unknown>): ToolDefinition | null {
  for (const [key, value] of Object.entries(mod)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as ToolDefinition).name === 'string' &&
      typeof (value as ToolDefinition).execute === 'function' &&
      typeof (value as ToolDefinition).description === 'string'
    ) {
      logger.debug({ export: key }, 'Found ToolDefinition export');
      return value as ToolDefinition;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const hotDeployTool: ToolDefinition = {
  name: 'meta.hot-deploy',
  description:
    'Compile a TypeScript skill and register it into the LIVE tool registry — no restart needed. ' +
    'Give it a skill name and TypeScript source code. It compiles with esbuild, imports the module, ' +
    'and registers the tool immediately. The new skill is available in the SAME session. ' +
    'Use after meta.skill-creator generates code to make it instantly active.',
  category: 'meta',
  timeout: 60_000,
  parameters: {
    skillName: {
      type: 'string',
      required: true,
      description: 'Dot-namespaced tool name matching the export (e.g. "custom.my-tool").',
    },
    code: {
      type: 'string',
      required: true,
      description: 'Complete TypeScript source code of the ToolDefinition. Must export a const ending in "Tool" that implements ToolDefinition.',
    },
    overwrite: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'If true, overwrite and re-register an existing tool with the same name.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

    const skillName = typeof params['skillName'] === 'string' ? params['skillName'].trim() : '';
    const code      = typeof params['code']      === 'string' ? params['code'].trim()      : '';
    const overwrite = params['overwrite'] === true;

    if (!skillName) return { success: false, output: 'meta.hot-deploy: "skillName" is required.' };
    if (!code)      return { success: false, output: 'meta.hot-deploy: "code" is required.' };

    // Validate name pattern
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(skillName)) {
      return { success: false, output: `meta.hot-deploy: skillName must be <category>.<action> lowercase. Got: "${skillName}"` };
    }

    // Check if already registered
    const liveRegistry = ToolRegistry.getGlobal();
    if (!liveRegistry) {
      return { success: false, output: 'meta.hot-deploy: live registry not available. System may still be booting.' };
    }

    if (!overwrite && liveRegistry.get(skillName)) {
      return { success: false, output: `meta.hot-deploy: tool "${skillName}" already registered. Pass overwrite:true to replace it.` };
    }

    log.info({ skillName }, 'meta.hot-deploy: starting');

    await ensureDirs();

    // 1. Write source
    const safeFileName = skillName.replace('.', '-');
    const srcPath  = path.join(CUSTOM_SRC_DIR,  `${safeFileName}.ts`);
    const distPath = path.join(CUSTOM_DIST_DIR, `${safeFileName}.js`);

    await writeFile(srcPath, code, 'utf8');
    log.info({ srcPath }, 'meta.hot-deploy: source written');

    // 2. Compile
    const compile = await compileTs(srcPath, distPath);
    if (!compile.ok) {
      return {
        success: false,
        output: `meta.hot-deploy: compilation failed for "${skillName}".\n\nError:\n${compile.error}\n\nFix the TypeScript and try again.`,
      };
    }
    log.info({ distPath }, 'meta.hot-deploy: compiled successfully');

    // 3. Dynamic import (cache-bust with timestamp)
    let mod: Record<string, unknown>;
    try {
      const importUrl = `file://${distPath}?v=${Date.now()}`;
      mod = (await import(importUrl)) as Record<string, unknown>;
    } catch (err) {
      return {
        success: false,
        output: `meta.hot-deploy: import failed for "${skillName}".\n\nError: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 4. Find the exported tool
    const tool = findToolExport(mod);
    if (!tool) {
      return {
        success: false,
        output: `meta.hot-deploy: no ToolDefinition found in module exports for "${skillName}". Make sure you export a const with { name, description, execute }.`,
      };
    }

    // Verify the exported name matches expected
    if (tool.name !== skillName) {
      log.warn({ expected: skillName, actual: tool.name }, 'meta.hot-deploy: name mismatch — using actual tool name');
    }

    // 5. Register live
    liveRegistry.register(tool);
    log.info({ toolName: tool.name }, 'meta.hot-deploy: registered in live registry');

    const paramCount = Object.keys(tool.parameters ?? {}).length;

    return {
      success: true,
      output: [
        `✓ Tool "${tool.name}" is now LIVE — no restart needed.`,
        `  Category: ${tool.category}`,
        `  Parameters: ${paramCount}`,
        `  Source: ${srcPath}`,
        `  Built:  ${distPath}`,
        ``,
        `You can call it immediately: ${tool.name}`,
      ].join('\n'),
      data: {
        toolName: tool.name,
        category: tool.category,
        paramCount,
        srcPath,
        distPath,
      },
      artifacts: [
        { path: srcPath,  action: 'created' },
        { path: distPath, action: 'created' },
      ],
    };
  },
};
