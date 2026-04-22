/**
 * Development toolkit — registers 5 dev tools into the ToolRegistry.
 *
 * Tools registered:
 *   dev.api-designer      — Generate OpenAPI 3.0 specs from natural language
 *   dev.database-designer — Design DB schemas and generate SQL migrations
 *   dev.ci-cd-setup       — Generate GitHub Actions workflow YAML
 *   dev.dependency-audit  — Run npm audit and parse vulnerability results
 *   dev.refactor          — Analyse code for patterns and produce refactoring plan
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

import { apiDesignerTool, databaseDesignerTool } from './tools/api-db-tools.js';
import { ciCdSetupTool, dependencyAuditTool, refactorTool } from './tools/cicd-audit-refactor-tools.js';

const logger = createLogger('dev-builtin');

// ---------------------------------------------------------------------------
// Tool roster
// ---------------------------------------------------------------------------

const DEV_TOOLS: ToolDefinition[] = [
  apiDesignerTool,
  databaseDesignerTool,
  ciCdSetupTool,
  dependencyAuditTool,
  refactorTool,
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all development tools with the given registry.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerDevTools(registry: ToolRegistry): void {
  logger.info({ count: DEV_TOOLS.length }, 'Registering dev tools');
  for (const tool of DEV_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: DEV_TOOLS.length }, 'Dev tools registered');
}

// Named re-exports
export { apiDesignerTool, databaseDesignerTool, ciCdSetupTool, dependencyAuditTool, refactorTool };

// Upgrade 58: GitHub Integration
export { createPR, listBranches, createBranch, getRepoInfo } from './github-integration.js';
export type { GitHubPR, GitHubRepo } from './github-integration.js';
