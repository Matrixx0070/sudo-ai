/**
 * @file tools/mcp-adapter.ts
 * @description MCPAdapter — connects to external MCP (Model Context Protocol)
 * servers using raw stdio JSON-RPC 2.0 over child_process.spawn or HTTP/SSE/WebSocket.
 *
 * Does NOT require @modelcontextprotocol/sdk.
 * Protocol ref: https://spec.modelcontextprotocol.io/specification/2024-11-05/
 */

import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { resolveSecretMap, type SecretRef } from '../secrets/secret-ref.js';
import { OAuthClient } from './mcp-oauth.js';
import { SSETransport } from './mcp-sse-transport.js';
import { WSTransport } from './mcp-ws-transport.js';

const log = createLogger('tools:mcp-adapter');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  /** Unique identifier for this server instance. */
  id: string;
  /**
   * Transport mechanism.
   * - 'stdio': spawn a child process and communicate over stdin/stdout (default).
   * - 'http': communicate over HTTP JSON-RPC 2.0 (requires baseUrl).
   * - 'sse': Server-Sent Events transport (requires url).
   * - 'websocket': WebSocket transport (requires url).
   */
  transport: 'stdio' | 'http' | 'sse' | 'websocket';
  /** Executable to spawn (e.g. "npx", "node", "/usr/bin/python3"). Required for stdio. */
  command?: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Additional environment variables for the child process. Each value may be a
   * plain string or a SecretRef ({source,provider,id}) resolved at spawn time. */
  env?: Record<string, string | SecretRef>;
  /**
   * Base URL of the MCP server.
   * Required when transport === 'http', 'sse', or 'websocket'.
   * For SSE: the SSE endpoint URL.
   * For WebSocket: the WebSocket URL (ws:// or wss://).
   */
  baseUrl?: string;
  /**
   * OAuth 2.1 PKCE configuration for authenticated transports.
   * When provided, tokens are automatically obtained and refreshed.
   */
  oauth?: {
    issuer: string;
    clientId: string;
    redirectUri: string;
    clientSecret?: string;
    scope?: string;
  };
  /**
   * Pre-shared access token (alternative to OAuth flow).
   * Used for HTTP Authorization header or WebSocket/SSE auth.
   */
  accessToken?: string;
  /**
   * Per-tool enable/disable filtering.
   * If undefined, all discovered tools are enabled.
   */
  toolFilter?: Record<string, boolean>;
}

export interface MCPToolDef {
  /** Tool name. Prefixed with "<serverId>__" by convention. */
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
  /** ID of the MCP server that provides this tool. */
  serverId: string;
  /** Whether this tool is currently enabled (for filtering). */
  enabled: boolean;
}

/**
 * Structural interface satisfied by both {@link MCPAdapter} (stdio) and
 * {@link HTTPMCPAdapter} (HTTP).
 *
 * {@link ToolRegistry.registerMCPSource} currently accepts `MCPAdapter` by
 * nominal type.  When that signature is widened to accept `MCPAdapterLike`,
 * callers can pass either adapter without a cast.  Until then, cast to
 * `MCPAdapter` at the call site:
 *
 * ```ts
 * registry.registerMCPSource(httpAdapter as unknown as MCPAdapter, serverId);
 * ```
 */
export interface MCPAdapterLike {
  readonly serverId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<MCPToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }>;
  getCachedTools(): MCPToolDef[];
}

// ---------------------------------------------------------------------------
// Internal JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Present for requests; omitted for notifications (JSON-RPC 2.0 spec). */
  id?: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// MCPAdapter
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 15_000 as const;
const CALL_TIMEOUT_MS = 30_000 as const;
const MCP_PROTOCOL_VERSION = '2024-11-05' as const;
/** Hard cap on the stdout line buffer — a server that never emits a newline can't OOM us. */
const MAX_LINE_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

export class MCPAdapter {
  private process: ChildProcess | null = null;
  private sseTransport: SSETransport | null = null;
  private wsTransport: WSTransport | null = null;
  private oauthClient: OAuthClient | null = null;
  private readonly pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private tools: MCPToolDef[] = [];
  /** Partial line buffer for stdout chunk accumulation. */
  private lineBuffer = '';
  /** HTTP session for remote transports */
  private httpSession: { baseUrl: string; accessToken?: string } | null = null;
  /** Access token for the SSE outbound (HTTP POST) return channel — OAuth/SSE has no httpSession. */
  private sseAccessToken: string | null = null;
  /** True once the initial `initialize` handshake has completed (gates re-handshake on transparent reconnect). */
  private _initialized = false;

