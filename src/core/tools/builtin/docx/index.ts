/**
 * @file index.ts
 * @description DOCX toolkit — registers all docx tools into the ToolRegistry.
 *
 * Tools registered:
 *   docx.create  — Create a .docx Word document with title and sections
 *   docx.inspect — Read structure/text/theme/media of an existing .docx (vendored Python)
 */

import type { ToolRegistry } from '../../registry.js';
import { docxCreateTool } from './tools/create.js';
import { docxInspectTool } from './tools/inspect.js';

export const DOCX_TOOLS = [
  docxCreateTool,
  docxInspectTool,
] as const;

/**
 * Register all docx tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerDocxTools(registry: ToolRegistry): void {
  for (const tool of DOCX_TOOLS) {
    registry.register(tool);
  }
}
