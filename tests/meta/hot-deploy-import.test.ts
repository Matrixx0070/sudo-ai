/**
 * @file tests/meta/hot-deploy-import.test.ts
 * @description Regression test for the prod hot-deploy failure:
 *
 *   "meta.hot-deploy: import failed for "email.polish".
 *    Error: Cannot find module '/root/sudo-ai-v4/dist/core/shared/logger.js'
 *    imported from /root/sudo-ai-v4/dist/core/tools/builtin/custom/email-polish.js"
 *
 * Root cause: esbuild ran with bundle:false, so the generator-emitted relative
 * import `'../../../shared/logger.js'` survived verbatim into the compiled
 * output and resolved against dist/core/shared/logger.js — which never exists
 * (the runtime runs from src/ via tsx; dist/ holds only hot-deployed custom
 * tools). Fix: bundle project-relative imports (bundle:true) while keeping
 * bare package imports external (packages:'external', resolved from
 * node_modules by walk-up).
 *
 * This test drives the REAL hotDeployTool.execute() end-to-end — real esbuild
 * compile to dist/, real dynamic import, real registry registration — with a
 * minimal tool that uses exactly the imports meta.skill-creator's template
 * emits (types.js + createLogger from shared/logger.js).
 *
 * NOTE: hot-deploy resolves PROJECT_ROOT from its own module URL, so the test
 * necessarily writes real files under src/ and dist/ custom dirs; afterAll
 * removes them.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '../../src/core/tools/types.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { hotDeployTool } from '../../src/core/tools/builtin/meta/hot-deploy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../');

const TOOL_NAME = 'custom.hotdeploy-import-repro';
const FILE_BASE = 'custom-hotdeploy-import-repro';
const SRC_FILE = path.join(PROJECT_ROOT, 'src/core/tools/builtin/custom', `${FILE_BASE}.ts`);
const DIST_FILE = path.join(PROJECT_ROOT, 'dist/core/tools/builtin/custom', `${FILE_BASE}.js`);

// Same import shape meta.skill-creator's REQUIRED PATTERN template emits.
const GENERATED_STYLE_CODE = `
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('${TOOL_NAME}');

export const custom_hotdeploy_import_reproTool: ToolDefinition = {
  name: '${TOOL_NAME}',
  description: 'Test fixture: generated-style tool importing createLogger.',
  category: 'custom' as const,
  timeout: 5_000,
  parameters: {
    echo: { type: 'string', description: 'Value to echo back.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    logger.info({ session: ctx.sessionId }, '${TOOL_NAME} invoked');
    return { success: true, output: 'echo:' + String(params['echo'] ?? '') };
  },
};
`;

function makeCtx(): ToolContext {
  return {
    workingDir: process.cwd(),
    sessionId: 'test-session-hot-deploy-import',
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as ToolContext;
}

let savedGlobal: ToolRegistry | null;
let registry: ToolRegistry;

beforeAll(() => {
  savedGlobal = ToolRegistry.getGlobal();
  registry = new ToolRegistry();
  ToolRegistry.setGlobal(registry);
}, 120_000);

afterAll(() => {
  ToolRegistry['_global'] = savedGlobal;
  try { rmSync(SRC_FILE, { force: true }); } catch { /* ignore */ }
  try { rmSync(DIST_FILE, { force: true }); } catch { /* ignore */ }
});

describe('meta.hot-deploy — generated tool importing createLogger loads after compile', () => {
  it('compiles, imports, and registers a tool that imports shared/logger.js', async () => {
    const result = await hotDeployTool.execute(
      { skillName: TOOL_NAME, code: GENERATED_STYLE_CODE, overwrite: true },
      makeCtx(),
    );

    // The prod bug surfaced exactly here: "import failed ... Cannot find
    // module '.../dist/core/shared/logger.js'".
    expect(result.output).not.toContain('import failed');
    expect(result.output).not.toContain('Cannot find module');
    expect(result.success).toBe(true);
    expect(result.output).toContain(`Tool "${TOOL_NAME}" is now LIVE`);

    const deployed = registry.get(TOOL_NAME);
    expect(deployed).toBeDefined();

    // The deployed module's execute path runs the (bundled) real logger.
    const run = await deployed!.execute({ echo: 'hello' }, makeCtx());
    expect(run.success).toBe(true);
    expect(run.output).toBe('echo:hello');
  }, 120_000);
});
