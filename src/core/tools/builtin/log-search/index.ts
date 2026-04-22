/**
 * log-search tool registration.
 * Auto-discovered by src/core/tools/loader.ts at startup.
 */

import { logSearchTool } from './search.js';

export function registerLogSearchTools(registry: {
  register(tool: import('../../types.js').ToolDefinition): void;
}): void {
  registry.register(logSearchTool);
}
