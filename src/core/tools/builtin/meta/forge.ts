import { ForgeOrchestrator, ForgeResult } from '../../../forge/forge-orchestrator.js';
import { forgeEnabled } from '../../../forge/forge-budget.js';

/**
 * The forgeTool exposes the SUDO FORGE orchestration as a callable
 * tool. It validates input parameters, constructs the orchestrator and
 * returns human‑friendly output along with detailed data for
 * downstream use. The timeout of ten minutes accommodates
 * long‑running builds and model interactions.
 */
export const forgeTool = {
  name: 'meta.forge',
  description:
    'SUDO FORGE — spawn a parallel team of specialized Grok models (architect, builders, reviewer, security, docs) to design, build, test and evolve production TypeScript code. Faster and smarter than any single-model approach.',
  category: 'meta' as const,
  timeout: 600_000,
  parameters: {
    task: { type: 'string', required: true, description: 'What to build' },
    outputDir: { type: 'string', required: false, description: 'Output directory (default: src/generated)' },
    evolve: { type: 'boolean', required: false, description: 'Auto-improve failing code (default: true)' },
  },
  async execute(
    params: Record<string, unknown>,
    ctx: any
  ): Promise<{ success: boolean; output: string; data?: unknown }> {
    try {
      if (!forgeEnabled()) {
        return { success: false, output: 'SUDO FORGE is disabled (SUDO_FORGE=0). Unset or set SUDO_FORGE=1 to enable the multi-model forge.' };
      }
      const task = params.task;
      if (typeof task !== 'string' || task.trim().length === 0) {
        return { success: false, output: 'The "task" parameter must be a non-empty string.' };
      }
      const outputDir = typeof params.outputDir === 'string' && params.outputDir.trim().length > 0
        ? params.outputDir
        : 'src/generated';
      const evolve = typeof params.evolve === 'boolean' ? params.evolve : true;
      const orchestrator = new ForgeOrchestrator();
      const result: ForgeResult = await orchestrator.forge({ description: task, outputDir, evolve });
      if (result.success) {
        return {
          success: true,
          output: `Forge completed successfully. Generated ${result.files.length} files in ${result.totalDurationMs}ms.`,
          data: result,
        };
      }
      return {
        success: false,
        output: 'Forge did not complete successfully.',
        data: result,
      };
    } catch (err: any) {
      return { success: false, output: `Error executing forge: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};