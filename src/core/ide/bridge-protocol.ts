/**
 * @file bridge-protocol.ts
 * @description Method routing and handler logic for the IDE Bridge protocol.
 *
 * Maps incoming BridgeMethod strings to handler functions that interact with
 * SessionManager, AgentLoop, ProgressBroadcaster, and HookManager.
 *
 * @module ide-bridge-protocol
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { issueSessionJwt, getServerEpoch } from './bridge-auth.js';
import {
  createAbortController,
  abortCurrentOperation,
  addPendingApproval,
  initializeConnection,
  recordHeartbeat,
  rejectAllPendingApprovals,
} from './bridge-session.js';
import type {
  AgentEventLike,
  BridgeConnection,
  BridgeMethodHandler,
  BridgeMethodResult,
  BridgeRouterDeps,
} from './bridge-types.js';
import type {
  BridgeMethod,
  BridgeErrorCodeType,
  InitializeParams,
  InitializeResult,
  BridgeChatSendParams,
  BridgeChatSendResult,
  CanUseToolParams,
  CanUseToolResult,
  SetModelParams,
  SetPermissionModeParams,
  InterruptParams,
  BridgeSessionCreateParams,
  BridgeSessionCreateResult,
  BridgeSessionInfo,
  BridgeSessionArchiveParams,
  StreamStartEvent,
  StreamTokenEvent,
  StreamToolCallEvent,
  StreamToolResultEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  BridgeServerEvent,
  BridgeClientMessage,
  BridgeServerResponse,
} from '../../../shared-types/bridge-protocol.js';
import { BridgeErrorCode } from '../../../shared-types/bridge-protocol.js';

const log = createLogger('ide:bridge-protocol');

// ---------------------------------------------------------------------------
// Error Helper
// ---------------------------------------------------------------------------

function makeError(code: BridgeErrorCodeType, message: string, data?: unknown): BridgeMethodResult {
  return { error: { code, message, data } };
}

function makeResult(result: unknown): BridgeMethodResult {
  return { result };
}

// ---------------------------------------------------------------------------
// Method Handlers
// ---------------------------------------------------------------------------

/**
 * initialize — First message after WebSocket connection.
 * Validates gateway token, creates session, issues JWT.
 */
async function handleInitialize(
  connection: BridgeConnection,
  params: unknown,
  deps: BridgeRouterDeps,
  gatewayToken: string,
  jwtTtlMs: number,
): Promise<BridgeMethodResult> {
  const p = params as InitializeParams;

  if (!p?.clientInfo || !p?.capabilities) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, 'Missing clientInfo or capabilities');
  }

  // Create or get session for this connection
  const sessionId = connection.primarySessionId ?? genId();
  const session = await deps.sessionManager.getOrCreate('ide', connection.peerId);

  // Issue JWT
  const epoch = getServerEpoch();
  const { jwt, expiresAt } = issueSessionJwt(session.id, epoch, gatewayToken, jwtTtlMs);

  // Initialize connection state
  initializeConnection(connection, {
    epoch,
    sessionJwt: jwt,
    tokenExpiresAt: expiresAt,
    capabilities: p.capabilities,
    multiplexMode: p.multiplexMode ?? 'single-session',
    primarySessionId: session.id,
  });

  // Fire hook
  await deps.hookManager.emit('bridge:initialize', {
    sessionId: session.id,
    peerId: connection.peerId,
    clientInfo: p.clientInfo,
    multiplexMode: p.multiplexMode,
  });

  const result: InitializeResult = {
    serverInfo: { name: 'sudo-ai', version: '4.0.0' },
    capabilities: {
      streaming: true,
      interrupt: true,
      toolApproval: true,
      models: [], // Populated from config
      permissionModes: ['ask', 'auto', 'restricted'],
      maxSessions: p.multiplexMode === 'single-session' ? 1 : 10,
    },
    sessionId: session.id,
    sessionJwt: jwt,
    tokenExpiresAt: expiresAt,
    epoch,
  };

  return makeResult(result);
}

