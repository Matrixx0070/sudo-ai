/**
 * @file mcp-server.ts
 * @description MCP Loopback Server — exposes SUDO-AI tools over JSON-RPC 2.0 stdio.
 *
 * INBOUND server (clients call SUDO-AI tools via MCP protocol).
 * Do NOT confuse with mcp-adapter.ts which is the OUTBOUND MCP client.
 *
 * Transport: newline-delimited JSON over stdin/stdout.
 * Auth:      bearer token from SUDO_MCP_TOKEN, provided in initialize params.
 *
 * Handlers live in mcp-handlers.ts to keep this file under 300 lines.
 */

import { createInterface } from 'readline';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookManager } from '../hooks/index.js';
import {
  log,
  buildExposedSet,
  errorResponse,
  writeResponse,
  handleInitialize,
  handleToolsList,
  handleToolsCall,
  respond,
  type HandlerContext,
  type JsonRpcResponse,
} from './mcp-handlers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REQUEST_BYTES = 1_048_576; // 1 MB

// JSON-RPC error codes
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MCPServerOptions {
  /** Transport: 'stdio' (default) or 'http'. 'http' is not yet implemented — stub only. */
  transport: 'stdio' | 'http';
  /** HTTP port — only used when transport='http'. Default: 18801 */
  port?: number;
  /** Bearer token required in initialize params.clientInfo.token. From SUDO_MCP_TOKEN env. */
  token: string;
  /** Comma-separated tool name allowlist. Empty = all non-destructive tools. */
  exposedTools?: string;
  /** Injected ToolRegistry instance. */
  registry: ToolRegistry;
  /** Optional HookManager for emitting mcp:tool-call events. */
  hooks?: HookManager;
}

export interface MCPLoopbackServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Line dispatcher
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

async function dispatchLine(
  line: string,
  out: NodeJS.WritableStream,
  isAuthenticated: () => boolean,
  handlerCtx: HandlerContext,
  onAuthenticated: () => void,
): Promise<void> {
  // Request size guard (DoS protection).
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
    writeResponse(out, errorResponse(null, ERR_INVALID_REQUEST, 'Request too large'));
    return;
  }

  let req: JsonRpcRequest;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('method' in parsed)) {
      writeResponse(out, errorResponse(null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC request'));
      return;
    }
    req = parsed as JsonRpcRequest;
  } catch {
    writeResponse(out, errorResponse(null, ERR_PARSE, 'Parse error'));
    return;
  }

  const id = req.id ?? null;
  const method = req.method;

  // Auth gate: all methods except initialize require a valid authenticated session.
  // NOTE (stdio): For stdio transport the session IS the pipe — it has a single
  // owner and cannot be hijacked mid-session.  Once authenticated, we check the
  // boolean `authenticated` flag on every call rather than re-reading the token
  // (the MCP protocol does not include a token field in tools/call params).
  // HTTP transport (when implemented) MUST re-validate the bearer token on every request.
  if (method !== 'initialize' && !isAuthenticated()) {
    writeResponse(out, errorResponse(id, ERR_INVALID_REQUEST, 'Unauthorized'));
    return;
  }

  switch (method) {
    case 'initialize':
      handleInitialize(id, req.params, out, handlerCtx);
      onAuthenticated();
      break;
    case 'tools/list':
      handleToolsList(id, out, handlerCtx);
      break;
    case 'tools/call':
      await handleToolsCall(id, req.params, out, handlerCtx);
      break;
    case 'prompts/list':
      writeResponse(out, respond(id, { prompts: [] }) as JsonRpcResponse);
      break;
    case 'resources/list':
      writeResponse(out, respond(id, { resources: [] }) as JsonRpcResponse);
      break;
    default:
      writeResponse(out, errorResponse(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMCPServer(opts: MCPServerOptions): MCPLoopbackServer {
  if (!opts.token || opts.token.trim() === '') {
    throw new Error('MCP server cannot start: SUDO_MCP_TOKEN is not set');
  }
  if (opts.transport === 'http') {
    throw new Error('HTTP transport is not yet implemented (Phase 2)');
  }

  let running = false;
  let authenticated = false;
  let clientInfo: { name: string; version: string } | null = null;
  let rlInterface: ReturnType<typeof createInterface> | null = null;

  const allowShell = process.env['SUDO_MCP_ALLOW_SHELL'] === '1';
  const exposedSet = buildExposedSet(opts.exposedTools);
  const tokenPrefix = opts.token.slice(0, 4);

  const handlerCtx: HandlerContext = {
    registry: opts.registry,
    hooks: opts.hooks,
    transport: opts.transport,
    exposedSet,
    allowShell,
    tokenPrefix,
    getClientInfo: () => clientInfo,
    setAuth: (info) => {
      clientInfo = info;
      authenticated = true;
    },
    isTokenValid: (provided: string | undefined) =>
      typeof provided === 'string' && provided === opts.token,
  };

  return {
    get isRunning() {
      return running;
    },

    async start(): Promise<void> {
      if (running) {
        log.warn('MCP server already running');
        return;
      }

      running = true;
      log.info({ transport: opts.transport }, 'MCP server starting');

      const out = process.stdout;

      rlInterface = createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
        terminal: false,
      });

      rlInterface.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        dispatchLine(
          trimmed,
          out,
          () => authenticated,
          handlerCtx,
          () => { /* auth state is set inside handleInitialize via setAuth */ },
        ).catch((err) => {
          log.error({ err: String(err) }, 'Unhandled error in dispatchLine');
        });
      });

      rlInterface.on('close', () => {
        log.info('stdin closed — MCP server shutting down');
        running = false;
      });
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      rlInterface?.close();
      rlInterface = null;
      authenticated = false;
      clientInfo = null;
      log.info('MCP server stopped');
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap helper (used by mcp-cli.ts)
// ---------------------------------------------------------------------------

export function createMCPServerFromEnv(
  registry: ToolRegistry,
  hooks?: HookManager,
): MCPLoopbackServer {
  const token = process.env['SUDO_MCP_TOKEN'];
  if (!token || token.trim() === '') {
    process.stderr.write('[mcp-server] FATAL: SUDO_MCP_TOKEN environment variable is not set\n');
    process.exit(1);
  }

  return createMCPServer({
    transport: 'stdio',
    token,
    exposedTools: process.env['SUDO_MCP_EXPOSE_TOOLS'],
    registry,
    hooks,
  });
}