  constructor(private readonly config: MCPServerConfig) {
    // Initialize OAuth client if configured
    if (config.oauth && process.env['SUDO_MCP_OAUTH_DISABLE'] !== '1') {
      this.oauthClient = new OAuthClient(config.oauth);
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to the MCP server using the configured transport.
   * Resolves when the server is ready to accept tool calls.
   *
   * @throws {Error} when the handshake times out or connection fails.
   */
  async connect(): Promise<void> {
    // Check global kill-switch
    if (process.env['SUDO_MCP_DISABLE'] === '1') {
      throw new Error('MCP functionality disabled via SUDO_MCP_DISABLE');
    }

    switch (this.config.transport) {
      case 'stdio':
        await this._connectStdio();
        break;
      case 'http':
        await this._connectHttp();
        break;
      case 'sse':
        await this._connectSse();
        break;
      case 'websocket':
        await this._connectWebSocket();
        break;
      default:
        throw new Error(`MCPAdapter[${this.config.id}]: unknown transport ${this.config.transport}`);
    }

    log.info(
      { serverId: this.config.id, transport: this.config.transport },
      'MCP server connected and initialized',
    );
  }

  private async _connectStdio(): Promise<void> {
    if (this.process) {
      log.warn({ serverId: this.config.id }, 'MCPAdapter._connectStdio called but already connected');
      return;
    }

    if (!this.config.command) {
      throw new Error(
        `MCPAdapter[${this.config.id}]: 'command' is required for stdio transport`,
      );
    }

    log.info(
      { serverId: this.config.id, command: this.config.command, args: this.config.args },
      'Spawning MCP server process',
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...resolveSecretMap(this.config.env), // SecretRef values resolved at spawn
    };

    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // Wire stderr to our logger.
    this.process.stderr?.on('data', (chunk: Buffer) => {
      log.debug({ serverId: this.config.id, stderr: chunk.toString() }, 'MCP server stderr');
    });

    // Wire stdout line parser.
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this._handleStdoutChunk(chunk.toString());
    });

    // A write to a stdin whose pipe has closed (the child exited) emits an
    // asynchronous 'error' on the Writable. Without this handler it surfaces as
    // an unhandled exception and crashes the daemon. Swallow it — the exit
    // handler already nulls the process and rejects pending requests.
    this.process.stdin?.on('error', (err: Error) => {
      log.warn({ serverId: this.config.id, err: err.message }, 'MCP stdin error (pipe closed)');
    });

    this.process.on('error', (err) => {
      log.error({ serverId: this.config.id, err: err.message }, 'MCP process error');
      this._rejectAll(err);
    });

    this.process.on('exit', (code, signal) => {
      log.info({ serverId: this.config.id, code, signal }, 'MCP process exited');
      // Null the process + reset the line buffer so isConnected() flips false and a
      // subsequent callTool() fails the connected-check instead of writing to dead stdin.
      this.process = null;
      this.lineBuffer = '';
      this._initialized = false;
      this._rejectAll(new Error(`MCP server exited unexpectedly (code=${code}, signal=${signal})`));
    });

    // Send initialize handshake. If it times out / fails, kill the orphaned child
    // and null the process so isConnected() doesn't lie and a retry connect() proceeds.
    try {
      await this._handshake();
    } catch (err) {
      this.process?.kill('SIGTERM');
      this.process = null;
      this.lineBuffer = '';
      this._initialized = false;
      throw err;
    }
  }

  private async _connectHttp(): Promise<void> {
    // Check kill-switch for remote transports
    if (process.env['SUDO_MCP_REMOTE_DISABLE'] === '1') {
      throw new Error('HTTP transport disabled via SUDO_MCP_REMOTE_DISABLE');
    }

    if (!this.config.baseUrl) {
      throw new Error(`MCPAdapter[${this.config.id}]: 'baseUrl' is required for HTTP transport`);
    }

    // Obtain OAuth token if configured
    let accessToken = this.config.accessToken;
    if (this.oauthClient) {
      accessToken = await this.oauthClient.getAccessToken() ?? undefined;
    }

    this.httpSession = {
      baseUrl: this.config.baseUrl,
      accessToken,
    };

    log.debug(
      { serverId: this.config.id, baseUrl: this.config.baseUrl },
      'HTTP transport initialized',
    );
  }

  private async _connectSse(): Promise<void> {
    if (process.env['SUDO_MCP_REMOTE_DISABLE'] === '1') {
      throw new Error('SSE transport disabled via SUDO_MCP_REMOTE_DISABLE');
    }

    if (!this.config.baseUrl) {
      throw new Error(`MCPAdapter[${this.config.id}]: 'baseUrl' is required for SSE transport`);
    }

    // Obtain OAuth token if configured
    let accessToken = this.config.accessToken;
    if (this.oauthClient) {
      accessToken = await this.oauthClient.getAccessToken() ?? undefined;
    }
    // Remember the token for the outbound HTTP-POST return channel (OAuth/SSE has no httpSession).
    this.sseAccessToken = accessToken ?? null;

    this.sseTransport = new SSETransport({
      url: this.config.baseUrl,
      accessToken,
    });

    // Set up message handler for JSON-RPC responses
    this.sseTransport.on('message', (msg) => {
      this._dispatchLine(msg.data);
    });

    this.sseTransport.on('error', (err) => {
      log.error({ serverId: this.config.id, err: err.message }, 'SSE transport error');
      this._rejectAll(err);
    });

    this.sseTransport.on('close', () => {
      log.info({ serverId: this.config.id }, 'SSE transport closed');
      this._rejectAll(new Error('SSE transport closed'));
    });

    // The transport reconnects transparently; the new server connection has never
    // been initialized. Re-run the handshake on every reconnect (the first 'open'
    // fires during connect() below, before _initialized is set, so it's skipped).
    this.sseTransport.on('open', () => {
      if (this._initialized) {
        void this._handshake().catch((err: unknown) =>
          log.warn({ serverId: this.config.id, err: String(err) }, 'MCP re-initialize after SSE reconnect failed'));
      }
    });

    await this.sseTransport.connect();

    await this._handshake();
  }

