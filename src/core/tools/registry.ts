/**
 * ToolRegistry — central store for all registered SUDO-AI tools.
 *
 * Responsibilities:
 *  - Register / unregister {@link ToolDefinition} instances.
 *  - Enable / disable individual tools at runtime.
 *  - Expose LLM-compatible JSON Schema function definitions.
 *  - Execute tools by name with built-in timeout and abort support.
 *  - Execute {@link ToolCallRequest} objects emitted by the agent loop.
 */

import {
  type ToolDefinition,
  type ToolCategory,
  type ToolContext,
  type ToolResult,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolSchema,
} from './types.js';
import { createLogger } from '../shared/logger.js';
import { ToolError } from '../shared/errors.js';
import type { MCPAdapter, MCPAdapterLike, MCPToolDef } from './mcp-adapter.js';
import { isReadOnlyTool } from '../agent/plan-mode-gate.js';
import { NativeToolCorrection } from './native-tool-correction.js';

const logger = createLogger('tool-registry');

/**
 * Coerce a tool-call `arguments` value into a plain object. The LLM/JSON
 * boundary (and weak models that double-encode) can deliver `arguments` as a
 * JSON *string*, an array, or null — `?? {}` only catches null/undefined, so a
 * string would otherwise reach the tool as a string and break `params.x`
 * access. A JSON string is parsed; anything not a plain object falls back to {}.
 */
function normalizeToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON — fall through to {} */
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal JSON Schema `properties` entry from a {@link ToolParam}.
 * Nested `items` and `properties` are intentionally left as-is for now;
 * full recursive expansion can be added when nested schemas are needed.
 */
/**
 * Coerce string-typed primitive arguments to their declared types per the
 * tool's own parameter declarations, RECURSIVELY through declared `items`
 * (arrays) and `properties` (objects) up to {@link MAX_COERCE_DEPTH} — a
 * model emitting operations:[{width:"300"}] is the same defect one level
 * down (live victim: media.image-edit-advanced, sharp rejects string
 * widths). Booleans: only the exact strings "true"/"false" on a declared
 * type:'boolean' member convert. Numbers: only a trimmed string that parses
 * to a FINITE number on a declared type:'number' member converts ("500",
 * "-1.5", "2e3"); anything else ("", "5px", "NaN", "Infinity") passes
 * through untouched for the tool's own validation to reject. Undeclared
 * members are never touched. Returns the original object (and reuses
 * original nested arrays/objects) when nothing needs coercion. Tools
 * carrying a raw JSON `inputSchema` instead of `parameters` (MCP-style)
 * are left alone.
 */
const MAX_COERCE_DEPTH = 4;

type ParamSpec = ToolDefinition['parameters'][string];

function coerceValue(spec: ParamSpec, v: unknown, depth: number): { changed: boolean; value: unknown } {
  if (depth >= MAX_COERCE_DEPTH) return { changed: false, value: v };
  if (typeof v === 'string') {
    if (spec.type === 'boolean' && (v === 'true' || v === 'false')) {
      return { changed: true, value: v === 'true' };
    }
    if (spec.type === 'number') {
      const trimmed = v.trim();
      if (trimmed !== '') {
        const n = Number(trimmed);
        if (Number.isFinite(n)) return { changed: true, value: n };
      }
    }
    return { changed: false, value: v };
  }
  if (spec.type === 'array' && spec.items && Array.isArray(v)) {
    let changed = false;
    const mapped = v.map((el) => {
      const r = coerceValue(spec.items!, el, depth + 1);
      changed = changed || r.changed;
      return r.value;
    });
    return changed ? { changed: true, value: mapped } : { changed: false, value: v };
  }
  if (spec.type === 'object' && spec.properties && v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [k, propSpec] of Object.entries(spec.properties)) {
      if (!(k in rec)) continue;
      const r = coerceValue(propSpec, rec[k], depth + 1);
      if (r.changed) {
        out ??= { ...rec };
        out[k] = r.value;
      }
    }
    return out ? { changed: true, value: out } : { changed: false, value: v };
  }
  return { changed: false, value: v };
}

export function coerceDeclaredPrimitives(
  tool: Pick<ToolDefinition, 'parameters'>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [key, spec] of Object.entries(tool.parameters ?? {})) {
    if (!spec || !(key in params)) continue;
    const r = coerceValue(spec, params[key], 0);
    if (r.changed) {
      out ??= { ...params };
      out[key] = r.value;
    }
  }
  return out ?? params;
}

