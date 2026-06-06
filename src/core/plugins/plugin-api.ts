/**
 * Plugin API — The typed public SDK for SUDO-AI plugin authors.
 *
 * This module provides the official API surface that plugins use to interact
 * with the SUDO-AI core system. Import these types and functions when building
 * a plugin.
 *
 * @module @sudo-ai/plugin-sdk
 */

import type {
  PluginCapability,
  PluginManifest,
  PluginContext,
  PluginModule,
  PluginLifecycle,
  PluginLifecycleHooks,
  PluginState,
  PluginEntry,
  PluginHookEvent,
  PluginHookHandler,
  PluginHookSubscription,
  PluginErrorCode,
  PluginErrorData,
} from './types.js';

export type {
  PluginCapability,
  PluginManifest,
  PluginContext,
  PluginModule,
  PluginLifecycle,
  PluginLifecycleHooks,
  PluginState,
  PluginEntry,
  PluginHookEvent,
  PluginHookHandler,
  PluginHookSubscription,
  PluginErrorCode,
  PluginErrorData,
};

// ---------------------------------------------------------------------------
// Tool Registration Types
// ---------------------------------------------------------------------------

/**
 * Tool definition that a plugin can register.
 * Compatible with SUDO-AI's tool registry.
 */
export interface ToolDefinition {
  /** Unique tool identifier, e.g. "youtube.search" */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the tool's output (optional) */
  outputSchema?: Record<string, unknown>;
  /** The actual tool function implementation */
  execute: (input: unknown) => Promise<unknown>;
  /** Optional: categories this tool belongs to */
  categories?: string[];
}

// ---------------------------------------------------------------------------
// Channel Registration Types
// ---------------------------------------------------------------------------

/**
 * Channel definition for real-time communication.
 */
export interface ChannelDefinition {
  /** Unique channel identifier, e.g. "slack.incoming" */
  id: string;
  /** Human-readable channel name */
  name: string;
  /** Channel type: "websocket" | "sse" | "polling" | "custom" */
  type: string;
  /** Connection handler */
  onConnect: (client: unknown) => Promise<void>;
  /** Message handler */
  onMessage: (client: unknown, message: unknown) => Promise<void>;
  /** Disconnect handler */
  onDisconnect: (client: unknown) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider Registration Types
// ---------------------------------------------------------------------------

/**
 * LLM Provider definition.
 */
export interface ProviderDefinition {
  /** Unique provider identifier, e.g. "openai-gpt4" */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** Provider type for routing */
  type: string;
  /** Model capabilities metadata */
  capabilities: {
    contextWindow?: number;
    supportsVision?: boolean;
    supportsFunctionCalling?: boolean;
    maxOutputTokens?: number;
  };
  /** Completion handler */
  complete: (prompt: unknown, options?: unknown) => Promise<unknown>;
  /** Optional: streaming completion handler */
  streamComplete?: (prompt: unknown, options?: unknown) => AsyncIterable<unknown>;
}

// ---------------------------------------------------------------------------
// Skill Registration Types
// ---------------------------------------------------------------------------

/**
 * Skill definition for agent capabilities.
 */
export interface SkillDefinition {
  /** Unique skill identifier, e.g. "code.review" */
  id: string;
  /** Human-readable skill name */
  name: string;
  /** Description of what this skill does */
  description: string;
  /** Skill category */
  category: string;
  /** The skill implementation function */
  execute: (context: unknown, input: unknown) => Promise<unknown>;
  /** Optional: preconditions for skill availability */
  preconditions?: () => boolean;
}

// ---------------------------------------------------------------------------
// Plugin Builder Helpers
// ---------------------------------------------------------------------------

/**
 * Create a plugin manifest programmatically.
 * Useful for plugins that build their manifest at runtime.
 */
export function createManifest(options: {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  entryPoint?: string;
  capabilities: PluginCapability[];
  config?: Record<string, { type: string; description: string; required?: boolean; default?: unknown }>;
}): PluginManifest {
  return {
    id: options.id,
    name: options.name,
    version: options.version,
    description: options.description,
    author: options.author,
    entryPoint: options.entryPoint ?? 'dist/index.js',
    capabilities: options.capabilities,
    config: options.config,
  };
}

// ---------------------------------------------------------------------------
// Plugin Base Class (optional helper)
// ---------------------------------------------------------------------------

/**
 * Base class for plugins that prefer OOP style.
 * Extend this class and override lifecycle methods.
 *
 * @example
 * class MyPlugin extends PluginBase {
 *   async activate(ctx: PluginContext): Promise<void> {
 *     ctx.registerTool({ name: 'my-tool', ... });
 *   }
 * }
 */
export abstract class PluginBase implements PluginLifecycleHooks {
  /** Called when plugin is installed (optional) */
  async install?(ctx: PluginContext): Promise<void> {
    // Override in subclass
  }

  /** Called when plugin is activated — register tools/channels/providers/skills here */
  async activate?(ctx: PluginContext): Promise<void> {
    // Override in subclass
  }

  /** Called when plugin is deactivated — cleanup here */
  async deactivate?(): Promise<void> {
    // Override in subclass
  }

  /** Called when plugin is uninstalled — full cleanup */
  async uninstall?(): Promise<void> {
    // Override in subclass
  }
}

// ---------------------------------------------------------------------------
// Re-export PluginManager for advanced use (optional)
// ---------------------------------------------------------------------------

export { PluginManager } from './manager.js';
export { PluginLoader } from './loader.js';
export { loadPluginsJson, savePluginsJson, PLUGINS_JSON } from './persistence.js';
export type { PersistedEntry, PluginsJson } from './persistence.js';

// ---------------------------------------------------------------------------
// Marketplace types (for plugin discovery)
// ---------------------------------------------------------------------------

export type { MarketplacePlugin } from './marketplace.js';
export {
  registerPlugin,
  installPlugin,
  uninstallPlugin,
  getInstalled,
  getAvailable,
  searchPlugins,
  listAllPlugins,
} from './marketplace.js';

// ---------------------------------------------------------------------------
// MCP Server types (for MCP integration)
// ---------------------------------------------------------------------------

export type { McpServer, McpTrustTier, McpServerStatus } from './mcp-registry.js';
export {
  registerMcpServer,
  removeMcpServer,
  listMcpServers,
  getMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  getConnectedServers,
  updateServerStatus,
  setServerTrustTier,
  setServerError,
  updateServerTools,
  getServerTools,
  getEnabledServerTools,
  setToolEnabled,
  getServerStatusSummary,
} from './mcp-registry.js';