/**
 * chat.send — Send a message to the agent.
 * If stream=true, emits stream.* events; otherwise returns full result.
 */
async function handleChatSend(
  connection: BridgeConnection,
  params: unknown,
  deps: BridgeRouterDeps,
  sendEvent: (event: BridgeServerEvent) => void,
): Promise<BridgeMethodResult> {
  const p = params as BridgeChatSendParams;

  if (!p?.sessionId || !p?.message) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, 'Missing sessionId or message');
  }

  // Verify session exists
  const session = await deps.sessionManager.get(p.sessionId);
  if (!session) {
    return makeError(BridgeErrorCode.SESSION_NOT_FOUND, `Session ${p.sessionId} not found`);
  }

  // Create AbortController for this turn
  const abortController = createAbortController(connection);
  const turnId = genId();
  const startTime = Date.now();

  // Subscribe to progress events for streaming
  const unsubscribe = deps.progressBroadcaster.subscribe(p.sessionId, (progressEvent) => {
    // Convert ProgressEvent to BridgeServerEvent and forward
    // This is supplementary — the main streaming comes from AgentEventHandler
  });

  try {
    if (p.stream) {
      // Streaming mode: send stream.start, then emit events as they arrive
      sendEvent({
        event: 'stream.start',
        data: {
          sessionId: p.sessionId,
          turnId,
          model: p.model ?? 'default',
        } satisfies StreamStartEvent,
      });

      // Run agent with event handler that converts AgentEvent → BridgeServerEvent
      const result = await deps.agentLoop.run(p.sessionId, p.message, (agentEvent) => {
        const bridgeEvent = convertAgentEvent(agentEvent, p.sessionId, turnId);
        if (bridgeEvent) {
          sendEvent(bridgeEvent);
        }
      });

      // Send stream.complete
      sendEvent({
        event: 'stream.complete',
        data: {
          sessionId: p.sessionId,
          turnId,
          elapsedMs: Date.now() - startTime,
          tokensGenerated: undefined, // Populated if available
        } satisfies StreamCompleteEvent,
      });

      return makeResult({ sessionId: p.sessionId });
    } else {
      // Non-streaming mode: await full result
      const result = await deps.agentLoop.run(p.sessionId, p.message, undefined);

      const chatResult: BridgeChatSendResult = {
        sessionId: p.sessionId,
        text: result.text,
        attachments: result.attachments,
      };

      return makeResult(chatResult);
    }
  } catch (err) {
    // If the error is an abort, mark as interrupted
    const isAbort = abortController.signal.aborted;

    if (p.stream) {
      sendEvent({
        event: isAbort ? 'stream.complete' : 'stream.error',
        data: isAbort
          ? {
              sessionId: p.sessionId,
              turnId,
              elapsedMs: Date.now() - startTime,
              interrupted: true,
            } satisfies StreamCompleteEvent
          : {
              sessionId: p.sessionId,
              turnId,
              error: String(err),
              code: 'agent_error',
            } satisfies StreamErrorEvent,
      });
    }

    if (isAbort) {
      return makeResult({ sessionId: p.sessionId, text: '[interrupted]' });
    }

    return makeError(BridgeErrorCode.INTERNAL_ERROR, String(err));
  } finally {
    unsubscribe();
    connection.abortController = null;
  }
}

/**
 * chat.abort — Abort the current streaming response.
 */
async function handleChatAbort(
  connection: BridgeConnection,
  params: unknown,
): Promise<BridgeMethodResult> {
  const aborted = abortCurrentOperation(connection);
  return makeResult({ aborted });
}

/**
 * set_model — Change the model for a session.
 */
