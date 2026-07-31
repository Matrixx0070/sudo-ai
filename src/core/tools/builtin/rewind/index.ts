/**
 * @file index.ts
 * @description Rewind toolkit — undo the file changes a tool made.
 */

import type { ToolRegistry } from '../../registry.js';
import { rewindListTool, rewindRestoreTool } from './tools/rewind-tools.js';

export const REWIND_TOOLS = [rewindListTool, rewindRestoreTool] as const;

export function registerRewindTools(registry: ToolRegistry): void {
  for (const tool of REWIND_TOOLS) registry.register(tool);
}
