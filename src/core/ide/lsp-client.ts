/**
 * @file ide/lsp-client.ts
 * @description Language Server Protocol client connection management.
 *
 * Manages LSP client connections to language servers, including lifecycle
 * (start, initialize, ready, stop), auto-restart, and diagnostics collection.
 *
 * Note: This module provides the connection management layer. Actual LSP
 * protocol communication uses JSON-RPC over stdio (the most common transport
 * for language servers). The implementation uses Node.js child_process for
 * spawning language server processes.
 *
 * Competitive context: Claude Code has an LSP tool and lspRecommendation
 * system. This module provides SUDO-AI's equivalent LSP client management.
 *
 * @module lsp-client
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../shared/logger.js';
import type {
  DiscoveredLSP,
  LSPClientConfig,
  LSPConnectionState,
  LSPConnectionStatus,
  LSPDiagnostic,
} from './types.js';

const log = createLogger('ide:lsp-client');

// ---------------------------------------------------------------------------
// LSP Protocol Types (subset for client management)
// ---------------------------------------------------------------------------

interface LSPRequestMessage {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface LSPResponseMessage {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface LSPNotificationMessage {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LSP Client
// ---------------------------------------------------------------------------

/**
 * Manages a connection to a single language server.
 *
 * Handles spawning the server process, sending initialize/handshake messages,
 * collecting diagnostics, and managing the lifecycle (including auto-restart).
 */
export class LSPClient {
  private config: LSPClientConfig &
    Required<Pick<LSPClientConfig, 'connectionTimeoutMs' | 'autoRestart' | 'maxRestartAttempts'>>;
  private process: ChildProcess | null = null;
  private state: LSPConnectionState = 'disconnected';
  private messageId = 0;
  private restartCount = 0;
  private connectedAt: string | undefined;
  private lastError: string | undefined;
  private capabilities: Record<string, unknown> | undefined;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private diagnostics: LSPDiagnostic[] = [];
  private buffer = '';
  private contentLength = -1;

  /** Event handlers keyed by event type. */
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();

