/**
 * BaseTool abstract class and @Tool decorator for the SUDO-AI tool system.
 *
 * Zero-coupling tool pattern inspired by Hermes Agent's self-registering tools:
 *   1. Tools extend BaseTool instead of authoring raw ToolDefinition objects.
 *   2. The @Tool() decorator auto-registers with the global ToolRegistry at import time.
 *   3. Each tool declares cost, latency, and confirmation via ToolMetadata.
 *   4. Tools can be loaded/unloaded independently (zero coupling).
 */

import {
  type ToolDefinition,
  type ToolParam,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
} from './types.js';
import { ToolRegistry } from './registry.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('base-tool');

// ---------------------------------------------------------------------------
// Profile & Metadata types
// ---------------------------------------------------------------------------

/**
 * Tool profile determines the weight of capabilities a tool exposes.
 *
 * - 'minimal' — lightweight utility (e.g. string transform, hash).
 * - 'coding'  — code-aware tools (read, write, exec).
 * - 'full'    — heavy tools that may access the network, filesystem, or APIs.
 */
export type ToolProfile = 'minimal' | 'coding' | 'full';

/** Metadata attached via the @Tool() decorator. Used by planner/UI to reason about cost and safety. */
export interface ToolMetadata {
  /** Approximate cost per invocation. */
  costEstimate: 'free' | 'low' | 'medium' | 'high';
  /** Expected wall-clock latency bucket. */
  latencyEstimate: 'instant' | 'fast' | 'medium' | 'slow';
  /** Whether the runtime must prompt the user before executing. */
  requiresConfirmation: boolean;
  /** Capability profile — selects the tool's weight class. */
  profile: ToolProfile;
  /** If true, the tool is on a deprecation path. */
  deprecated?: boolean;
  /** Suggested replacement tool name when deprecated. */
  replacement?: string;
}

/** Default metadata applied when the decorator omits fields. */
const DEFAULT_METADATA: ToolMetadata = {
  costEstimate: 'free',
  latencyEstimate: 'instant',
  requiresConfirmation: false,
  profile: 'minimal',
};

// ---------------------------------------------------------------------------
// Lazy-registration queue
// ---------------------------------------------------------------------------

/** Queue for tools imported before the global ToolRegistry exists. Flushed on setGlobal(). */
const pendingRegistrations: BaseTool[] = [];

/** Flush all pending tool registrations into the given registry. */
function flushPending(registry: ToolRegistry): void {
  while (pendingRegistrations.length > 0) {
    const tool = pendingRegistrations.shift()!;
    const def = tool.toDefinition();
    registry.register(def);
    logger.info({ tool: def.name }, 'Lazy-registered pending tool');
  }
}

// Patch ToolRegistry.setGlobal to auto-flush pending registrations.
// This ensures tools imported before the registry existed still get
// registered the moment the global instance appears.
const originalSetGlobal = ToolRegistry.setGlobal.bind(ToolRegistry);
ToolRegistry.setGlobal = (instance: ToolRegistry): void => {
  originalSetGlobal(instance);
  flushPending(instance);
};

// ---------------------------------------------------------------------------
// @Tool decorator
// ---------------------------------------------------------------------------

/** Symbol key for attaching tool metadata to a class constructor for introspection. */
export const __toolClass = Symbol('__toolClass');

/** Metadata stored on decorated class constructors under the __toolClass symbol. */
export interface ToolClassMetadata {
  name: string;
  description: string;
  metadata: ToolMetadata;
}

