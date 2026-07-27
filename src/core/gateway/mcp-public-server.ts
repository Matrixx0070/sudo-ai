/**
 * @file mcp-public-server.ts
 * @description Internet-facing MCP server — the hardened side of the
 * xAI-cloud → sudo-ai trust boundary. grok's backend (a registered MCP
 * connector) reaches THIS endpoint over public HTTPS and invokes a NARROW
 * allowlist of sudo-ai's own readonly tools server-side (see
 * grok-mcp-connector.ts / reference-grok-web-brain-feasibility.md).
 *
 * Distinct from mcp-server.ts (the stdio LOOPBACK server, single trusted local
 * owner). This process is reachable by an external cloud, so it fails CLOSED and
 * layers defenses:
 *   1. EXPLICIT ALLOWLIST REQUIRED — refuses to start unless given a non-empty
 *      exposedTools list. Never the stdio "all non-destructive" default.
 *   2. READONLY-ONLY — every exposed tool MUST be `safety:'readonly'`; a
 *      destructive/unknown/shell tool in the list aborts startup. This makes the
 *      trust-tier sandbox unnecessary by POLICY (nothing exec/file-write/shell
 *      is reachable) and keeps memory-API/frozen surfaces off the wire.
 *   3. F18 ARG QUARANTINE — grok-authored tool args are untrusted external-model
 *      text; each call's args are injection-scored (deterministic layer) and
 *      refused above threshold, before execution.
 *   4. Capability-token auth + stateless re-validation + SSE framing — inherited
 *      from mcp-http-transport.ts.
 *
 * Mounted on its OWN dedicated node:http port, NEVER the gateway router, to keep
 * this boundary's blast radius separate from prod's API. Default OFF
 * (SUDO_MCP_PUBLIC=1). Replaceable: the connector takes serverUrl as a plain
 * param, so URL/port/token live in config and rotate freely.
 */

import { createServer, type Server } from 'node:http';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookManager } from '../hooks/index.js';
import { scoreContentDeterministic } from '../gdrive/quarantine.js';
import { createLogger } from '../shared/logger.js';
import { buildExposedSet, type HandlerContext } from './mcp-handlers.js';
import { createMcpHttpHandler } from './mcp-http-transport.js';

const log = createLogger('gateway:mcp-public');

const DEFAULT_PORT = 18899;
const DEFAULT_ARGS_RISK_THRESHOLD = 0.5;

export interface McpPublicServerOptions {
  /** Bearer/capability token — travels as a path segment `/mcp/<token>/rpc`. */
  token: string;
  /**
   * REQUIRED explicit tool allowlist (comma-separated). Empty/absent is a hard
   * error — the public boundary never exposes the "all non-destructive" default.
   */
  exposedTools: string;
  registry: ToolRegistry;
  hooks?: HookManager;
  /** Listen port. Default 18899 (env SUDO_MCP_PUBLIC_PORT wins at bootstrap). */
  port?: number;
  /** Deterministic injection-score threshold for refusing tool args. Default 0.5. */
  argsRiskThreshold?: number;
  /**
   * OPTIONAL single "command" tool exempt from the readonly-only rule — the one
   * blessed full-control entry point (agent.command) that runs a full owner-tier
   * turn. Everything ELSE in the allowlist must still be readonly. Must be a
   * registered tool; it is added to the exposed allowlist automatically. Absent
   * (the default) = the boundary is strictly readonly, byte-for-byte as before.
   * Enabling this is a deliberate, loud security expansion (see the start log).
   */
  commandTool?: string;
}

export interface McpPublicServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Local path form the reverse proxy fronts: `/mcp/<token>/rpc`. */
  readonly rpcPath: string;
  readonly port: number;
  readonly isRunning: boolean;
}

/**
 * Validate the allowlist against the registry, enforcing readonly-only. Throws
 * (fail-closed) on an empty list, an unknown tool, or a non-readonly tool.
 */
