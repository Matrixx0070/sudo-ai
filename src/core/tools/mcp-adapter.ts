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
  /** Additional environment variables for the child process. */
  env?: Record<string, string>;
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
  inputSchema: object;
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
  id: string;
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
      ...this.config.env,
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

    this.process.on('error', (err) => {
      log.error({ serverId: this.config.id, err: err.message }, 'MCP process error');
      this._rejectAll(err);
    });

    this.process.on('exit', (code, signal) => {
      log.info({ serverId: this.config.id, code, signal }, 'MCP process exited');
      this._rejectAll(new Error(`MCP server exited unexpectedly (code=${code}, signal=${signal})`));
    });

    // Send initialize handshake.
    await this._rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sudo-ai', version: '5.0.0' },
    });

    // Notify the server that initialization is done.
    this._notify('notifications/initialized', {});
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

    await this.sseTransport.connect();

    // Send initialize handshake over SSE
    await this._rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sudo-ai', version: '5.0.0' },
    });

    this._notify('notifications/initialized', {});
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

    await this.wsTransport.connect();

    // Send initialize handshake over WebSocket
    await this._rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sudo-ai', version: '5.0.0' },
    });

    this._notify('notifications/initialized', {});
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
      tools?: Array<{ name: string; description?: string; inputSchema?: object }>;
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
  private async _httpRpc(method: string, params: unknown): Promise<unknown> {
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

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP RPC failed: HTTP ${response.status}`);
      }

      const data = await response.json() as JsonRpcResponse;

      if (data.error) {
        throw new Error(`MCP RPC error [${data.error.code}]: ${data.error.message}`);
      }

      return data.result;
    } catch (err) {
      clearTimeout(timer);
      throw err;
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
      this._send(request);
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  private _notify(method: string, params: unknown): void {
    this._send({ jsonrpc: '2.0', id: randomUUID(), method, params } as JsonRpcRequest);
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

    if (this.config.accessToken) {
      headers['Authorization'] = `Bearer ${this.config.accessToken}`;
    } else if (this.httpSession?.accessToken) {
      headers['Authorization'] = `Bearer ${this.httpSession.accessToken}`;
    }

    await fetch(`${this.config.baseUrl}/message`, {
      method: 'POST',
      headers,
      body: data,
    });
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
        result?: { tools?: Array<{ name: string; description?: string; inputSchema?: object }> };
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
