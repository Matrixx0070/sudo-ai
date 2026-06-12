/**
 * @file bridge-adapter.ts
 * @description IDE Bridge adapter — implements ChannelAdapter for IDE extension communication.
 *
 * Provides WebSocket connectivity at `/ide/bridge` on the existing gateway server,
 * following the same `attach()` pattern as WebAdapter. Manages connections,
 * authentication, heartbeat, and message dispatch.
 *
 * @module ide-bridge-adapter
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../shared/logger.js';
import type { ChannelType, MessageHandler, SendOptions } from '../channels/types.js';
import type { BridgeRouterDeps, BridgeConfig, BridgeConnection, BridgeMethodHandler } from './bridge-types.js';
import { DEFAULT_BRIDGE_CONFIG } from './bridge-types.js';
import { verifyGatewayToken, getServerEpoch } from './bridge-auth.js';
import { createConnection, cleanupConnection, startHeartbeatMonitor, recordHeartbeat, rejectAllPendingApprovals } from './bridge-session.js';
import { BridgeDiscovery } from './bridge-discovery.js';
import { buildBridgeRouter, dispatchMessage } from './bridge-protocol.js';
import type {
  BridgeClientMessage,
  BridgeMethod,
  BridgeServerEvent,
  BridgeServerResponse,
  BridgeErrorCodeType,
} from '../../../shared-types/bridge-protocol.js';
import { BridgeErrorCode, BRIDGE_PROTOCOL_VERSION } from '../../../shared-types/bridge-protocol.js';

const log = createLogger('ide:bridge-adapter');

// ---------------------------------------------------------------------------
// IdeBridgeAdapter
// ---------------------------------------------------------------------------

/**
 * IDE Bridge adapter — connects IDE extensions (VS Code, JetBrains) to SUDO-AI
 * via a WebSocket protocol at `/ide/bridge`.
 *
 * Implements ChannelAdapter so it integrates with the existing MessageRouter
 * and receives inbound IDE messages as UnifiedMessage with `channel: 'ide'`.
 */
export class IdeBridgeAdapter {
  readonly channel: ChannelType = 'ide';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private readonly connections = new Map<string, BridgeConnection>();
  private readonly deps: BridgeRouterDeps;
  private readonly config: Required<Omit<BridgeConfig, 'gatewayToken'>> & { gatewayToken: string };
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private discovery: BridgeDiscovery;
  private router: Map<BridgeMethod, BridgeMethodHandler> | null = null;
  private heartbeatCleanups = new Map<string, () => void>();

  constructor(deps: BridgeRouterDeps, config?: BridgeConfig) {
    this.deps = deps;

    const gatewayToken = config?.gatewayToken ?? process.env['GATEWAY_TOKEN'] ?? '';

    this.config = {
      gatewayToken,
      jwtTtlMs: config?.jwtTtlMs ?? DEFAULT_BRIDGE_CONFIG.jwtTtlMs,
      heartbeatIntervalMs: config?.heartbeatIntervalMs ?? DEFAULT_BRIDGE_CONFIG.heartbeatIntervalMs,
      heartbeatTimeoutMs: config?.heartbeatTimeoutMs ?? DEFAULT_BRIDGE_CONFIG.heartbeatTimeoutMs,
      maxPayloadBytes: config?.maxPayloadBytes ?? DEFAULT_BRIDGE_CONFIG.maxPayloadBytes,
      path: config?.path ?? DEFAULT_BRIDGE_CONFIG.path,
      portFilePath: config?.portFilePath ?? DEFAULT_BRIDGE_CONFIG.portFilePath,
      mdnsEnabled: config?.mdnsEnabled ?? DEFAULT_BRIDGE_CONFIG.mdnsEnabled,
      disabled: config?.disabled ?? (process.env['SUDO_IDE_BRIDGE_DISABLE'] === '1'),
    };

    this.discovery = new BridgeDiscovery(this.config.portFilePath || undefined);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  // -------------------------------------------------------------------------
  // ChannelAdapter Interface
  // -------------------------------------------------------------------------

  /**
   * Start the bridge adapter. Called by MessageRouter.startAll().
   * For the bridge, actual startup happens in attach(); this is a no-op
   * unless called before attach().
   */
  async start(): Promise<void> {
    if (this._isConnected) return;
    // If we already have an HTTP server attached, just mark as connected
    if (this.wss) {
      this._isConnected = true;
      return;
    }
    // Without an HTTP server, we can't start standalone
    log.warn('IdeBridgeAdapter.start() called without attach(); call attach(httpServer) first');
  }

  /**
   * Stop the bridge adapter. Closes all connections, stops discovery.
   */
  async stop(): Promise<void> {
    if (!this._isConnected) return;

    log.info('Stopping IDE Bridge adapter');

    // Close all connections
    for (const [peerId, connection] of this.connections) {
      cleanupConnection(connection);
      this.connections.delete(peerId);
    }

    // Stop heartbeat monitors
    for (const [peerId, cleanup] of this.heartbeatCleanups) {
      cleanup();
    }
    this.heartbeatCleanups.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Stop discovery
    this.discovery.stop();

    this._isConnected = false;
    log.info('IDE Bridge adapter stopped');
  }

  /**
   * Send a message to a specific IDE client (by peerId).
   * Used by MessageRouter to deliver outbound messages.
   */
  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    const connection = this.connections.get(peerId);
    if (!connection) {
      log.warn({ peerId }, 'Cannot send to unknown bridge connection');
      return;
    }

    if (connection.ws.readyState !== WebSocket.OPEN) {
      log.warn({ peerId, state: connection.ws.readyState }, 'Cannot send to closed connection');
      return;
    }

    const event: BridgeServerEvent = {
      event: 'stream.token',
      data: {
        sessionId: connection.primarySessionId ?? '',
        turnId: 'outbound',
        delta: text,
        index: 0,
      },
    };

    connection.ws.send(JSON.stringify(event));
  }