/**
 * Class decorator that registers a BaseTool subclass with the global
 * ToolRegistry at import time.
 *
 * If no global registry exists yet, the tool is queued and registered
 * lazily when ToolRegistry.setGlobal() is called.
 *
 * @param name        - Dot-namespaced tool identifier (e.g. 'fs.read').
 * @param description - Human-readable description sent to the LLM.
 * @param metadata    - Optional partial ToolMetadata overrides.
 *
 * @example
 * ```typescript
 * @Tool('fs.read', 'Read a file from the filesystem', {
 *   costEstimate: 'free',
 *   latencyEstimate: 'fast',
 *   requiresConfirmation: false,
 *   profile: 'coding',
 * })
 * export class FileReadTool extends BaseTool {
 *   category: ToolCategory = 'coder';
 *   parameters = { path: { type: 'string', description: 'File path', required: true } };
 *   async execute(params, ctx) { ... }
 * }
 * ```
 */
export function Tool(
  name: string,
  description: string,
  metadata?: Partial<ToolMetadata>,
) {
  // Merge caller-supplied metadata with defaults.
  const mergedMeta: ToolMetadata = { ...DEFAULT_METADATA, ...metadata };

  return (ctor: Function): void => {
    // Attach introspection metadata to the class constructor.
    (ctor as unknown as Record<symbol, ToolClassMetadata>)[__toolClass] = {
      name,
      description,
      metadata: mergedMeta,
    };

    // Attempt immediate registration if the global registry is available.
    const globalRegistry = ToolRegistry.getGlobal();
    if (globalRegistry) {
      // We need an instance to call toDefinition(); construct via type assertion.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance = new (ctor as any)() as BaseTool;
      globalRegistry.register(instance.toDefinition());
      logger.info({ tool: name }, 'Auto-registered tool at import time');
    } else {
      // No global registry yet — queue for lazy registration.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pendingRegistrations.push(new (ctor as any)() as BaseTool);
      logger.debug({ tool: name }, 'Queued tool for lazy registration');
    }
  };
}

// ---------------------------------------------------------------------------
// BaseTool abstract class
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all SUDO-AI tools.
 *
 * Required: name, description, parameters, execute.
 * Optional: category (default 'custom'), metadata (set by @Tool() decorator).
 * Use toDefinition() to convert into the flat ToolDefinition interface.
 */
export abstract class BaseTool {
  // -----------------------------------------------------------------------
  // Abstract members — every subclass must provide these
  // -----------------------------------------------------------------------

  /** Globally unique dot-namespaced identifier, e.g. 'coder.read-file'. */
  abstract readonly name: string;

  /** LLM-facing description explaining what the tool does. */
  abstract readonly description: string;

  /** Map of parameter name to its {@link ToolParam} schema descriptor. */
  abstract readonly parameters: Record<string, ToolParam>;

  /** Execute the tool's action. Params are caller-supplied; context carries session info. */
  abstract execute(
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;

  // -----------------------------------------------------------------------
  // Overridable members — sensible defaults provided
  // -----------------------------------------------------------------------

  /** Logical category the tool belongs to.  Defaults to 'custom'. */
  category: ToolCategory = 'custom';

  /** Full metadata. Populated by @Tool() decorator, overridable in subclass. */
  metadata: ToolMetadata = { ...DEFAULT_METADATA };

  // -----------------------------------------------------------------------
  // Conversion — bridge to the existing ToolDefinition interface
  // -----------------------------------------------------------------------

  /** Convert this instance into the flat ToolDefinition format for ToolRegistry.register(). */
  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      category: this.category,
      parameters: this.parameters,
      requiresConfirmation: this.metadata.requiresConfirmation,
      execute: (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> =>
        this.execute(params, ctx),
    };
  }

  // -----------------------------------------------------------------------
  // Batch registration helper
  // -----------------------------------------------------------------------

  /**
   * Batch-register an array of BaseTool subclass constructors.
   * Useful for loading a whole category module at once.
   *
   * @example BaseTool.registerAll([FileReadTool, FileWriteTool], registry);
   */
  static registerAll(
    ctorList: Array<new () => BaseTool>,
    registry: ToolRegistry,
  ): void {
    for (const Ctor of ctorList) {
      const instance = new Ctor();
      registry.register(instance.toDefinition());
      logger.info({ tool: instance.name }, 'Batch-registered tool');
    }
  }
}