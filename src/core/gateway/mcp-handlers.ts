/**
 * @file mcp-handlers.ts
 * @description Internal method handlers for the MCP Loopback Server.
 *
 * NOT part of the public API — imported only by mcp-server.ts.
 * Handles: initialize, tools/list, tools/call, prompts/list, resources/list.
 */

import pino from 'pino';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookManager } from '../hooks/index.js';
import type { ToolDefinition } from '../tools/types.js';

// stderr-only logger — stdout is reserved for the JSON-RPC protocol.
export const log = pino(
  { name: 'mcp-server', level: process.env['LOG_LEVEL'] ?? 'info' },
  pino.destination(2),
);

// ---------------------------------------------------------------------------
// JSON-RPC framing helpers
// ---------------------------------------------------------------------------

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export function respond(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function writeResponse(out: NodeJS.WritableStream, res: JsonRpcResponse): void {
  out.write(JSON.stringify(res) + '\n');
}

// ---------------------------------------------------------------------------
// Tool filtering helpers
// ---------------------------------------------------------------------------

export const SHELL_EXEC_TOOL = 'system.shell-exec';

export function isToolExposed(
  tool: ToolDefinition,
  exposedSet: Set<string> | null,
  allowShell: boolean,
): boolean {
  // Shell-exec double gate: must BOTH be allowlisted AND SUDO_MCP_ALLOW_SHELL=1.
  if (tool.name === SHELL_EXEC_TOOL && !allowShell) return false;

  if (exposedSet !== null) {
    return exposedSet.has(tool.name);
  }

  // Default: expose only non-destructive (readonly) tools.
  return (tool.safety ?? 'readonly') !== 'destructive';
}

export function buildExposedSet(exposedToolsEnv: string | undefined): Set<string> | null {
  if (!exposedToolsEnv || exposedToolsEnv.trim() === '') return null;
  const names = exposedToolsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(names);
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

export function validateParams(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): string | null {
  for (const [name, schema] of Object.entries(tool.parameters)) {
    const value = params[name];
    if (schema.required === true && (value === undefined || value === null)) {
      return `Missing required parameter: ${name}`;
    }
    if (value !== undefined && value !== null) {
      const actual =
        Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
      if (actual !== schema.type) {
        return `Parameter "${name}": expected ${schema.type}, got ${actual}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

export interface HandlerContext {
  registry: ToolRegistry;
  hooks?: HookManager;
  transport: 'stdio' | 'http';
  exposedSet: Set<string> | null;
  allowShell: boolean;
  tokenPrefix: string;
  getClientInfo: () => { name: string; version: string } | null;
  setAuth: (info: { name: string; version: string }) => void;
  isTokenValid: (provided: string | undefined) => boolean;
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'sudo-ai-mcp';
const SERVER_VERSION = '1.0.0';

export function handleInitialize(
  id: string | number | null,
  params: unknown,
  out: NodeJS.WritableStream,
  ctx: HandlerContext,
): void {
  const p = params as Record<string, unknown> | undefined;
  const ci = p?.['clientInfo'] as Record<string, unknown> | undefined;
  const token = ci?.['token'] as string | undefined;

  if (!ctx.isTokenValid(token)) {
    log.warn({ tokenPrefix: ctx.tokenPrefix }, 'initialize: invalid or missing token');
    writeResponse(out, errorResponse(id, -32600, 'Unauthorized'));
    return;
  }

  ctx.setAuth({
    name: (ci?.['name'] as string | undefined) ?? 'unknown',
    version: (ci?.['version'] as string | undefined) ?? '0.0.0',
  });

  log.info(
    { client: ctx.getClientInfo()?.name, tokenPrefix: ctx.tokenPrefix },
    'MCP client authenticated',
  );

  writeResponse(
    out,
    respond(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }),
  );
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

export function handleToolsList(
  id: string | number | null,
  out: NodeJS.WritableStream,
  ctx: HandlerContext,
): void {
  const tools = ctx.registry
    .listAll()
    .filter((t) => isToolExposed(t, ctx.exposedSet, ctx.allowShell))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, p]) => [
            k,
            {
              type: p.type,
              description: p.description,
              ...(p.enum ? { enum: p.enum } : {}),
            },
          ]),
        ),
        required: Object.entries(t.parameters)
          .filter(([, p]) => p.required === true)
          .map(([k]) => k),
      },
    }));
  writeResponse(out, respond(id, { tools }));
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

export async function handleToolsCall(
  id: string | number | null,
  params: unknown,
  out: NodeJS.WritableStream,
  ctx: HandlerContext,
): Promise<void> {
  const p = params as Record<string, unknown> | undefined;
  const toolName = p?.['name'] as string | undefined;
  const rawArgs = (p?.['arguments'] as Record<string, unknown> | undefined) ?? {};

  if (!toolName || typeof toolName !== 'string') {
    writeResponse(out, errorResponse(id, -32602, 'Tool not available'));
    return;
  }

  const toolDef = ctx.registry.get(toolName);
  if (!toolDef) {
    writeResponse(out, errorResponse(id, -32601, 'Tool not found'));
    return;
  }

  // Verify tool is allowlisted.
  if (!isToolExposed(toolDef, ctx.exposedSet, ctx.allowShell)) {
    writeResponse(out, errorResponse(id, -32601, 'Tool not found'));
    return;
  }

  // Validate params BEFORE execution — prevents injection in params.
  const validationError = validateParams(toolDef, rawArgs);
  if (validationError !== null) {
    writeResponse(out, errorResponse(id, -32602, validationError));
    return;
  }

  // Emit hook.
  const mcpClientId = ctx.getClientInfo()?.name ?? 'mcp:unknown';
  if (ctx.hooks) {
    await ctx.hooks.emit('mcp:tool-call', {
      event: 'mcp:tool-call',
      toolName,
      args: rawArgs,
      sessionId: mcpClientId,
      meta: {
        mcpTransport: ctx.transport,
        mcpClientName: ctx.getClientInfo()?.name ?? 'unknown',
      },
    });
  }

  // Execute via registry — only pass rawArgs, no context spread from user input.
  try {
    const result = await ctx.registry.execute(toolName, rawArgs, {
      sessionId: `mcp:${ctx.tokenPrefix}`,
      workingDir: process.cwd(),
      config: {},
      logger: log,
    });

    const text = result.output ?? (result.success ? 'OK' : 'Tool returned no output');
    const content = [{ type: 'text', text }];

    if (result.success) {
      writeResponse(out, respond(id, { content }));
    } else {
      writeResponse(out, respond(id, { content, isError: true }));
    }
  } catch (err) {
    // Never forward raw error messages or stack traces to the client.
    log.error({ toolName, err: String(err) }, 'Tool execution failed');
    writeResponse(
      out,
      respond(id, {
        content: [{ type: 'text', text: 'Tool execution failed' }],
        isError: true,
      }),
    );
  }
}