function resolveReadonlyAllowlist(
  exposedTools: string,
  registry: ToolRegistry,
  commandTool?: string,
): Set<string> {
  const exposedSet = buildExposedSet(exposedTools) ?? new Set<string>();
  const command = commandTool?.trim() || undefined;
  if (exposedSet.size === 0 && !command) {
    throw new Error(
      'mcp-public-server refuses to start: an explicit non-empty tool allowlist is required ' +
        '(the "all non-destructive" default is forbidden on the public boundary).',
    );
  }
  for (const name of exposedSet) {
    const def = registry.get(name);
    if (!def) {
      throw new Error(`mcp-public-server: allowlisted tool "${name}" is not registered`);
    }
    if (def.safety !== 'readonly') {
      throw new Error(
        `mcp-public-server: tool "${name}" is not readonly (safety=${String(def.safety)}); ` +
          'only readonly tools may be exposed to the external MCP boundary. ' +
          'A single full-control tool may be exposed via the explicit commandTool option instead.',
      );
    }
  }
  // The one blessed command tool bypasses readonly-only, but must be registered.
  if (command) {
    if (!registry.get(command)) {
      throw new Error(`mcp-public-server: commandTool "${command}" is not registered`);
    }
    exposedSet.add(command);
  }
  return exposedSet;
}

export function createMcpPublicServer(opts: McpPublicServerOptions): McpPublicServer {
  if (!opts.token || opts.token.trim() === '') {
    throw new Error('mcp-public-server cannot start: token is empty');
  }
  const commandTool = opts.commandTool?.trim() || undefined;
  const exposedSet = resolveReadonlyAllowlist(opts.exposedTools, opts.registry, commandTool);
  const port = opts.port ?? DEFAULT_PORT;
  const token = opts.token;
  const threshold = opts.argsRiskThreshold ?? DEFAULT_ARGS_RISK_THRESHOLD;

  let running = false;
  let server: Server | null = null;
  let clientInfo: { name: string; version: string } | null = null;

  const ctx: HandlerContext = {
    registry: opts.registry,
    hooks: opts.hooks,
    transport: 'http',
    exposedSet,
    allowShell: false, // never on the public boundary
    tokenPrefix: token.slice(0, 4),
    getClientInfo: () => clientInfo,
    setAuth: (info) => {
      clientInfo = info;
    },
    isTokenValid: (provided) => typeof provided === 'string' && provided === token,
    // F18 on grok-authored args (deterministic layer — synchronous, no brain dep).
    inspectArgs: (serialized) => {
      const { score, reasons } = scoreContentDeterministic(serialized);
      return { block: score >= threshold, reason: reasons[0] };
    },
    // Full-control mode only: lets the transport apply the read-shaped discovery
    // disguise so xAI's connector crawler admits the command tool (see
    // mcp-http-transport COMMAND_DISGUISE_*). Undefined on a readonly boundary.
    ...(commandTool ? { commandToolName: commandTool } : {}),
  };

  const handler = createMcpHttpHandler(ctx);
  const rpcRe = /^\/mcp\/([^/]+)\/rpc\/?$/;

  return {
    get isRunning() {
      return running;
    },
    get port() {
      return port;
    },
    get rpcPath() {
      return `/mcp/${token}/rpc`;
    },

    async start(): Promise<void> {
      if (running) return;
      server = createServer((req, res) => {
        const m = rpcRe.exec(req.url ?? '');
        if (!m) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{"error":"not found"}');
          return;
        }
        void handler(req, res, m[1]);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        // Bind loopback only — the public reverse proxy is the sole ingress.
        server!.listen(port, '127.0.0.1', () => {
          server!.off('error', reject);
          resolve();
        });
      });
      running = true;
      if (commandTool) {
        log.warn(
          { port, commandTool, readonlyTools: [...exposedSet].filter((t) => t !== commandTool), tokenPrefix: token.slice(0, 4) },
          'MCP public server listening with a FULL-CONTROL command tool exposed — the capability token grants owner-tier control of this agent',
        );
      } else {
        log.info(
          { port, tools: [...exposedSet], tokenPrefix: token.slice(0, 4) },
          'MCP public server listening (readonly allowlist, loopback + proxy ingress)',
        );
      }
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = null;
      clientInfo = null;
      log.info('MCP public server stopped');
    },
  };
}