  private async _connectWebSocket(): Promise<void> {
    if (process.env['SUDO_MCP_REMOTE_DISABLE'] === '1') {
      throw new Error('WebSocket transport disabled via SUDO_MCP_REMOTE_DISABLE');
    }

    if (!this.config.baseUrl) {
      throw new Error(`MCPAdapter[${this.config.id}]: 'baseUrl' is required for WebSocket transport`);
    }

    // Obtain OAuth token if configured
    let accessToken = this.config.accessToken;
    if (this.oauthClient) {
      accessToken = await this.oauthClient.getAccessToken() ?? undefined;
    }

    this.wsTransport = new WSTransport({
      url: this.config.baseUrl,
      accessToken,
      protocol: 'json-rpc',
    });

    // Set up message handler for JSON-RPC responses
    this.wsTransport.on('message', (data) => {
      this._dispatchLine(data);
    });

    this.wsTransport.on('error', (err) => {
      log.error({ serverId: this.config.id, err: err.message }, 'WebSocket transport error');
      this._rejectAll(err);
    });

    this.wsTransport.on('close', () => {
      log.info({ serverId: this.config.id }, 'WebSocket transport closed');
      this._rejectAll(new Error('WebSocket transport closed'));
    });

    // Re-run the MCP handshake after a transparent reconnect (the first 'open'
    // fires during connect() below, before _initialized is set, so it's skipped).
    this.wsTransport.on('open', () => {
      if (this._initialized) {
        void this._handshake().catch((err: unknown) =>
          log.warn({ serverId: this.config.id, err: String(err) }, 'MCP re-initialize after WS reconnect failed'));
      }
    });

    await this.wsTransport.connect();

    await this._handshake();
  }

