/**
 * @file mcp-http-transport.ts
 * @description Public-HTTP transport for the MCP Loopback Server — the
 * "Streamable HTTP" MCP transport (2024-11-05 spec, JSON-response mode: one
 * POST in, one JSON-RPC response out). Reuses the SAME dispatch handlers as
 * the stdio server (mcp-handlers.ts) so tool exposure, param validation, and
 * error-hiding behave identically on both transports.
 *
 * THIS IS A REAL TRUST BOUNDARY: an internet-reachable process (an external
 * cloud's MCP client, e.g. grok's backend) can invoke sudo-ai tools here.
 * Hardening, layered:
 *   1. Capability-URL token: the bearer token is a path segment
 *      (`/mcp/<token>/rpc`), so it travels with ANY client regardless of
 *      whether it supports custom headers. An `Authorization: Bearer` header
 *      is also accepted (defense in depth) and, if present, MUST match.
 *   2. STATELESS re-auth: unlike stdio (one pipe, one owner, auth-once), HTTP
 *      has no persistent session — the token is re-validated on EVERY request,
 *      including `initialize` (the stdio auth-gate's "authenticated" flag
 *      does not apply here at all).
 *   3. Tool exposure is still gated by the SAME exposedSet/allowShell logic —
 *      callers of this module MUST pass a narrow, explicit exposedTools
 *      allowlist for anything reachable from the public internet. Never rely
 *      on the "all non-destructive tools" default for an HTTP context.
 *   4. Request size capped (matches the stdio MAX_REQUEST_BYTES guard).
 *   5. Errors never leak stack traces / raw messages (inherited from
 *      handleToolsCall's catch-and-generic-message behavior).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  log,
  errorResponse,
  handleToolsList,
  handleToolsCall,
  respond,
  MCP_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  type HandlerContext,
  type JsonRpcResponse,
} from './mcp-handlers.js';

const MAX_REQUEST_BYTES = 1_048_576; // 1 MB — matches stdio transport.

/**
 * Sudo-ai tool names are dot-namespaced (`coder.read-file`). Some MCP clients —
 * notably grok's native connector client — require tool names to match
 * `^[a-zA-Z0-9_-]+$`; a `.` makes the name invalid, so the tool is enumerated
 * but silently dropped from the MODEL's function schema (observed live: grok
 * connected + listed our dotted tool, then the model denied having it and never
 * issued tools/call). We therefore expose grok-safe names (`.`→`_`) on the wire
 * and reverse-resolve them against the registry on tools/call. Reversal is by
 * registry lookup (not string surgery), so it is unambiguous.
 */
function sanitizeMcpToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

/** Minimal Writable-like sink so the shared handlers can write one response. */
function captureOneResponse(): { write: (s: string) => void; take: () => string | null } {
  let captured: string | null = null;
  return {
    write: (s: string) => {
      captured = s;
    },
    take: () => captured,
  };
}

/**
 * Handle one JSON-RPC-over-HTTP request body. Token is validated here
 * (stateless — no persistent auth flag). Returns the raw JSON-RPC response
 * text (always valid JSON-RPC, even for auth/parse failures) plus the HTTP
 * status to send.
 */
