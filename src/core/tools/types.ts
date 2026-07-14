/**
 * Core type definitions for the SUDO-AI tool system.
 *
 * Every tool must implement {@link ToolDefinition}. Tool authors use
 * {@link ToolParam} to declare parameter schemas that are forwarded to the
 * LLM and validated at call time. Execution results are returned as
 * {@link ToolResult}, optionally carrying {@link ToolArtifact} metadata for
 * any files the tool touched.
 */

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/**
 * High-level grouping for tools.  Matches the directory layout under
 * `src/core/tools/builtin/`.
 */
export type ToolCategory =
  | 'coder'
  | 'system'
  | 'mcp'
  | 'browser'
  | 'knowledge'
  | 'business'
  | 'comms'
  | 'content'
  | 'superpowers'
  | 'media'
  | 'memory'
  | 'channel'
  | 'pipeline'
  | 'voice'
  | 'earning'
  | 'social'
  | 'research'
  | 'dev'
  | 'marketing'
  | 'finance'
  | 'data'
  | 'textproc'
  | 'pm'
  | 'personal'
  | 'legal'
  | 'meta'
  | 'document'
  | 'spreadsheet'
  | 'code'
  | 'github'
  | 'custom';

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

/**
 * Schema descriptor for a single tool parameter.
 * Mirrors a subset of JSON Schema so the registry can emit LLM-compatible
 * function definitions without a hard dependency on a schema library.
 */
export interface ToolParam {
  /** JSON Schema primitive type of the parameter. */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** Human-readable description sent to the LLM. */
  description: string;
  /** Whether the LLM must supply this parameter.  Defaults to false. */
  required?: boolean;
  /** Default value applied when the parameter is omitted. */
  default?: unknown;
  /** Allowed string values (rendered as an enum in the JSON Schema). */
  enum?: string[];
  /**
   * For `type: 'array'` — describes the schema of each element.
   */
  items?: ToolParam;
  /**
   * For `type: 'object'` — maps property names to their schemas.
   */
  properties?: Record<string, ToolParam>;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Full specification of a tool that can be registered, discovered, and
 * executed by the SUDO-AI tool system.
 */
export interface ToolDefinition {
  /**
   * Globally unique dot-namespaced identifier, e.g. `"coder.read-file"`.
   * Matches the pattern `<category>.<action>`.
   */
  name: string;
  /** LLM-facing description explaining what the tool does and when to use it. */
  description: string;
  /** Logical category the tool belongs to. */
  category: ToolCategory;
  /** Map of parameter name → schema descriptor. */
  parameters: Record<string, ToolParam>;
  /**
   * When `true` the runtime must obtain user confirmation before calling
   * `execute`.  Use for irreversible or dangerous operations.
   */
  requiresConfirmation?: boolean;
  /**
   * Safety classification for MCP loopback exposure.
   * 'readonly' tools may be exposed without an explicit allowlist.
   * 'destructive' tools require explicit listing in SUDO_MCP_EXPOSE_TOOLS.
   * Defaults to 'readonly' when absent.
   */
  safety?: 'readonly' | 'destructive';
  /**
   * Maximum wall-clock time in milliseconds before the call is aborted.
   * Defaults to 30 000 ms.
   */
  timeout?: number;
  /**
   * Perform the tool's action.
   *
   * @param params - Validated key→value map of caller-supplied arguments.
   * @param ctx    - Runtime context including session, cwd, config, and logger.
   * @returns A {@link ToolResult} describing the outcome.
   */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to every `execute` call.
 * Uses `unknown` for `config` and `logger` to avoid circular imports — callers
 * should cast to `SudoConfig` / `pino.Logger` as required.
 */
export interface ToolContext {
  /** Unique identifier of the owning agent session. */
  sessionId: string;
  /**
   * Caller identity for the turn that invoked this tool, resolved from the
   * channel access policy (Feature 1). `isOwner` is undefined when the turn's
   * identity wasn't recorded (e.g. an internal/autonomous turn). Tools that
   * gate owner-only capabilities read this instead of a side registry.
   */
  isOwner?: boolean;
  /** Channel the turn originated on (e.g. 'web', 'telegram'), when known. */
  channel?: string;
  /** Platform peer id of the caller, when known. */
  peerId?: string;
  /** Absolute path that file-system tools treat as the current directory. */
  workingDir: string;
  /** Full application configuration (cast to `SudoConfig` inside the tool). */
  config: unknown;
  /** Scoped pino logger instance (cast to `pino.Logger` inside the tool). */
  logger: unknown;
  /**
   * Abort signal forwarded from the registry's timeout controller.
   * Tools should honour this signal for any long-running I/O.
   */
  signal?: AbortSignal;
  /**
   * Sandbox policy for this session. When `enabled` is true, shell-exec
   * routes through the bwrap sandbox instead of a plain execFile call.
   * Type-only import: erased at compile time — safe to reference before
   * Builder A delivers src/core/sandbox/sandbox-types.ts.
   */
  sandboxPolicy?: import('../sandbox/sandbox-types.js').SandboxPolicy;
  /**
   * Absolute path to the provisioned per-session workspace directory.
   * Supplied by SandboxManager; falls back to workingDir when absent.
   */
  workspaceDir?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * File-system artifact produced or consumed by a tool execution.
 */
export interface ToolArtifact {
  /** Absolute or working-dir-relative path to the file. */
  path: string;
  /** What the tool did to the file. */
  action: 'created' | 'modified' | 'deleted' | 'read';
  /** File size in bytes after the action, if available. */
  size?: number;
}

/**
 * Outcome of a single tool execution.
 */
export interface ToolResult {
  /** `true` if the tool completed without error. */
  success: boolean;
  /**
   * Plain-text summary of the result, formatted for LLM consumption.
   * Even on failure this should contain a human-readable error description.
   */
  output: string;
  /** Optional structured payload for programmatic consumers. */
  data?: unknown;
  /** Zero or more file artifacts produced or touched during execution. */
  artifacts?: ToolArtifact[];
}

// ---------------------------------------------------------------------------
// Call request / result (used by the agent loop)
// ---------------------------------------------------------------------------

/**
 * A single tool invocation request emitted by the LLM.
 */
export interface ToolCallRequest {
  /** Opaque ID assigned by the LLM that must be echoed back in the result. */
  id: string;
  /** Name of the tool to invoke (must match {@link ToolDefinition.name}). */
  name: string;
  /** Argument map as decoded from the LLM's JSON payload. */
  arguments: Record<string, unknown>;
}

/**
 * OpenAI-compatible function-calling schema, as emitted by
 * `ToolRegistry.getSchemaForLLM` and consumed by the Vercel AI SDK
 * `tools` option. Native {@link ToolDefinition}s and MCP tools are
 * both mapped into this shape inside the registry.
 *
 * `parameters` is a JSON Schema object — kept as `Record<string,
 * unknown>` rather than a concrete schema type to avoid pinning a
 * JSON-Schema dialect at the type level (the registry emits Draft-07
 * shape, MCP servers may emit other dialects).
 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The execution result paired with its originating request ID.
 */
export interface ToolCallResult {
  /** Echoed from {@link ToolCallRequest.id}. */
  toolCallId: string;
  /** Name of the tool that was called. */
  name: string;
  /** Full execution result. */
  result: ToolResult;
  /** Wall-clock time in milliseconds for the entire execute call. */
  durationMs: number;
}
