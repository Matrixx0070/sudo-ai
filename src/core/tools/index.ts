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

// Phase 4: Zero-Coupling Tools
export { BaseTool, Tool } from './base-tool.js';
export type { ToolMetadata, ToolProfile } from './base-tool.js';
export { ToolDiscovery } from './tool-discovery.js';
export { SchemaPatcher } from './schema-patcher.js';
export type { PatchContext, PatchResult } from './schema-patcher.js';
export { ToolParallelism } from './tool-parallelism.js';
export type { ToolCallGroup, ParallelResult } from './tool-parallelism.js';

// Community-driven: Task Completion Verifier (fixes phantom completion)
export { CompletionVerifier } from './completion-verifier.js';
export type {
  CompletionVerification,
  VerificationCheck,
  VerificationSeverity,
  RetryStrategy,
  CompletionVerifierConfig,
} from './completion-verifier.js';

// Community-driven: Migration Toolkit (OpenClaw/Hermes → SUDO-AI)
export { MigrationToolkit } from './migration-toolkit.js';
export type {
  MigrationSource,
  MigrationResult,
  OpenClawConfig,
  HermesConfig,
  SudoAiConfigOutput,
  ComparisonEntry,
  MigrationConfig,
} from './migration-toolkit.js';