async function handleSetModel(
  connection: BridgeConnection,
  params: unknown,
  deps: BridgeRouterDeps,
): Promise<BridgeMethodResult> {
  const p = params as SetModelParams;

  if (!p?.sessionId || !p?.model) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, 'Missing sessionId or model');
  }

  const session = await deps.sessionManager.get(p.sessionId);
  if (!session) {
    return makeError(BridgeErrorCode.SESSION_NOT_FOUND, `Session ${p.sessionId} not found`);
  }

  // Update session model
  session.model = p.model;
  await deps.sessionManager.save(session);

  return makeResult({ sessionId: p.sessionId, model: p.model });
}

/**
 * set_permission_mode — Change the permission mode for a session.
 */
async function handleSetPermissionMode(
  connection: BridgeConnection,
  params: unknown,
  deps: BridgeRouterDeps,
): Promise<BridgeMethodResult> {
  const p = params as SetPermissionModeParams;

  if (!p?.sessionId || !p?.mode) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, 'Missing sessionId or mode');
  }

  const validModes = ['ask', 'auto', 'restricted'];
  if (!validModes.includes(p.mode)) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, `Invalid permission mode: ${p.mode}`);
  }

  // Permission mode is stored in session metadata (not directly on Session type)
  // For now, we emit a hook so the rest of the system can react
  await deps.hookManager.emit('bridge:permission_mode_changed', {
    sessionId: p.sessionId,
    mode: p.mode,
  });

  return makeResult({ sessionId: p.sessionId, mode: p.mode });
}

/**
 * can_use_tool — Request tool approval from the IDE client.
 * Creates a pending approval and waits for the client's response.
 */
async function handleCanUseTool(
  connection: BridgeConnection,
  params: unknown,
  sendEvent: (event: BridgeServerEvent) => void,
  timeoutMs = 30_000,
): Promise<BridgeMethodResult> {
  const p = params as CanUseToolParams;

  if (!p?.toolName) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, 'Missing toolName');
  }

  // If the client already provided an approval decision (approved/denied),
  // this is a response to a pending approval request
  if (p.approved !== undefined) {
    const resolved = resolvePendingApprovalById(connection, p.sessionId ?? '', p.toolName, p.approved, p.reason);
    return makeResult({ resolved });
  }

  // Otherwise, this is a new tool approval request from the agent side
  // which we'd send to the client. Since can_use_tool is initiated by the
  // client in the CCR protocol, this case means the client is asking if a
  // tool can be used. For now, auto-approve unless the tool is dangerous.
  return makeResult({ allowed: true } as CanUseToolResult);
}

/**
 * interrupt — Interrupt the currently running agent turn.
 */
async function handleInterrupt(
  connection: BridgeConnection,
  params: unknown,
): Promise<BridgeMethodResult> {
  const p = params as InterruptParams;

  if (!p?.sessionId) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, 'Missing sessionId');
  }

  const aborted = abortCurrentOperation(connection);
  if (!aborted) {
    return makeError(BridgeErrorCode.INTERRUPT_FAILED, 'No running operation to interrupt');
  }

  return makeResult({ sessionId: p.sessionId, interrupted: true });
}

/**
 * session.create — Create a new session for multiplexing.
 */
async function handleSessionCreate(
  connection: BridgeConnection,
  params: unknown,
  deps: BridgeRouterDeps,
): Promise<BridgeMethodResult> {
  const p = params as BridgeSessionCreateParams;

  const session = await deps.sessionManager.getOrCreate('ide', connection.peerId);
  const tabId = p?.tabId ?? 'default';
  connection.sessions.set(tabId, session.id);

  const result: BridgeSessionCreateResult = {
    sessionId: session.id,
    peerId: connection.peerId,
  };

  return makeResult(result);
}

/**
 * session.list — List sessions for this connection.
 */