  /**
   * Run the MCP `initialize` handshake (request + notifications/initialized) and
   * mark the session initialized. Shared by every transport's first connect and
   * re-run on a transparent SSE/WS reconnect so the new server connection is
   * properly initialized before tool calls resume.
   */
  private async _handshake(): Promise<void> {
    await this._rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sudo-ai', version: '5.0.0' },
    });
    this._notify('notifications/initialized', {});
    this._initialized = true;
  }

  // -------------------------------------------------------------------------
  // Tool discovery
  // -------------------------------------------------------------------------

  /**
   * Request the list of tools from the MCP server.
   * Results are cached internally and returned with `serverId` set.
   * Applies tool filtering based on config.toolFilter.
   */
  async listTools(): Promise<MCPToolDef[]> {
    this._assertConnected();

    const result = await this._rpc('tools/list', {}) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };

    const rawTools = Array.isArray(result?.tools) ? result.tools : [];

    this.tools = rawTools.map((t) => {
      const fullName = `mcp__${this.config.id}__${t.name}`;
      const enabled = this.config.toolFilter
        ? (this.config.toolFilter[t.name] ?? true)
        : true;

      return {
        name: fullName,
        description: t.description ?? `MCP tool from ${this.config.id}`,
        inputSchema: t.inputSchema ?? {},
        serverId: this.config.id,
        enabled,
      };
    });

    const enabledCount = this.tools.filter(t => t.enabled).length;
    log.info(
      { serverId: this.config.id, toolCount: this.tools.length, enabledCount },
      'MCP tools discovered',
    );
    return this.tools;
  }

  /**
   * Enable or disable a specific tool by name.
   * @param toolName - The raw tool name (without prefix)
   * @param enabled - Whether the tool should be enabled
   */
  setToolEnabled(toolName: string, enabled: boolean): void {
    const tool = this.tools.find(t => t.name === `mcp__${this.config.id}__${toolName}`);
    if (tool) {
      tool.enabled = enabled;
      log.info({ serverId: this.config.id, tool: toolName, enabled }, 'Tool enabled/disabled');
    } else {
      log.warn({ serverId: this.config.id, tool: toolName }, 'setToolEnabled: tool not found');
    }
  }

  /** Get list of enabled tools only */
  getEnabledTools(): MCPToolDef[] {
    return this.tools.filter(t => t.enabled);
  }

  /**
   * Invoke a tool on the MCP server.
   *
   * @param name - The raw (un-prefixed) tool name as returned by the MCP server.
   * @param args - Arguments map for the tool.
   * @throws {Error} if the tool is disabled or not connected.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string }> {
    this._assertConnected();

    // Strip the "mcp__<serverId>__" prefix if the caller passed the full name.
    const prefix = `mcp__${this.config.id}__`;
    const rawName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

    // Check if tool is enabled
    const tool = this.tools.find(t => t.name === name);
    if (tool && !tool.enabled) {
      throw new Error(`Tool ${rawName} is disabled on server ${this.config.id}`);
    }

    log.debug({ serverId: this.config.id, tool: rawName, args }, 'Calling MCP tool');

    let result: unknown;

    // Route the call based on transport type
    switch (this.config.transport) {
      case 'stdio':
      case 'sse':
      case 'websocket':
        result = await this._rpc('tools/call', { name: rawName, arguments: args });
        break;
      case 'http':
        result = await this._httpRpc('tools/call', { name: rawName, arguments: args });
        break;
      default:
        throw new Error(`MCPAdapter[${this.config.id}]: unknown transport ${this.config.transport}`);
    }

    const resultObj = result as {
      content?: Array<{ type: string; text?: string }> | string;
    };

    // Normalise various content shapes into a single string.
    let content = '';
    if (typeof resultObj?.content === 'string') {
      content = resultObj.content;
    } else if (Array.isArray(resultObj?.content)) {
      content = resultObj.content
        .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
        .join('\n');
    } else if (resultObj !== undefined && resultObj !== null) {
      content = JSON.stringify(resultObj);
    }

    return { content };
  }

  /** HTTP JSON-RPC call for HTTP transport */
  private async _httpRpc(method: string, params: unknown, isRetry = false): Promise<unknown> {
    if (!this.httpSession) {
      throw new Error(`MCPAdapter[${this.config.id}]: HTTP session not initialized`);
    }

    const url = `${this.httpSession.baseUrl}/rpc`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add OAuth token if available
    if (this.httpSession.accessToken) {
      headers['Authorization'] = `Bearer ${this.httpSession.accessToken}`;
    }

    // clearTimeout in finally (not before response.json()) so the abort timer also
    // covers the body read — a server that stalls the body after 200 OK is aborted
    // at CALL_TIMEOUT_MS instead of hanging the call forever.
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method,
          params,
        }),
        signal: controller.signal,
      });

      // The token minted at connect() may have expired (refreshOAuthToken was
      // otherwise never called). On a 401, refresh once and retry the call.
      if (response.status === 401 && this.oauthClient && !isRetry) {
        log.info({ serverId: this.config.id }, 'HTTP RPC 401 — refreshing OAuth token and retrying once');
        await this.refreshOAuthToken();
        return this._httpRpc(method, params, true);
      }

      if (!response.ok) {
        throw new Error(`HTTP RPC failed: HTTP ${response.status}`);
      }

      const data = await response.json() as JsonRpcResponse;

      if (data.error) {
        throw new Error(`MCP RPC error [${data.error.code}]: ${data.error.message}`);
      }

      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Disconnection
  // -------------------------------------------------------------------------

  /** Gracefully close the MCP server connection. */
  async disconnect(): Promise<void> {
    log.info({ serverId: this.config.id }, 'Disconnecting MCP server');

    // Best-effort shutdown notification.
    try {
      this._notify('notifications/shutdown', {});
    } catch {
      // Ignore — may already be disconnected.
    }

    // Close based on transport type
    switch (this.config.transport) {
      case 'stdio':
        if (this.process) {
          this.process.kill('SIGTERM');
          this.process = null;
        }
        break;
      case 'sse':
        if (this.sseTransport) {
          this.sseTransport.disconnect();
          this.sseTransport = null;
        }
        break;
      case 'websocket':
        if (this.wsTransport) {
          this.wsTransport.disconnect();
          this.wsTransport = null;
        }
        break;
      case 'http':
        this.httpSession = null;
        break;
    }

    // Reset session state so a later reconnect on this instance re-handshakes
    // exactly once (the 'open' re-handshake listener is gated on _initialized).
    this._initialized = false;
    this.sseAccessToken = null;
    this.lineBuffer = '';

    this._rejectAll(new Error('MCP adapter disconnected'));
    log.info({ serverId: this.config.id }, 'MCP server disconnected');
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get serverId(): string {
    return this.config.id;
  }

  /** Return cached tool list. Call listTools() first to populate. */
  getCachedTools(): MCPToolDef[] {
    return [...this.tools];
  }

  /** Get current connection state */
  isConnected(): boolean {
    switch (this.config.transport) {
      case 'stdio':
        return this.process !== null;
      case 'sse':
        return this.sseTransport?.isConnected() ?? false;
      case 'websocket':
        return this.wsTransport?.isConnected() ?? false;
      case 'http':
        return this.httpSession !== null;
      default:
        return false;
    }
  }

  /** Refresh OAuth token (for HTTP/SSE/WS transports) */
  async refreshOAuthToken(): Promise<string | null> {
    if (!this.oauthClient) {
      return null;
    }
    const token = await this.oauthClient.getAccessToken(true);
    if (token) {
      // Update transport tokens
      if (this.httpSession) {
        this.httpSession.accessToken = token;
      }
      // Outbound SSE return channel (_sendViaHttpPost) reads this field.
      this.sseAccessToken = token;
      if (this.sseTransport) {
        this.sseTransport.setAccessToken(token);
      }
      if (this.wsTransport) {
        this.wsTransport.setAccessToken(token);
      }
    }
    return token;
  }

  // -------------------------------------------------------------------------
  // Private: JSON-RPC transport
  // -------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request and wait for the matching response.
   * Rejects after CALL_TIMEOUT_MS.
   */
  private _rpc(method: string, params: unknown): Promise<unknown> {
    // HTTP is request/response — _send() can never answer, so every _rpc
    // caller (initialize, tools/list, tools/call fallback) dead-ended on the
    // http transport with "_send not used for HTTP transport". Delegate.
    if (this.config.transport === 'http') {
      return this._httpRpc(method, params);
    }
    const id = randomUUID();

    const isConnect = method === 'initialize';
    const timeoutMs = isConnect ? CONNECT_TIMEOUT_MS : CALL_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP RPC timeout: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      // _send can throw synchronously (null stdin/wsTransport) — clean up the
      // timer + pending entry so they don't linger for the full timeout window.
      try {
        this._send(request);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  private _notify(method: string, params: unknown): void {
    // Per JSON-RPC 2.0, a notification MUST NOT include an `id` member.
    this._send({ jsonrpc: '2.0', method, params });
  }

  /** Serialise and send a JSON-RPC message based on transport type. */
  private _send(message: JsonRpcRequest): void {
    const line = JSON.stringify(message) + '\n';

    switch (this.config.transport) {
      case 'stdio':
        if (!this.process?.stdin) {
          throw new Error(`MCPAdapter[${this.config.id}]: process stdin unavailable`);
        }
        this.process.stdin.write(line);
        break;
      case 'sse':
        // SSE is receive-only; for sending we need a separate HTTP POST endpoint
        // This is a limitation - SSE transport needs a return channel
        // For now, we'll use a simple fetch to the base URL + /message endpoint
        if (!this.config.baseUrl) {
          throw new Error(`MCPAdapter[${this.config.id}]: baseUrl required for SSE send`);
        }
        this._sendViaHttpPost(line).catch((err) => {
          log.error({ serverId: this.config.id, err: err.message }, 'Failed to send over SSE return channel');
        });
        break;
      case 'websocket':
        if (!this.wsTransport) {
          throw new Error(`MCPAdapter[${this.config.id}]: WebSocket not connected`);
        }
        this.wsTransport.send(line);
        break;
      case 'http':
        // HTTP is request/response, not used for _send (uses _httpRpc directly)
        throw new Error(`MCPAdapter[${this.config.id}]: _send not used for HTTP transport`);
      default:
        throw new Error(`MCPAdapter[${this.config.id}]: unknown transport ${this.config.transport}`);
    }
  }

  /** Send a message via HTTP POST (used as return channel for SSE) */
  private async _sendViaHttpPost(data: string): Promise<void> {
    if (!this.config.baseUrl) {
      throw new Error('baseUrl required');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // OAuth/SSE has neither config.accessToken nor httpSession — fall back to the
    // token captured in _connectSse so outbound frames carry an Authorization header.
    const token = this.config.accessToken ?? this.httpSession?.accessToken ?? this.sseAccessToken ?? undefined;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Bound the fetch — without a timeout a /message endpoint that accepts then
    // never responds leaks the connection (this promise is fire-and-forget).
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    try {
      await fetch(`${this.config.baseUrl}/message`, {
        method: 'POST',
        headers,
        body: data,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  // -------------------------------------------------------------------------
  // Private: stdout parsing
  // -------------------------------------------------------------------------

  /** Accumulate stdout chunks and dispatch complete JSON lines. */
  private _handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    // Keep the last (possibly incomplete) fragment.
    this.lineBuffer = lines.pop() ?? '';

    // A server that streams megabytes without ever emitting a newline would grow
    // lineBuffer without bound → OOM. Cap the incomplete fragment: drop the
    // connection rather than accumulate forever.
    if (this.lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      log.error(
        { serverId: this.config.id, bufferLen: this.lineBuffer.length },
        'MCP stdout line buffer exceeded cap — dropping connection',
      );
      this.lineBuffer = '';
      this.process?.kill('SIGTERM');
      this._rejectAll(new Error('MCP stdout line buffer exceeded cap'));
      return;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this._dispatchLine(trimmed);
    }
  }

  /** Parse a single JSON line and resolve the matching pending request. */
  private _dispatchLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      log.warn({ serverId: this.config.id, line }, 'Non-JSON line from MCP server — ignoring');
      return;
    }

    if (!msg.id) {
      // Server notification or event — no pending request to resolve.
      log.debug({ serverId: this.config.id, msg }, 'MCP server notification received');
      return;
    }

    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      log.warn({ serverId: this.config.id, id: msg.id }, 'No pending request for MCP response id');
      return;
    }

    this.pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.reject(
        new Error(
          `MCP RPC error [${msg.error.code}]: ${msg.error.message}`,
        ),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  private _assertConnected(): void {
    if (!this.isConnected()) {
      throw new Error(
        `MCPAdapter[${this.config.id}] is not connected. Call connect() first.`,
      );
    }
  }

  /** Reject every pending request with a given error (on crash / disconnect). */
  private _rejectAll(err: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTPMCPAdapter — helpers
// ---------------------------------------------------------------------------

/** Maximum response body size accepted from a peer MCP server (10 MB). */
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Read a fetch Response body up to `cap` bytes, then throw if exceeded.
 * Prevents OOM from malicious or runaway peer responses.
 */
async function readBodyCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('HTTPMCPAdapter: no response body');
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`HTTPMCPAdapter: response body exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Regex matching private/loopback IPv4 and IPv6 address ranges (SSRF protection). */
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{0,2}:|0\.0\.0\.0|::ffff:127\.|::ffff:0?\.|::ffff:7f|localhost$)/i;

// ---------------------------------------------------------------------------
// HTTPMCPAdapter
// ---------------------------------------------------------------------------

/**
 * HTTP transport implementation of the MCP adapter.
 *
 * Communicates with an MCP-compatible HTTP server using JSON-RPC 2.0 POST
 * requests to `${baseUrl}/rpc`. Structurally duck-type compatible with
 * {@link MCPAdapter} so it can be passed to {@link ToolRegistry.registerMCPSource}.
 */
export class HTTPMCPAdapter {
  private tools: MCPToolDef[] = [];

  constructor(
    private readonly config: MCPServerConfig & { transport: 'http'; baseUrl: string },
  ) {
    if (!config.id || typeof config.id !== 'string') {
      throw new Error('HTTPMCPAdapter: config.id must be a non-empty string');
    }
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      throw new Error('HTTPMCPAdapter: config.baseUrl must be a non-empty string');
    }
    // SSRF protection: reject non-http(s) protocols and private/loopback addresses.
    const parsed = new URL(config.baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `HTTPMCPAdapter: unsupported protocol ${parsed.protocol} (must be http or https)`,
      );
    }
    const allowPrivate = process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] === '1';
    // Strip IPv6 brackets that Node's URL parser preserves (e.g. "[::1]" → "::1").
    const host = parsed.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');
    if (!allowPrivate && host === 'localhost') {
      throw new Error('MCP HTTP transport: localhost hostname not permitted (SSRF guard)');
    }
    if (!allowPrivate && PRIVATE_IP_RE.test(host)) {
      throw new Error(
        `HTTPMCPAdapter: private/loopback baseUrl rejected (SSRF protection). Set SUDO_MCP_ALLOW_PRIVATE_HOSTS=1 for dev.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Duck-type stubs for MCPAdapter compatibility
  // -------------------------------------------------------------------------

  /**
   * No-op for HTTP transport — there is no persistent connection to establish.
   * Included for structural compatibility with MCPAdapter.
   */
  async connect(): Promise<void> {
    log.debug({ serverId: this.config.id }, 'HTTPMCPAdapter.connect() is a no-op for HTTP transport');
  }

  /**
   * No-op for HTTP transport — there is no persistent connection to close.
   * Included for structural compatibility with MCPAdapter.
   */
  async disconnect(): Promise<void> {
    log.debug({ serverId: this.config.id }, 'HTTPMCPAdapter.disconnect() is a no-op for HTTP transport');
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Server identifier as configured. */
  get serverId(): string {
    return this.config.id;
  }

  /** Return cached tool list. Call listTools() first to populate. */
  getCachedTools(): MCPToolDef[] {
    return [...this.tools];
  }

  // -------------------------------------------------------------------------
  // Tool discovery
  // -------------------------------------------------------------------------

  /**
   * Request the list of tools from the remote MCP HTTP server.
   *
   * Sends a JSON-RPC 2.0 `tools/list` request to `${baseUrl}/rpc`.
   * Results are cached internally and returned with `serverId` set.
   *
   * @throws {Error} on network failure, timeout, or JSON-RPC error response.
   */
  async listTools(): Promise<MCPToolDef[]> {
    const url = `${this.config.baseUrl}/rpc`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    log.debug({ serverId: this.config.id, url }, 'HTTPMCPAdapter: listing tools');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `HTTPMCPAdapter[${this.config.id}]: HTTP ${response.status} from ${url}`,
        );
      }

      const bodyText = await readBodyCapped(response, MAX_BODY_BYTES);
      const data = JSON.parse(bodyText) as {
        jsonrpc: string;
        id: number;
        result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
        error?: { code: number; message: string };
      };

      if (data.error) {
        throw new Error(
          `MCP RPC error [${data.error.code}]: ${data.error.message}`,
        );
      }

      const rawTools = Array.isArray(data.result?.tools) ? data.result!.tools : [];

      const rawToolsArray = Array.isArray(data.result?.tools) ? data.result!.tools : [];

      this.tools = rawToolsArray.map((t) => {
        const fullName = `mcp__${this.config.id}__${t.name}`;
        const enabled = this.config.toolFilter
          ? (this.config.toolFilter[t.name] ?? true)
          : true;

        return {
          name: fullName,
          description: t.description ?? `MCP tool from ${this.config.id}`,
          inputSchema: t.inputSchema ?? {},
          serverId: this.config.id,
          enabled,
        };
      });

      const enabledCount = this.tools.filter(t => t.enabled).length;
      log.info(
        { serverId: this.config.id, toolCount: this.tools.length, enabledCount },
        'HTTPMCPAdapter: tools discovered',
      );

      return this.tools;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ serverId: this.config.id, err: msg }, 'HTTPMCPAdapter: listTools failed');
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Tool invocation
  // -------------------------------------------------------------------------

  /**
   * Invoke a tool on the remote MCP HTTP server.
   *
   * Sends a JSON-RPC 2.0 `tools/call` request to `${baseUrl}/rpc`.
   *
   * @param name - The prefixed tool name (e.g. `mcp__<serverId>__<toolName>`) or
   *               the raw un-prefixed name.
   * @param args - Arguments map for the tool.
   * @throws {Error} on network failure, timeout, or JSON-RPC error response.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string }> {
    // Strip the "mcp__<serverId>__" prefix if the caller passed the full name.
    const prefix = `mcp__${this.config.id}__`;
    const rawName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

    const url = `${this.config.baseUrl}/rpc`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    log.debug({ serverId: this.config.id, tool: rawName, url }, 'HTTPMCPAdapter: calling tool');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: rawName, arguments: args },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `HTTPMCPAdapter[${this.config.id}]: HTTP ${response.status} from ${url}`,
        );
      }

      const bodyText = await readBodyCapped(response, MAX_BODY_BYTES);
      const data = JSON.parse(bodyText) as {
        jsonrpc: string;
        id: number;
        result?: {
          content?: Array<{ type: string; text?: string }> | string;
        };
        error?: { code: number; message: string };
      };

      if (data.error) {
        throw new Error(
          `MCP RPC error [${data.error.code}]: ${data.error.message}`,
        );
      }

      // Normalise various content shapes into a single string — matches stdio path.
      let content = '';
      const resultContent = data.result?.content;
      if (typeof resultContent === 'string') {
        content = resultContent;
      } else if (Array.isArray(resultContent)) {
        content = resultContent
          .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
          .join('\n');
      } else if (data.result !== undefined && data.result !== null) {
        content = JSON.stringify(data.result);
      }

      log.debug({ serverId: this.config.id, tool: rawName }, 'HTTPMCPAdapter: tool call success');

      return { content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ serverId: this.config.id, tool: rawName, err: msg }, 'HTTPMCPAdapter: callTool failed');
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// StreamableHTTPMCPAdapter — spec-compliant remote MCP transport
// ---------------------------------------------------------------------------

/**
 * Extract JSON-RPC messages from a `text/event-stream` body.
 *
 * Streamable HTTP servers may frame the JSON-RPC response for a POST as one
 * or more SSE events (`event: message` / `data: {...}`). Events are split on
 * blank lines; multi-`data:`-line events are joined with newlines per the SSE
 * spec; anything that fails to parse as JSON is skipped (comments,
 * keep-alives). Exported for tests.
 */
export function parseSSEMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (dataLines.length === 0) continue;
    try {
      messages.push(JSON.parse(dataLines.join('\n')));
    } catch {
      /* keep-alive / non-JSON data — skip */
    }
  }
  return messages;
}

/** Configuration for {@link StreamableHTTPMCPAdapter}. */
export interface StreamableHTTPMCPConfig {
  /** Server identifier — becomes the `mcp__<id>__` tool-name prefix. */
  id: string;
  /** Full MCP endpoint URL (the POST target itself, e.g. https://api.githubcopilot.com/mcp/). */
  url: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  accessToken?: string;
  /** Per-tool enable/disable filtering (raw tool names). */
  toolFilter?: Record<string, boolean>;
}

/** MCP protocol revision the Streamable HTTP client offers during initialize. */
const STREAMABLE_HTTP_PROTOCOL_VERSION = '2025-06-18';

/** Bound on tools/list cursor pagination — defensive vs a looping server. */
const MAX_TOOL_PAGES = 20;

/**
 * MCP **Streamable HTTP** transport (spec rev 2025-03-26+), the protocol real
 * remote MCP servers speak — GitHub's `https://api.githubcopilot.com/mcp/`
 * included. Differences from the legacy {@link HTTPMCPAdapter} (a homegrown
 * `POST ${baseUrl}/rpc` convention, kept for backward compatibility):
 *
 *   - JSON-RPC POSTs go to the endpoint URL itself, with
 *     `Accept: application/json, text/event-stream`.
 *   - `initialize` handshake + `notifications/initialized` before use; the
 *     negotiated protocol version is echoed on every subsequent request.
 *   - `Mcp-Session-Id` response header is captured and replayed; disconnect
 *     issues a best-effort HTTP DELETE for the session.
 *   - Responses may arrive SSE-framed; both framings are handled. The body is
 *     read to completion (the spec directs servers to close the stream after
 *     the response message; the request timeout bounds a server that does
 *     not).
 *
 * Duck-type compatible with {@link MCPAdapterLike} so it can be passed to
 * `ToolRegistry.registerMCPSource`. Reuses the module's SSRF guard: non-http(s)
 * protocols and private/loopback hosts are rejected unless
 * SUDO_MCP_ALLOW_PRIVATE_HOSTS=1.
 */
export class StreamableHTTPMCPAdapter {
  private tools: MCPToolDef[] = [];
  private sessionId: string | null = null;
  private negotiatedVersion: string | null = null;
  private connected = false;
  private nextId = 1;

  constructor(private readonly config: StreamableHTTPMCPConfig) {
    if (!config.id || typeof config.id !== 'string') {
      throw new Error('StreamableHTTPMCPAdapter: config.id must be a non-empty string');
    }
    if (!config.url || typeof config.url !== 'string') {
      throw new Error('StreamableHTTPMCPAdapter: config.url must be a non-empty string');
    }
    const parsed = new URL(config.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `StreamableHTTPMCPAdapter: unsupported protocol ${parsed.protocol} (must be http or https)`,
      );
    }
    const allowPrivate = process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] === '1';
    const host = parsed.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');
    if (!allowPrivate && (host === 'localhost' || PRIVATE_IP_RE.test(host))) {
      throw new Error(
        'StreamableHTTPMCPAdapter: private/loopback url rejected (SSRF protection). Set SUDO_MCP_ALLOW_PRIVATE_HOSTS=1 for dev.',
      );
    }
  }

  get serverId(): string {
    return this.config.id;
  }

  getCachedTools(): MCPToolDef[] {
    return [...this.tools];
  }

  private _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.config.accessToken) headers['Authorization'] = `Bearer ${this.config.accessToken}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.negotiatedVersion) headers['MCP-Protocol-Version'] = this.negotiatedVersion;
    return headers;
  }

  /**
   * POST one JSON-RPC request and return its result. Handles both plain-JSON
   * and SSE-framed response bodies; captures `Mcp-Session-Id`. A notification
   * (no `id`) resolves to null on 2xx without reading a response message.
   */
  private async _rpc(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs: number; notification?: boolean },
  ): Promise<unknown> {
    const id = opts.notification ? undefined : this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
        signal: controller.signal,
        // A redirect to a private host would bypass the constructor-time SSRF
        // check — refuse redirects outright.
        redirect: 'error',
      });

      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;

      if (!response.ok) {
        // Surface the body head — remote servers put the useful error there.
        let detail = '';
        try {
          detail = (await readBodyCapped(response, 4096)).slice(0, 300);
        } catch { /* body unreadable — status alone */ }
        throw new Error(
          `StreamableHTTPMCPAdapter[${this.config.id}]: HTTP ${response.status} from ${method}${detail ? ` — ${detail}` : ''}`,
        );
      }

      if (opts.notification || response.status === 202) return null;

      const bodyText = await readBodyCapped(response, MAX_BODY_BYTES);
      const contentType = response.headers.get('content-type') ?? '';
      const messages = contentType.includes('text/event-stream')
        ? parseSSEMessages(bodyText)
        : [JSON.parse(bodyText)];

      // Find the response to OUR request; the stream may interleave
      // server-initiated notifications.
      const reply = messages.find(
        (m): m is { id: unknown; result?: unknown; error?: { code: number; message: string } } =>
          typeof m === 'object' && m !== null && (m as { id?: unknown }).id === id,
      );
      if (!reply) {
        throw new Error(
          `StreamableHTTPMCPAdapter[${this.config.id}]: no response for ${method} (id ${id}) in ${messages.length} message(s)`,
        );
      }
      if (reply.error) {
        throw new Error(`MCP RPC error [${reply.error.code}]: ${reply.error.message}`);
      }
      return reply.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform the initialize handshake; idempotent once connected. */
  async connect(): Promise<void> {
    if (this.connected) return;
    const result = (await this._rpc(
      'initialize',
      {
        protocolVersion: STREAMABLE_HTTP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'sudo-ai', version: '1.0' },
      },
      { timeoutMs: 15_000 },
    )) as { protocolVersion?: string } | null;
    this.negotiatedVersion = result?.protocolVersion ?? STREAMABLE_HTTP_PROTOCOL_VERSION;
    await this._rpc('notifications/initialized', {}, { timeoutMs: 15_000, notification: true });
    this.connected = true;
    log.info(
      { serverId: this.config.id, protocolVersion: this.negotiatedVersion, session: !!this.sessionId },
      'StreamableHTTPMCPAdapter: connected',
    );
  }

  /** Best-effort session teardown (HTTP DELETE); never throws. */
  async disconnect(): Promise<void> {
    this.connected = false;
    if (!this.sessionId) return;
    try {
      await fetch(this.config.url, {
        method: 'DELETE',
        headers: this._headers(),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
    } catch {
      /* servers without session support answer 405 or drop — fine */
    }
    this.sessionId = null;
  }

  private _assertConnected(): void {
    if (!this.connected) {
      throw new Error(`StreamableHTTPMCPAdapter[${this.config.id}]: not connected — call connect() first`);
    }
  }

  /** List tools, following cursor pagination (bounded). */
  async listTools(): Promise<MCPToolDef[]> {
    this._assertConnected();
    const raw: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = (await this._rpc(
        'tools/list',
        cursor ? { cursor } : {},
        { timeoutMs: 15_000 },
      )) as { tools?: typeof raw; nextCursor?: string } | null;
      raw.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
      if (!cursor) break;
    }

    this.tools = raw.map((t) => ({
      name: `mcp__${this.config.id}__${t.name}`,
      description: t.description ?? `MCP tool from ${this.config.id}`,
      inputSchema: t.inputSchema ?? {},
      serverId: this.config.id,
      enabled: this.config.toolFilter ? (this.config.toolFilter[t.name] ?? true) : true,
    }));

    log.info(
      { serverId: this.config.id, toolCount: this.tools.length },
      'StreamableHTTPMCPAdapter: tools discovered',
    );
    return this.tools;
  }

  /** Invoke a tool; accepts prefixed or raw names. Content normalization matches the other adapters. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }> {
    this._assertConnected();
    const prefix = `mcp__${this.config.id}__`;
    const rawName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

    const result = (await this._rpc(
      'tools/call',
      { name: rawName, arguments: args },
      { timeoutMs: 30_000 },
    )) as { content?: Array<{ type: string; text?: string }> | string; isError?: boolean } | null;

    let content = '';
    const resultContent = result?.content;
    if (typeof resultContent === 'string') {
      content = resultContent;
    } else if (Array.isArray(resultContent)) {
      content = resultContent
        .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
        .join('\n');
    } else if (result !== undefined && result !== null) {
      content = JSON.stringify(result);
    }
    // Spec: tool-level failures come back as result.isError=true, not JSON-RPC
    // errors. Surface them as throws so ToolResult.success is false upstream.
    if (result?.isError === true) {
      throw new Error(content || `MCP tool ${rawName} reported an error`);
    }
    return { content };
  }
}