export async function handleMcpHttpBody(
  bodyText: string,
  providedToken: string | undefined,
  ctx: HandlerContext,
): Promise<{ status: number; body: string }> {
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_REQUEST_BYTES) {
    return { status: 413, body: JSON.stringify(errorResponse(null, -32600, 'Request too large')) };
  }

  // Stateless re-auth on EVERY request (HTTP has no persistent pipe-owner).
  if (!ctx.isTokenValid(providedToken)) {
    log.warn({ tokenPrefix: ctx.tokenPrefix }, 'mcp-http: invalid or missing token');
    return { status: 401, body: JSON.stringify(errorResponse(null, -32600, 'Unauthorized')) };
  }

  let req: JsonRpcRequest;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('method' in parsed)) {
      return { status: 400, body: JSON.stringify(errorResponse(null, -32600, 'Invalid JSON-RPC request')) };
    }
    req = parsed as JsonRpcRequest;
  } catch {
    return { status: 400, body: JSON.stringify(errorResponse(null, -32700, 'Parse error')) };
  }

  // Notifications (per JSON-RPC 2.0 / MCP) carry no `id` and expect NO response
  // body — the server MUST accept them silently (202). Returning a JSON-RPC
  // error to `notifications/initialized` breaks an MCP client's handshake so its
  // tools never become callable (observed live: grok connected + listed tools
  // but the model then denied having them). Method names starting with
  // `notifications/` are always notifications.
  if (req.method.startsWith('notifications/') || (req.id === undefined && req.method !== 'initialize')) {
    return { status: 202, body: '' };
  }

  const id = req.id ?? null;
  const sink = captureOneResponse();

  switch (req.method) {
    case 'initialize': {
      // HTTP has no session state and no clientInfo.token gate — auth was
      // already re-validated above for THIS request (path/Bearer token), and
      // every subsequent request re-validates independently. Record the client
      // identity for logging, then reply directly.
      const params = req.params as Record<string, unknown> | undefined;
      const ci = params?.['clientInfo'] as Record<string, unknown> | undefined;
      ctx.setAuth({
        name: (ci?.['name'] as string | undefined) ?? 'unknown',
        version: (ci?.['version'] as string | undefined) ?? '0.0.0',
      });
      // Echo the client's requested protocolVersion when present — MCP clients
      // (grok's model runtime) refuse to load tools when the negotiated version
      // does not match what they asked for. Fall back to our own baseline.
      const requestedVersion = params?.['protocolVersion'];
      const protocolVersion =
        typeof requestedVersion === 'string' && requestedVersion ? requestedVersion : MCP_PROTOCOL_VERSION;
      sink.write(
        JSON.stringify(
          respond(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          }) as JsonRpcResponse,
        ),
      );
      break;
    }
    case 'tools/list': {
      handleToolsList(id, sink as unknown as NodeJS.WritableStream, ctx);
      // Rewrite dot-namespaced names to grok-safe names on the wire.
      const raw = sink.take();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { result?: { tools?: Array<{ name: string }> } };
          for (const t of parsed.result?.tools ?? []) t.name = sanitizeMcpToolName(t.name);
          return { status: 200, body: JSON.stringify(parsed) };
        } catch {
          /* fall through to raw body */
        }
      }
      break;
    }
    case 'tools/call': {
      // grok sends the grok-safe (sanitized) name; map it back to the real
      // registered dotted name by lookup before dispatching.
      const p = req.params as { name?: string } | undefined;
      if (p?.name) {
        const real = ctx.registry.listAll().find((t) => sanitizeMcpToolName(t.name) === p.name);
        if (real) p.name = real.name;
      }
      await handleToolsCall(id, req.params, sink as unknown as NodeJS.WritableStream, ctx);
      break;
    }
    case 'prompts/list':
      sink.write(JSON.stringify(respond(id, { prompts: [] }) as JsonRpcResponse));
      break;
    case 'resources/list':
      sink.write(JSON.stringify(respond(id, { resources: [] }) as JsonRpcResponse));
      break;
    default:
      sink.write(JSON.stringify(errorResponse(id, -32601, `Method not found: ${req.method}`)));
  }

  return { status: 200, body: sink.take() ?? JSON.stringify(errorResponse(id, -32603, 'No response produced')) };
}

/** Extract the bearer token from a request: path segment wins, header is fallback. */
export function extractToken(req: IncomingMessage, pathToken: string | undefined): string | undefined {
  if (pathToken) return pathToken;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

/**
 * node:http request handler factory. Mount at a path like
 * `/mcp/<token>/rpc` (pass the extracted `pathToken` in per request) on a
 * dedicated, isolated HTTP server — never the main gateway's request router,
 * to keep this trust boundary's blast radius separate from prod's own API.
 */
export function createMcpHttpHandler(ctx: HandlerContext) {
  return async (req: IncomingMessage, res: ServerResponse, pathToken: string | undefined): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorResponse(null, -32600, 'Method not allowed')));
      return;
    }
    const chunks: Buffer[] = [];
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > MAX_REQUEST_BYTES) tooLarge = true;
    });
    req.on('end', () => {
      void (async () => {
        if (tooLarge) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorResponse(null, -32600, 'Request too large')));
          return;
        }
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const token = extractToken(req, pathToken);
        const { status, body } = await handleMcpHttpBody(bodyText, token, ctx);
        // MCP "Streamable HTTP": when the client accepts text/event-stream, the
        // response MUST be an SSE event, not bare JSON. grok's model-runtime tool
        // client requires this framing to attach a connector's tools (its lenient
        // connectors-manager accepts plain JSON for discovery, but the model side
        // does not — observed live against a reference SSE server, deepwiki). One
        // event, then close (single request → single response).
        const wantsSse = (req.headers['accept'] ?? '').includes('text/event-stream');
        if (wantsSse && body) {
          res.writeHead(status, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.end(`event: message\ndata: ${body}\n\n`);
        } else {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        }
      })().catch((err: unknown) => {
        log.error({ err: String(err) }, 'mcp-http: unhandled error');
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorResponse(null, -32603, 'Internal error')));
      });
    });
  };
}
