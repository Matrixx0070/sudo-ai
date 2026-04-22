/**
 * Public API surface for the SUDO-AI tool system.
 *
 * Import from this barrel rather than from individual files so that internal
 * module boundaries can be refactored without breaking consumers.
 *
 * @example
 * ```typescript
 * import { ToolRegistry, loadBuiltinTools, type ToolDefinition } from './tools/index.js';
 * ```
 */

// Types — interfaces and enums used across the tool system.
export type {
  ToolCategory,
  ToolParam,
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolArtifact,
  ToolCallRequest,
  ToolCallResult,
} from './types.js';

// Registry — primary runtime class.
export { ToolRegistry } from './registry.js';

// Loader — auto-discovery of built-in tool modules.
export { loadBuiltinTools } from './loader.js';