  /**
   * Register the message handler. Called by MessageRouter.registerAdapter().
   */
  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  // -------------------------------------------------------------------------
  // WebSocket Attachment
  // -------------------------------------------------------------------------

  /**
   * Attach the bridge to an existing HTTP server.
   * Handles WebSocket upgrades on the configured path (default: /ide/bridge).
   *
   * This is the primary startup method — call it after creating the adapter
   * and before the server starts listening.
   */
  attach(httpServer: HttpServer): void {
    if (this.config.disabled) {
      log.info('IDE Bridge disabled (SUDO_IDE_BRIDGE_DISABLE=1)');
      return;
    }

    this.httpServer = httpServer;

    // Create WebSocket server in noServer mode
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.config.maxPayloadBytes,
    });

    // Handle upgrade requests
    httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (url.pathname !== this.config.path) {
        // Not our path — let other WebSocket handlers process it
        return;
      }

      // Verify gateway token
      const token = url.searchParams.get('token');
      if (!verifyGatewayToken(token ?? undefined, this.config.gatewayToken)) {
        log.warn({ ip: request.socket.remoteAddress }, 'Bridge WebSocket upgrade rejected: invalid token');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Hand off to WebSocket server
      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request);
      });
    });

    // Handle new connections
    this.wss.on('connection', (ws, request) => {
      this.handleConnection(ws, request);
    });

    // Build the method router
    this.router = buildBridgeRouter(this.deps, {
      gatewayToken: this.config.gatewayToken,
      jwtTtlMs: this.config.jwtTtlMs,
    }, (event) => this.broadcastEvent(event));

    this._isConnected = true;
    log.info({ path: this.config.path }, 'IDE Bridge adapter attached to HTTP server');
  }

  /**
   * Start discovery (write port file, advertise mDNS).
   * Call after the HTTP server is listening.
   */
  startDiscovery(port: number): void {
    if (this.config.disabled) return;

    const addr = this.httpServer?.address();
    const actualPort = port ?? (typeof addr === 'object' && addr ? addr.port : 18900);

    this.discovery.start({
      version: BRIDGE_PROTOCOL_VERSION,
      url: `http://127.0.0.1:${actualPort}`,
      wsUrl: `ws://127.0.0.1:${actualPort}${this.config.path}`,
      port: actualPort,
      pid: process.pid,
      startedAt: Date.now(),
    }, this.config.mdnsEnabled);
  }

  // -------------------------------------------------------------------------
  // Connection Handling
  // -------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const connection = createConnection(ws);
    this.connections.set(connection.peerId, connection);

    log.info({
      peerId: connection.peerId,
      ip: request.socket.remoteAddress,
    }, 'New bridge WebSocket connection');

    // Start heartbeat monitor
    const cleanupHeartbeat = startHeartbeatMonitor(
      connection,
      this.config.heartbeatIntervalMs,
      this.config.heartbeatTimeoutMs,
      (conn) => this.handleHeartbeatTimeout(conn),
    );
    this.heartbeatCleanups.set(connection.peerId, cleanupHeartbeat);

    // Handle incoming messages
    ws.on('message', (data) => {
      this.handleMessage(data, connection);
    });

    // Handle pong (heartbeat response)
    ws.on('pong', () => {
      recordHeartbeat(connection);
    });

    // Handle close
    ws.on('close', (code, reason) => {
      log.info({ peerId: connection.peerId, code, reason: reason.toString() }, 'Bridge WebSocket closed');
      this.handleDisconnect(connection);
    });

    // Handle error
    ws.on('error', (err) => {
      log.error({ peerId: connection.peerId, err: String(err) }, 'Bridge WebSocket error');
      this.handleDisconnect(connection);
    });
  }

  private async handleMessage(data: unknown, connection: BridgeConnection): Promise<void> {
    // Parse message
    let message: BridgeClientMessage;
    try {
      const raw = typeof data === 'string' ? data : (data as Buffer).toString('utf-8');
      message = JSON.parse(raw);
    } catch {
      this.sendError(connection, '', BridgeErrorCode.PARSE_ERROR, 'Invalid JSON');
      return;
    }

    // Validate structure
    if (!message.id || !message.method) {
      this.sendError(connection, message.id ?? '', BridgeErrorCode.INVALID_REQUEST, 'Missing id or method');
      return;
    }

    // Handle heartbeat inline. 'heartbeat' is an off-protocol wire message:
    // it is not part of the BridgeMethod union, so widen to string at the
    // JSON boundary to compare.
    if ((message.method as string) === 'heartbeat') {
      recordHeartbeat(connection);
      this.sendResponse(connection, { id: message.id, result: { serverTime: Date.now(), epoch: getServerEpoch() } });
      return;
    }

    log.debug({ peerId: connection.peerId, method: message.method }, 'Bridge message received');

    // Dispatch to method handler
    if (this.router) {
      const response = await dispatchMessage(message, connection, this.router, this.deps);
      this.sendResponse(connection, response);
    } else {
      this.sendError(connection, message.id, BridgeErrorCode.INTERNAL_ERROR, 'Router not initialized');
    }
  }

  private handleDisconnect(connection: BridgeConnection): void {
    // Clean up heartbeat monitor
    const cleanup = this.heartbeatCleanups.get(connection.peerId);
    if (cleanup) {
      cleanup();
      this.heartbeatCleanups.delete(connection.peerId);
    }

    // Reject pending approvals
    rejectAllPendingApprovals(connection, 'Connection closed');

    // Remove from connections map
    this.connections.delete(connection.peerId);

    log.info({ peerId: connection.peerId }, 'Bridge connection removed');
  }

  private handleHeartbeatTimeout(connection: BridgeConnection): void {
    log.warn({ peerId: connection.peerId }, 'Bridge connection heartbeat timeout');
    cleanupConnection(connection);
    this.handleDisconnect(connection);
  }

  // -------------------------------------------------------------------------
  // Send Helpers
  // -------------------------------------------------------------------------

  private sendResponse(connection: BridgeConnection, response: BridgeServerResponse): void {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(response));
    }
  }

  private sendError(connection: BridgeConnection, id: string, code: BridgeErrorCodeType, message: string): void {
    this.sendResponse(connection, { id, error: { code, message } });
  }

  private broadcastEvent(event: BridgeServerEvent): void {
    // Broadcast to all connections in 'ready' phase
    // For targeted events (with sessionId), send only to the matching connection
    const data = event.data as Record<string, unknown>;
    const targetSessionId = data?.sessionId as string | undefined;

    for (const [peerId, connection] of this.connections) {
      if (connection.phase !== 'ready') continue;

      // If event targets a specific session, only send to that connection
      if (targetSessionId && connection.primarySessionId !== targetSessionId) {
        // Check multiplexed sessions too
        let found = false;
        for (const [, sid] of connection.sessions) {
          if (sid === targetSessionId) {
            found = true;
            break;
          }
        }
        if (!found) continue;
      }

      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(JSON.stringify(event));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Inbound Message Dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch an inbound IDE message to the MessageHandler (MessageRouter).
   * Converts the raw chat message into a UnifiedMessage.
   */
  private async dispatchInboundMessage(
    connection: BridgeConnection,
    sessionId: string,
    message: string,
  ): Promise<void> {
    if (!this._handler) {
      log.warn('No message handler registered; dropping inbound IDE message');
      return;
    }

    await this._handler({
      id: `bridge-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      channel: 'ide' as ChannelType,
      peerId: connection.peerId,
      peerName: `ide-${connection.peerId.substring(0, 8)}`,
      chatType: 'dm',
      text: message,
      timestamp: new Date(),
    });
  }
}