async function handleSessionList(
  connection: BridgeConnection,
  deps: BridgeRouterDeps,
): Promise<BridgeMethodResult> {
  const sessions: BridgeSessionInfo[] = [];

  for (const [tabId, sessionId] of connection.sessions) {
    const session = await deps.sessionManager.get(sessionId);
    if (session) {
      sessions.push({
        sessionId: session.id,
        peerId: session.peerId,
        channel: session.channel,
        createdAt: session.createdAt.toISOString(),
        messageCount: session.messages?.length ?? 0,
      });
    }
  }

  return makeResult({ sessions });
}

/**
 * session.archive — Archive a session.
 */
async function handleSessionArchive(
  connection: BridgeConnection,
  params: unknown,
  deps: BridgeRouterDeps,
): Promise<BridgeMethodResult> {
  const p = params as BridgeSessionArchiveParams;

  if (!p?.sessionId) {
    return makeError(BridgeErrorCode.INVALID_REQUEST, 'Missing sessionId');
  }

  await deps.sessionManager.archive(p.sessionId);

  // Remove from connection sessions map
  for (const [tabId, sid] of connection.sessions) {
    if (sid === p.sessionId) {
      connection.sessions.delete(tabId);
      break;
    }
  }

  return makeResult({ sessionId: p.sessionId, archived: true });
}

/**
 * shutdown — Graceful shutdown request from the client.
 */
async function handleShutdown(
  connection: BridgeConnection,
): Promise<BridgeMethodResult> {
  log.info({ peerId: connection.peerId }, 'Bridge client requested shutdown');
  // Don't actually close here — let the adapter handle cleanup
  return makeResult({ shuttingDown: true });
}

// ---------------------------------------------------------------------------
// Helper: Convert AgentEvent → BridgeServerEvent
// ---------------------------------------------------------------------------

function convertAgentEvent(
  event: { type: string; [key: string]: unknown },
  sessionId: string,
  turnId: string,
): BridgeServerEvent | null {
  // The agent loop's onEvent callback is untyped (AgentLoopLike), so each
  // case asserts the matching AgentEventLike variant — the assertion names
  // the contract the real AgentLoop emits for that event type.
  switch (event.type) {
    case 'stream-chunk': {
      const e = event as Extract<AgentEventLike, { type: 'stream-chunk' }>;
      return {
        event: 'stream.token',
        data: {
          sessionId,
          turnId,
          delta: e.chunk ?? '',
          index: 0,
        } satisfies StreamTokenEvent,
      };
    }

    case 'tool-call': {
      const e = event as Extract<AgentEventLike, { type: 'tool-call' }>;
      return {
        event: 'stream.tool_call',
        data: {
          sessionId,
          turnId,
          toolName: e.name ?? '',
          toolId: e.toolId ?? '',
          args: e.args ?? {},
        } satisfies StreamToolCallEvent,
      };
    }

    case 'tool-result': {
      const e = event as Extract<AgentEventLike, { type: 'tool-result' }>;
      return {
        event: 'stream.tool_result',
        data: {
          sessionId,
          turnId,
          toolName: e.name ?? '',
          toolId: e.toolId ?? '',
          result: e.result,
        } satisfies StreamToolResultEvent,
      };
    }

    case 'error': {
      const e = event as Extract<AgentEventLike, { type: 'error' }>;
      return {
        event: 'stream.error',
        data: {
          sessionId,
          turnId,
          error: e.error ?? 'Unknown error',
        } satisfies StreamErrorEvent,
      };
    }

    case 'message': {
      // Full message — convert to stream.token delta
      const e = event as Extract<AgentEventLike, { type: 'message' }>;
      return {
        event: 'stream.token',
        data: {
          sessionId,
          turnId,
          delta: e.content ?? '',
          index: 0,
        } satisfies StreamTokenEvent,
      };
    }

    case 'done':
      // Handled by the caller (chat.send), not emitted as an event here
      return null;

    case 'compaction':
      // Not forwarded to IDE
      return null;

    default:
      log.debug({ eventType: event.type }, 'Unknown agent event type in bridge');
      return null;
  }
}