  constructor(config: LSPClientConfig) {
    this.config = {
      connectionTimeoutMs: 10_000,
      autoRestart: true,
      maxRestartAttempts: 3,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to the language server by spawning its process.
   *
   * Sends the LSP initialize request after the process starts.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'initializing' || this.state === 'ready') {
      log.debug({ serverId: this.config.server.id }, 'Already connected');
      return;
    }

    this.setState('connecting');
    log.info({ serverId: this.config.server.id, command: this.config.server.command }, 'Connecting to LSP server');

    try {
      const args = this.config.server.args ?? [];
      this.process = spawn(this.config.server.command, args, {
        cwd: new URL(this.config.rootUri).pathname || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Ensure language servers use stdio protocol
          NODE_OPTIONS: undefined,
        },
      });

      this.process.on('error', (err) => {
        log.error({ serverId: this.config.server.id, err: String(err) }, 'LSP process error');
        this.lastError = String(err);
        this.setState('error');
        this.emit('error', err);
      });

      this.process.on('exit', (code, signal) => {
        log.info(
          { serverId: this.config.server.id, code, signal },
          'LSP process exited',
        );
        if (this.state !== 'stopped' && this.state !== 'error') {
          this.lastError = `Process exited with code ${code}, signal ${signal}`;
          this.setState('disconnected');
          if (this.config.autoRestart && this.restartCount < this.config.maxRestartAttempts) {
            this.restartCount++;
            log.info(
              { serverId: this.config.server.id, attempt: this.restartCount },
              'Auto-restarting LSP server',
            );
            this.connect().catch((err) => {
              log.error({ err: String(err) }, 'LSP auto-restart failed');
            });
          }
        }
      });

      // Set up stdout for LSP messages (Content-Length header + JSON-RPC body)
      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      // Capture stderr for logging
      this.process.stderr?.on('data', (data: Buffer) => {
        log.debug(
          { serverId: this.config.server.id, stderr: data.toString().trim() },
          'LSP stderr',
        );
      });

      this.setState('connected');

      // Send initialize request
      await this.initialize();
    } catch (err) {
      this.lastError = String(err);
      this.setState('error');
      throw err;
    }
  }

  /**
   * Send the LSP initialize request.
   */
  private async initialize(): Promise<void> {
    this.setState('initializing');

    const initParams = {
      processId: process.pid,
      rootUri: this.config.rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: true, willSaveWaitUntil: true, didSave: true },
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {},
          definition: { linkSupport: true },
          references: {},
          documentHighlight: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          formatting: {},
          rangeFormatting: {},
          onTypeFormatting: {},
          rename: {},
          publishDiagnostics: { relatedInformation: true },
          codeLens: {},
          foldingRange: {},
          selectionRange: {},
        },
        workspace: {
          workspaceFolders: { supported: true },
          symbol: {},
          configuration: true,
        },
      },
      ...this.config.initOptions,
    };

    try {
      const result = await this.sendRequest('initialize', initParams);
      this.capabilities = result as Record<string, unknown>;
      this.setState('ready');
      this.connectedAt = new Date().toISOString();
      log.info(
        { serverId: this.config.server.id },
        'LSP server initialized and ready',
      );

      // Send initialized notification
      this.sendNotification('initialized', {});
    } catch (err) {
      this.lastError = String(err);
      this.setState('error');
      log.error(
        { serverId: this.config.server.id, err: String(err) },
        'LSP initialize failed',
      );
    }
  }

  /**
   * Disconnect from the language server.
   */
  async disconnect(): Promise<void> {
    this.setState('stopped');

    // Clear pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    if (this.process && !this.process.killed) {
      try {
        // Send shutdown request
        await this.sendRequest('shutdown', undefined).catch(() => {
          // Ignore shutdown errors
        });
        this.sendNotification('exit', undefined);
      } catch {
        // Ignore
      }

      this.process.kill('SIGTERM');
      this.process = null;
    }

    log.info({ serverId: this.config.server.id }, 'LSP client disconnected');
  }

  // -------------------------------------------------------------------------
  // LSP Message Handling
  // -------------------------------------------------------------------------

  /**
   * Handle raw data from the language server stdout.
   * Parses LSP base protocol (Content-Length header + JSON-RPC body).
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString('utf8');

    // Parse LSP base protocol messages
    while (this.buffer.length > 0) {
      // Look for Content-Length header
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break; // Need more data

        const headerBlock = this.buffer.substring(0, headerEnd);
        const contentLengthMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
        if (!contentLengthMatch) {
          // Invalid header — discard
          this.buffer = this.buffer.substring(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(contentLengthMatch[1]!, 10);
        this.buffer = this.buffer.substring(headerEnd + 4);
      }

      // Check if we have the full body
      if (this.buffer.length < this.contentLength) break; // Need more data

      const body = this.buffer.substring(0, this.contentLength);
      this.buffer = this.buffer.substring(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch (err) {
        log.debug({ err: String(err), body: body.substring(0, 200) }, 'Failed to parse LSP message');
      }
    }
  }

  /**
   * Handle a parsed LSP message.
   */
  private handleMessage(message: Record<string, unknown>): void {
    if ('id' in message && 'method' in message) {
      // Server request (unusual but possible)
      log.debug({ id: message.id, method: message.method }, 'LSP server request');
    } else if ('id' in message) {
      // Response to our request
      const id = message.id as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result ?? {});
        }
      }
    } else if ('method' in message) {
      // Notification from server
      this.handleNotification(message.method as string, message.params as Record<string, unknown>);
    }
  }

  /**
   * Handle a notification from the language server.
   */
  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'textDocument/publishDiagnostics') {
      const uri = params.uri as string;
      const diagnostics = (params.diagnostics as Array<Record<string, unknown>>) ?? [];
      this.diagnostics = diagnostics.map((d) => ({
        uri,
        severity: this.mapDiagnosticSeverity(d.severity as number),
        line: ((d.range as Record<string, unknown>)?.start as Record<string, unknown>)?.line as number ?? 0,
        character: ((d.range as Record<string, unknown>)?.start as Record<string, unknown>)?.character as number ?? 0,
        endLine: ((d.range as Record<string, unknown>)?.end as Record<string, unknown>)?.line as number,
        endCharacter: ((d.range as Record<string, unknown>)?.end as Record<string, unknown>)?.character as number,
        message: d.message as string,
        source: d.source as string | undefined,
        code: d.code as string | number | undefined,
      }));
      this.emit('diagnostics', { uri, diagnostics: this.diagnostics });
    }

    // Forward all notifications to handlers
    this.emit(method, params);
  }

  /**
   * Map LSP DiagnosticSeverity number to string.
   */
  private mapDiagnosticSeverity(severity: number): LSPDiagnostic['severity'] {
    switch (severity) {
      case 1: return 'error';
      case 2: return 'warning';
      case 3: return 'information';
      case 4: return 'hint';
      default: return 'information';
    }
  }

  // -------------------------------------------------------------------------
  // Message Sending
  // -------------------------------------------------------------------------

  /**
   * Send an LSP request and wait for a response.
   */
  sendRequest(method: string, params?: Record<string, unknown> | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('LSP server not connected'));
        return;
      }

      const id = ++this.messageId;
      const message: LSPRequestMessage = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };

      const body = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, this.config.connectionTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.process.stdin.write(header + body, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send an LSP notification (no response expected).
   */
  sendNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (!this.process?.stdin?.writable) {
      log.warn('LSP server not connected — notification dropped');
      return;
    }

    const message: LSPNotificationMessage = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;

    this.process.stdin.write(header + body, 'utf8');
  }

  // -------------------------------------------------------------------------
  // Event System
  // -------------------------------------------------------------------------

  /**
   * Register an event handler.
   */
  on(event: string, handler: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Remove an event handler.
   */
  off(event: string, handler: (data: unknown) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event.
   */
  private emit(event: string, data: unknown): void {
    this.eventHandlers.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        log.error({ event, err: String(err) }, 'LSP event handler error');
      }
    });
  }

  // -------------------------------------------------------------------------
  // State Management
  // -------------------------------------------------------------------------

  private setState(state: LSPConnectionState): void {
    const oldState = this.state;
    this.state = state;
    if (oldState !== state) {
      log.debug(
        { serverId: this.config.server.id, from: oldState, to: state },
        'LSP state changed',
      );
      this.emit('stateChange', { from: oldState, to: state });
    }
  }

  /**
   * Get the current connection status.
   */
  getStatus(): LSPConnectionStatus {
    return {
      serverId: this.config.server.id,
      state: this.state,
      restartCount: this.restartCount,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      capabilities: this.capabilities,
    };
  }

  /**
   * Get the current diagnostics.
   */
  getDiagnostics(): LSPDiagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * Get the server configuration.
   */
  getServer(): DiscoveredLSP {
    return this.config.server;
  }
}

