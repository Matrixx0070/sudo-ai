/**
 * Code execution toolkit — registers sandboxed code execution tools.
 *
 * Tools provided:
 *   code.js-exec     — Node.js vm.createContext + worker_threads sandbox
 *   code.python-exec — Docker python:3.12-slim isolated container
 *
 * The tool loader auto-discovers this category via the registerCodeTools export.
 */

import type { ToolRegistry } from '../../registry.js';
import { jsExecTool } from './tools/js-exec.js';
import { pythonExecTool } from './tools/python-exec.js';

/** All code execution tools in a stable order. */
export const CODE_TOOLS = [
  jsExecTool,
  pythonExecTool,
] as const;

/**
 * Register all code execution tools into the provided registry.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerCodeTools(registry: ToolRegistry): void {
  registry.registerMany([...CODE_TOOLS]);
}

// Named re-exports for consumers that import individual tools.
export { jsExecTool, pythonExecTool };
export { killSession, killAllSessions, getStats, stopSweeper } from './session-kernels.js';