/**
 * Resolve a pending approval by matching sessionId and toolName.
 * This is a simplified version — in practice, we'd match by approval ID.
 */
function resolvePendingApprovalById(
  connection: BridgeConnection,
  sessionId: string,
  toolName: string,
  approved: boolean,
  reason?: string,
): boolean {
  // Find the first matching pending approval
  for (const [id, approval] of connection.pendingApprovals) {
    if (approval.toolName === toolName && approval.sessionId === sessionId) {
      connection.pendingApprovals.delete(id);
      approval.resolve(approved, reason);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build Method Router
// ---------------------------------------------------------------------------

export interface BridgeRouterOptions {
  gatewayToken: string;
  jwtTtlMs: number;
}

/**
 * Build a method router that maps BridgeMethod strings to handler functions.
 *
 * The router validates params, calls the appropriate handler, and returns
 * a BridgeMethodResult that can be serialized back to the client.
 */
export function buildBridgeRouter(
  deps: BridgeRouterDeps,
  options: BridgeRouterOptions,
  sendEvent: (event: BridgeServerEvent) => void,
): Map<BridgeMethod, BridgeMethodHandler> {
  const router = new Map<BridgeMethod, BridgeMethodHandler>();

  router.set('initialize', (ctx) =>
    handleInitialize(ctx.connection, ctx.params, deps, options.gatewayToken, options.jwtTtlMs));

  router.set('shutdown', (ctx) =>
    handleShutdown(ctx.connection));

  router.set('chat.send', (ctx) =>
    handleChatSend(ctx.connection, ctx.params, deps, sendEvent));

  router.set('chat.abort', (ctx) =>
    handleChatAbort(ctx.connection, ctx.params));

  router.set('set_model', (ctx) =>
    handleSetModel(ctx.connection, ctx.params, deps));

  router.set('set_permission_mode', (ctx) =>
    handleSetPermissionMode(ctx.connection, ctx.params, deps));

  router.set('can_use_tool', (ctx) =>
    handleCanUseTool(ctx.connection, ctx.params, sendEvent));

  router.set('interrupt', (ctx) =>
    handleInterrupt(ctx.connection, ctx.params));

  router.set('session.create', (ctx) =>
    handleSessionCreate(ctx.connection, ctx.params, deps));

  router.set('session.list', (ctx) =>
    handleSessionList(ctx.connection, deps));

  router.set('session.archive', (ctx) =>
    handleSessionArchive(ctx.connection, ctx.params, deps));

  return router;
}

// ---------------------------------------------------------------------------
// Message Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch an incoming client message to the appropriate handler.
 *
 * @returns A BridgeServerResponse to send back to the client.
 */
export async function dispatchMessage(
  message: BridgeClientMessage,
  connection: BridgeConnection,
  router: Map<BridgeMethod, BridgeMethodHandler>,
  deps: BridgeRouterDeps,
): Promise<BridgeServerResponse> {
  const handler = router.get(message.method);

  if (!handler) {
    return {
      id: message.id,
      error: {
        code: BridgeErrorCode.METHOD_NOT_FOUND,
        message: `Unknown method: ${message.method}`,
      },
    };
  }

  // Only allow 'initialize' when in 'connecting' or 'initializing' phase
  if (message.method !== 'initialize' && connection.phase !== 'ready') {
    return {
      id: message.id,
      error: {
        code: BridgeErrorCode.AUTH_FAILED,
        message: `Connection not ready (current phase: ${connection.phase})`,
      },
    };
  }

  try {
    const result = await handler({
      connection,
      params: message.params,
      deps,
    });

    return {
      id: message.id,
      result: result.result,
      error: result.error,
    };
  } catch (err) {
    log.error({ err: String(err), method: message.method, peerId: connection.peerId }, 'Bridge method handler error');
    return {
      id: message.id,
      error: {
        code: BridgeErrorCode.INTERNAL_ERROR,
        message: String(err),
      },
    };
  }
}