// ---------------------------------------------------------------------------
// LSP Client Manager
// ---------------------------------------------------------------------------

/**
 * Manages multiple LSP client connections.
 *
 * Handles connection pooling, lifecycle management, and
 * routing diagnostics to the appropriate consumers.
 */
export class LSPClientManager {
  private clients = new Map<string, LSPClient>();
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();

  /**
   * Connect to a language server.
   */
  async connect(server: DiscoveredLSP, rootUri: string, options?: {
    initOptions?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  }): Promise<LSPClient> {
    // Check if already connected
    const existing = this.clients.get(server.id);
    if (existing) {
      const status = existing.getStatus();
      if (status.state === 'ready' || status.state === 'connected') {
        return existing;
      }
    }

    const config: LSPClientConfig = {
      server,
      rootUri,
      initOptions: options?.initOptions,
      settings: options?.settings,
      connectionTimeoutMs: 10_000,
      autoRestart: true,
      maxRestartAttempts: 3,
    };

    const client = new LSPClient(config);

    // Forward events
    client.on('diagnostics', (data) => this.emit('diagnostics', data));
    client.on('stateChange', (data) => this.emit('stateChange', data));
    client.on('error', (data) => this.emit('error', data));

    this.clients.set(server.id, client);
    await client.connect();

    return client;
  }

  /**
   * Disconnect a specific language server.
   */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      await client.disconnect();
      this.clients.delete(serverId);
    }
  }

  /**
   * Disconnect all language servers.
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.clients.values()).map((client) =>
      client.disconnect(),
    );
    await Promise.all(promises);
    this.clients.clear();
  }

  /**
   * Get a connected client by server ID.
   */
  getClient(serverId: string): LSPClient | undefined {
    return this.clients.get(serverId);
  }

  /**
   * Get all connected clients.
   */
  getConnectedClients(): LSPClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get all diagnostics from all connected servers.
   */
  getAllDiagnostics(): Map<string, LSPDiagnostic[]> {
    const allDiags = new Map<string, LSPDiagnostic[]>();
    for (const [id, client] of this.clients) {
      const diags = client.getDiagnostics();
      if (diags.length > 0) {
        allDiags.set(id, diags);
      }
    }
    return allDiags;
  }

  /**
   * Get the status of all connected servers.
   */
  getAllStatus(): LSPConnectionStatus[] {
    return Array.from(this.clients.values()).map((client) => client.getStatus());
  }

  // -------------------------------------------------------------------------
  // Event System
  // -------------------------------------------------------------------------

  on(event: string, handler: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: unknown): void {
    this.eventHandlers.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        log.error({ event, err: String(err) }, 'LSP manager event handler error');
      }
    });
  }
}

/** Singleton LSP client manager. */
export const lspClientManager = new LSPClientManager();