function paramToJsonSchema(param: ToolDefinition['parameters'][string]): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: param.type,
    description: param.description,
  };
  if (param.enum) schema['enum'] = param.enum;
  if (param.default !== undefined) schema['default'] = param.default;
  if (param.type === 'array' && param.items) {
    schema['items'] = paramToJsonSchema(param.items);
  }
  if (param.type === 'object' && param.properties) {
    const props = Object.entries(param.properties);
    schema['properties'] = Object.fromEntries(
      props.map(([k, v]) => [k, paramToJsonSchema(v)]),
    );
    // Mark required sub-properties for nested objects.
    const requiredSub = props.filter(([, v]) => v.required === true).map(([k]) => k);
    if (requiredSub.length > 0) schema['required'] = requiredSub;
    // Prevent LLMs from hallucinating extra fields.
    schema['additionalProperties'] = false;
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Central registry for all SUDO-AI tools. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly disabled = new Set<string>();

  /** MCP adapters keyed by serverId. */
  private readonly mcpAdapters = new Map<string, MCPAdapter | MCPAdapterLike>();
  /** Cached MCP tool definitions keyed by their prefixed name. */
  private readonly mcpTools = new Map<string, MCPToolDef>();
  /** Reverse index — tool name → skill name. Null until setSkillIndex() called. */
  private _skillIndex: Map<string, string> | null = null;

  /** Plan-mode gate (gap #18). Null until setPlanModeGate() called. */
  private _planModeGate: import('../agent/plan-mode-gate.js').PlanModeGate | null = null;

  /** Lazily-built native-tool fallback (gap #7), used only when SUDO_NATIVE_TOOL_CORRECTION_FALLBACK=1. */
  private _nativeCorrection: NativeToolCorrection | null = null;

  /**
   * Register-time observers, invoked AFTER a tool is stored (see register()).
   * Deliberately generic — the registry knows nothing about tool routing; the
   * caller (cli.ts) owns any coverage logic, keeping registry → agent imports
   * out of this module.
   */
  private readonly _registerObservers: Array<
    (tool: { name: string; category?: string | null }) => void
  > = [];

  /**
   * Subscribe to tool registrations. The callback fires after every successful
   * `register()` (including last-wins re-registers of a divergent definition;
   * NOT for same-reference no-op re-registers), at ANY time in the process
   * lifetime — boot, post-boot, lazy callbacks, plugin activate(), runtime
   * self-registration via the global singleton.
   *
   * A throwing observer can never break registration: each callback is
   * try/catch-isolated inside register().
   *
   * @param cb - Called with the registered tool's name and declared category.
   */
  onRegister(cb: (tool: { name: string; category?: string | null }) => void): void {
    if (typeof cb !== 'function') return;
    this._registerObservers.push(cb);
  }

  // -------------------------------------------------------------------------
  // Global singleton — allows tools to self-register at runtime
  // -------------------------------------------------------------------------

  private static _global: ToolRegistry | null = null;

  /** Store the live registry so tools can access it without constructor injection. */
  static setGlobal(instance: ToolRegistry): void {
    ToolRegistry._global = instance;
  }

  /** Retrieve the live registry. Returns null if not yet initialised. */
  static getGlobal(): ToolRegistry | null {
    return ToolRegistry._global;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a single tool.
   * Overwrites any existing registration with the same name, emitting a warning.
   *
   * @param tool - The {@link ToolDefinition} to register.
   */
  register(tool: ToolDefinition): void {
    if (!tool?.name || typeof tool.name !== 'string') {
      throw new ToolError('Cannot register tool with empty name', 'tool_invalid_definition');
    }
    if (typeof tool.execute !== 'function') {
      throw new ToolError(
        `Tool "${tool.name}" must have an execute function`,
        'tool_invalid_definition',
        { name: tool.name },
      );
    }
    if (this.tools.has(tool.name)) {
      // Same-reference re-register is a true no-op. A tool legitimately arrives
      // via more than one registration path — e.g. the superpowers built-in
      // discovery bridge (builtin/superpowers) AND the explicit
      // registerSuperpowers() call in cli.ts; plan-mode tools via the builtin
      // loader AND cli.ts — but every such path imports the SAME ToolDefinition
      // object (an ES-module singleton). The registry already maps the name to
      // that exact object, so re-setting it changes nothing; skip it so the
      // registry is idempotent-by-design for these duplicates and stops emitting
      // redundant register churn. Only a genuinely DIVERGENT re-register
      // (different object, same name) falls through to last-wins below.
      if (this.tools.get(tool.name) === tool) return;
      // Different definition, same name: keep prior last-wins behavior, debug
      // (not warn — benign, e.g. core + plugin sets can overlap).
      logger.debug({ tool: tool.name }, 'tool re-registered (overwriting prior definition)');
    }
    this.tools.set(tool.name, tool);
    logger.info({ tool: tool.name, category: tool.category }, 'Tool registered');

    // Notify observers AFTER the tool is stored. Isolated per-callback: an
    // observer throwing must never break (or roll back) a registration.
    for (const cb of this._registerObservers) {
      try {
        cb({ name: tool.name, category: tool.category });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug({ tool: tool.name, err: msg }, 'register observer threw — ignored');
      }
    }
  }

  /**
   * Register multiple tools in one call.
   *
   * @param tools - Array of {@link ToolDefinition} instances.
   */
  registerMany(tools: ToolDefinition[]): void {
    if (!Array.isArray(tools)) {
      throw new ToolError('registerMany: argument must be an array', 'tool_invalid_definition');
    }
    for (const tool of tools) this.register(tool);
  }

  /**
   * Register an MCP adapter so its tools are available via `execute()`.
   *
   * Call `adapter.listTools()` BEFORE this method to populate the adapter's
   * internal tool cache.  This method stores the adapter reference and indexes
   * all tools returned by `getCachedTools()` into `mcpTools`.
   *
   * Tool names are automatically prefixed as `mcp__<serverId>__<toolName>`.
   *
   * @param adapter  - Connected MCPAdapter instance.
   * @param serverId - Identifier that matches `adapter.serverId`.
   */
  registerMCPSource(adapter: MCPAdapter | MCPAdapterLike, serverId: string): void {
    if (!adapter || typeof adapter.serverId !== 'string') {
      throw new ToolError(
        'registerMCPSource: adapter must be a valid MCPAdapter instance',
        'tool_invalid_definition',
      );
    }
    if (!serverId) {
      throw new ToolError('registerMCPSource: serverId must be non-empty', 'tool_invalid_definition');
    }

    this.mcpAdapters.set(serverId, adapter);

    const tools = adapter.getCachedTools();
    for (const tool of tools) {
      this.mcpTools.set(tool.name, tool);
    }

    logger.info(
      { serverId, toolCount: tools.length },
      'MCP source registered',
    );
  }

  /**
   * Remove a tool from the registry entirely.
   * Also clears any disabled state for the tool.
   *
   * @param name - Tool name to remove.
   */
  unregister(name: string): void {
    this.tools.delete(name);
    this.disabled.delete(name);
    logger.info({ tool: name }, 'Tool unregistered');
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /**
   * Retrieve a tool definition by name.
   *
   * @param name - Dot-namespaced tool name.
   * @returns The {@link ToolDefinition} or `undefined` if not found.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Return all registered tools whose category matches.
   *
   * @param category - The {@link ToolCategory} to filter by.
   * @returns Array of matching {@link ToolDefinition} instances.
   */
  getByCategory(category: ToolCategory): ToolDefinition[] {
    return [...this.tools.values()].filter((t) => t.category === category);
  }

  /**
   * Load the skill-to-tool reverse index into the registry.
   *
   * Kill-switch: set SUDO_SKILL_INDEX_DISABLE=1 to prevent index load without
   * a process reload. When disabled, skillIdForTool() continues to return null
   * (identical to the pre-index behavior).
   *
   * @param index - Map from tool name → skill name (unambiguous entries only).
   */
  setSkillIndex(index: Map<string, string>): void {
    if (process.env['SUDO_SKILL_INDEX_DISABLE'] === '1') {
      logger.debug('setSkillIndex: SUDO_SKILL_INDEX_DISABLE — index not loaded');
      return;
    }
    this._skillIndex = index;
    logger.info({ toolCount: index.size }, 'skillToolIndex loaded into ToolRegistry');
  }

  /**
   * Return the skill name that unambiguously claims this tool via its
   * allowed-tools frontmatter list. Returns null when:
   *   - no index has been loaded
   *   - the tool is claimed by multiple skills (ambiguous — tie-breaker: null)
   *   - the tool is not claimed by any skill
   *
   * @param name - Tool name (e.g. "comms.gmail-send")
   * @returns Skill name string or null
   */
  skillIdForTool(name: string): string | null {
    if (!name) return null;
    return this._skillIndex?.get(name) ?? null;
  }

  /**
   * Surface a registered tool's `requiresConfirmation` field for the loop
   * gate at `agent/loop-helpers.ts:675` (gap #20 verifier BLOCKER —
   * previously this method did not exist, so EVERY `requiresConfirmation:
   * true` tool was silently executed without prompting; the duck-typed
   * `toolRegistry.requiresConfirmation?.(name)` invocation short-circuited
   * to undefined). Returns false for unknown / disabled tools.
   */
  requiresConfirmation(name: string): boolean {
    if (!name) return false;
    const tool = this.tools.get(name);
    if (!tool) return false;
    if (this.disabled.has(name)) return false;
    return tool.requiresConfirmation === true;
  }

  /**
   * Attach the plan-mode gate (gap #18). When the gate is set AND
   * `gate.isActive()` returns true at execute() time, destructive tool
   * calls are rejected with a `plan_mode_blocked` ToolError; read-only
   * tools (per `isReadOnlyTool`) pass through. Passing null detaches.
   */
  setPlanModeGate(gate: import('../agent/plan-mode-gate.js').PlanModeGate | null): void {
    this._planModeGate = gate;
    logger.info({ attached: gate !== null }, 'plan-mode gate updated');
  }

  /**
   * Return every registered tool, enabled or disabled.
   *
   * @returns Snapshot array of all {@link ToolDefinition} instances.
   */
  listAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Return only tools that are currently enabled.
   *
   * @returns Snapshot array of enabled {@link ToolDefinition} instances.
   */
  listEnabled(): ToolDefinition[] {
    return [...this.tools.values()].filter((t) => !this.disabled.has(t.name));
  }

  // -------------------------------------------------------------------------
  // Enable / disable
  // -------------------------------------------------------------------------

  /**
   * Prevent a tool from being executed.
   * The tool remains in the registry and can be re-enabled at any time.
   *
   * @param name - Tool name to disable.
   */
  disable(name: string): void {
    if (!this.tools.has(name)) {
      logger.warn({ tool: name }, 'disable called on unregistered tool');
    }
    this.disabled.add(name);
    logger.info({ tool: name }, 'Tool disabled');
  }

  /**
   * Allow a previously disabled tool to be executed again.
   *
   * @param name - Tool name to enable.
   */
  enable(name: string): void {
    this.disabled.delete(name);
    logger.info({ tool: name }, 'Tool enabled');
  }

  /**
   * Check whether a tool is registered and currently enabled.
   *
   * @param name - Tool name to check.
   * @returns `true` if the tool exists and is not disabled.
   */
  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabled.has(name);
  }

  // -------------------------------------------------------------------------
  // LLM schema export
  // -------------------------------------------------------------------------

  /**
   * Build an array of OpenAI-compatible function-calling schemas for all
   * currently enabled tools.  Safe to pass directly to Vercel AI SDK's
   * `tools` option.
   *
   * @returns Array of `{ type: 'function', function: { name, description, parameters } }` objects.
   */
  getSchemaForLLM(): ToolSchema[] {
    const nativeSchemas = this.listEnabled().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([key, param]) => [
              key,
              paramToJsonSchema(param),
            ]),
          ),
          required: Object.entries(tool.parameters)
            .filter(([, p]) => p.required === true)
            .map(([k]) => k),
          additionalProperties: false,
        },
      },
    }));

    // Merge MCP tool schemas alongside native tools.
    const mcpSchemas = [...this.mcpTools.values()].map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    return [...nativeSchemas, ...mcpSchemas];
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a registered tool by name.
   *
   * Applies the tool's configured timeout (default 30 000 ms) via an
   * {@link AbortController} that is merged into the {@link ToolContext}.
   * If the caller already supplied a `signal`, the internal controller aborts
   * when either signal fires.
   *
   * @param name   - Dot-namespaced tool name.
   * @param params - Argument map to pass to the tool's `execute` function.
   * @param ctx    - Caller-supplied {@link ToolContext}.
   * @returns The {@link ToolResult} produced by the tool.
   * @throws {ToolError} When the tool is not found, disabled, or times out.
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    // Route MCP tools (name starts with "mcp__") to the appropriate adapter.
    if (name.startsWith('mcp__')) {
      const result = await this._executeMCPTool(name, params);
      return this._maybeCorrectMcpFailure(name, params, ctx, result);
    }

    let tool = this.tools.get(name);
    // Ollama compatibility: Ollama strips dotted prefixes from tool names
    // (e.g. "system.exec" → "exec"). Try suffix matching when exact lookup fails.
    if (!tool && !name.includes('.')) {
      const suffixMatches: string[] = [];
      for (const registeredName of this.tools.keys()) {
        if (registeredName.endsWith(`.${name}`)) {
          suffixMatches.push(registeredName);
        }
      }
      if (suffixMatches.length === 1) {
        tool = this.tools.get(suffixMatches[0]!)!;
        logger.warn({ requested: name, resolved: tool.name }, 'Ollama stripped tool prefix — resolved via suffix match');
      } else if (suffixMatches.length > 1) {
        // Ambiguous: several registered tools share this suffix. Guessing the
        // first would silently run the wrong tool against the caller's args.
        logger.warn(
          { requested: name, candidates: suffixMatches },
          'Ollama stripped tool prefix — ambiguous suffix, refusing to guess',
        );
        throw new ToolError(
          `Ambiguous tool name "${name}" — candidates: ${suffixMatches.join(', ')}. Use the fully-qualified name.`,
          'tool_ambiguous',
          { name, candidates: suffixMatches },
        );
      }
    }
    if (!tool) {
      logger.error({ tool: name }, 'Tool not found');
      throw new ToolError(`Tool not found: ${name}`, 'tool_not_found', { name });
    }
    // Check the RESOLVED canonical name, not the bare caller-supplied `name`:
    // an Ollama-stripped "exec" resolves to "system.exec", and disabling
    // "system.exec" must still block it.
    if (this.disabled.has(tool.name)) {
      logger.warn({ tool: tool.name, requested: name }, 'Attempt to execute disabled tool');
      throw new ToolError(`Tool is disabled: ${tool.name}`, 'tool_disabled', { name: tool.name });
    }

    // Plan-mode gate (gap #18). When a plan is being drafted or awaiting
    // approval, only read-only tools may run. The plan-mode enter / exit
    // primitives are in ALWAYS_ALLOWED so the agent can still surface its
    // plan and exit the gate.
    if (this._planModeGate?.isActive()) {
      if (!isReadOnlyTool(name, tool)) {
        const stateLabel = this._planModeGate.getStateLabel();
        logger.warn({ tool: name, state: stateLabel }, 'plan-mode gate blocked destructive tool');
        throw new ToolError(
          `Plan mode active (${stateLabel}) — destructive tool '${name}' is blocked until the plan is approved`,
          'tool_plan_mode_blocked',
          { name, state: stateLabel },
        );
      }
    }

    // Models sometimes emit declared-primitive arguments as STRINGS. Observed
    // twice: "false" on a declared boolean forced skill.install into dryRun
    // (string is truthy), and "500" on a declared number passed finance
    // validation ("500" <= 0 coerces) then persisted into the ledger, breaking
    // every later balance call (`"0500".toFixed` throws). Coerce strictly
    // parseable strings on declared boolean/number params, nothing else.
    params = coerceDeclaredPrimitives(tool, params);

    const timeout = tool.timeout ?? 30_000;
    const controller = new AbortController();

    // Honour an upstream abort signal in addition to our timeout.
    const upstreamSignal = ctx.signal;
    const onUpstreamAbort = (): void => controller.abort();
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        throw new ToolError(`Tool aborted before execution: ${name}`, 'tool_aborted', { name });
      }
      upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true });
    }

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const toolCtx: ToolContext = { ...ctx, signal: controller.signal };

    try {
      logger.debug({ tool: name, params }, 'Executing tool');
      const start = Date.now();
      const result = await tool.execute(params, toolCtx);
      const durationMs = Date.now() - start;
      logger.info(
        { tool: name, success: result.success, durationMs },
        'Tool execution completed',
      );
      return result;
    } catch (error) {
      // Distinguish OUR timeout from an upstream-signal abort: only the timer
      // sets `timedOut`. Reporting an upstream cancel as `tool_timeout` (with a
      // bogus elapsed time) misleads callers that branch on the error code.
      if (timedOut) {
        logger.error({ tool: name, timeout }, 'Tool execution timed out');
        throw new ToolError(
          `Tool timed out after ${timeout}ms: ${name}`,
          'tool_timeout',
          { name, timeout },
        );
      }
      if (controller.signal.aborted) {
        logger.warn({ tool: name }, 'Tool execution aborted by upstream signal');
        throw new ToolError(`Tool aborted: ${name}`, 'tool_aborted', { name });
      }
      logger.error({ tool: name, error }, 'Tool execution threw an error');
      throw error;
    } finally {
      clearTimeout(timer);
      if (upstreamSignal) {
        upstreamSignal.removeEventListener('abort', onUpstreamAbort);
      }
    }
  }

  /**
   * Execute a {@link ToolCallRequest} emitted by the agent loop and wrap the
   * result in a {@link ToolCallResult}, including the LLM-assigned call ID.
   *
   * @param call - The tool call request from the LLM.
   * @param ctx  - Caller-supplied {@link ToolContext}.
   * @returns A {@link ToolCallResult} ready to pass back to the model.
   */
  async executeCall(call: ToolCallRequest, ctx: ToolContext): Promise<ToolCallResult> {
    if (!call?.id || !call?.name) {
      throw new ToolError('executeCall: call must have id and name', 'tool_invalid_call');
    }
    const start = Date.now();
    const result = await this.execute(call.name, normalizeToolArgs(call.arguments), ctx);
    return {
      toolCallId: call.id,
      name: call.name,
      result,
      durationMs: Date.now() - start,
    };
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Total number of registered tools (enabled and disabled). */
  get size(): number {
    return this.tools.size;
  }

  /** Number of currently enabled tools. */
  get enabledSize(): number {
    return this.tools.size - this.disabled.size;
  }

  /** Total number of MCP tools currently registered. */
  get mcpToolSize(): number {
    return this.mcpTools.size;
  }

  // -------------------------------------------------------------------------
  // Private: MCP routing
  // -------------------------------------------------------------------------

  /**
   * Route execution of an `mcp__` prefixed tool to the correct MCPAdapter.
   *
   * Name format: `mcp__<serverId>__<toolName>`
   *
   * @throws {ToolError} when the adapter is not found.
   */
  private async _executeMCPTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const mcpDef = this.mcpTools.get(name);
    if (!mcpDef) {
      logger.error({ tool: name }, 'MCP tool not found in registry');
      throw new ToolError(`MCP tool not found: ${name}`, 'tool_not_found', { name });
    }

    const adapter = this.mcpAdapters.get(mcpDef.serverId);
    if (!adapter) {
      logger.error({ tool: name, serverId: mcpDef.serverId }, 'MCP adapter not found for tool');
      throw new ToolError(
        `MCP adapter not registered for server: ${mcpDef.serverId}`,
        'tool_not_found',
        { name, serverId: mcpDef.serverId },
      );
    }

    logger.debug({ tool: name, serverId: mcpDef.serverId }, 'Routing to MCP adapter');

    try {
      const start = Date.now();
      const { content } = await adapter.callTool(name, args);
      const durationMs = Date.now() - start;
      logger.info({ tool: name, durationMs }, 'MCP tool executed');
      return { success: true, output: content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ tool: name, err: msg }, 'MCP tool execution failed');
      return { success: false, output: msg };
    }
  }

  /**
   * When an MCP tool call fails, optionally auto-correct to a native SUDO-AI
   * equivalent and re-dispatch (gap #7). Opt-in via
   * SUDO_NATIVE_TOOL_CORRECTION_FALLBACK=1 (default OFF → returns the original
   * result unchanged, byte-identical). Fail-open: any error in the correction
   * path returns the original MCP failure.
   */
  private async _maybeCorrectMcpFailure(
    mcpName: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (result.success) return result;
    if (process.env['SUDO_NATIVE_TOOL_CORRECTION_FALLBACK'] !== '1') return result;
    try {
      if (!this._nativeCorrection) this._nativeCorrection = new NativeToolCorrection();
      // mcp__<serverId>__<toolName> → bare <toolName> (the mappings use bare names).
      const bareTool = mcpName.split('__').slice(2).join('__');
      if (!bareTool || !this._nativeCorrection.shouldCorrect(bareTool, result.output)) {
        return result;
      }
      const corrected = this._nativeCorrection.correct(bareTool, params);
      if (!corrected) return result;
      logger.info(
        { from: mcpName, to: corrected.nativeTool },
        'MCP tool failed — auto-correcting to native equivalent',
      );
      return await this.execute(corrected.nativeTool, corrected.convertedArgs, ctx);
    } catch (err) {
      logger.warn(
        { tool: mcpName, err: err instanceof Error ? err.message : String(err) },
        'native tool correction failed — returning original MCP failure (fail-open)',
      );
      return result;
    }
  }
}
