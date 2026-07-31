/**
 * @file index.ts
 * @description PPTX toolkit — registers pptx tools into the ToolRegistry.
 *
 * Tools registered:
 *   pptx.create — Create a real .pptx PowerPoint deck (pptxgenjs, local/offline)
 */

import type { ToolRegistry } from '../../registry.js';
import { pptxCreateTool } from './tools/create.js';

export const PPTX_TOOLS = [
  pptxCreateTool,
] as const;

/**
 * Register all pptx tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerPptxTools(registry: ToolRegistry): void {
  for (const tool of PPTX_TOOLS) {
    registry.register(tool);
  }
}
