/**
 * @file acp/acp-server.ts
 * @description ACP agent server — wires the ACP method set onto a JsonRpcConnection.
 *
 * Implements the agent side of ACP: initialize / session.new / session.prompt /
 * session.cancel (+ a no-op authenticate). The actual turn execution is an
 * injected {@link AcpBackend} so this server is pure and unit-testable; the CLI
 * entry supplies a Brain-backed backend.
 *
 * Streaming: during session/prompt the backend reports assistant text via the
 * onChunk callback, which this server forwards as `session/update`
 * agent_message_chunk notifications, then returns the StopReason as the
 * session/prompt result.
 */

import { JsonRpcConnection, AcpRpcError, JsonRpcErrorCode } from './jsonrpc.js';
import {
  ACP_PROTOCOL_VERSION,
  type InitializeParams,
  type InitializeResult,
  type NewSessionParams,
  type NewSessionResult,
  type PromptParams,
  type PromptResult,
  type CancelParams,
  type ContentBlock,
  type TextContentBlock,
  type SessionUpdateNotification,
  type StopReason,
} from './types.js';

/**
 * Executes ACP turns. Injected so the protocol layer stays decoupled from the
 * Brain / agent loop and is testable with a stub.
 *
 * Slice 2 (gap #26) adds the optional `emit` callback so the backend can drive
 * the full set of `session/update` variants (tool_call, tool_call_update,
 * thought) — slice 1 backends only used `onChunk` for agent_message_chunk.
 * `emit` is wired by AcpServer to `conn.notify('session/update', ...)` with the
 * sessionId attached.
 */
export interface AcpBackend {
  /** Create a new conversation session; returns its id. */
  createSession(params: NewSessionParams): Promise<string> | string;
  /**
   * Run ONE prompt turn. Stream assistant text via `onChunk`; honor `signal`
   * for session/cancel. Resolve with the StopReason. Emit structured updates
   * (tool_call / tool_call_update / thought) via `emit` when configured.
   */
  prompt(args: {
    sessionId: string;
    text: string;
    onChunk: (text: string) => void;
    signal: AbortSignal;
    emit?: (update: import('./types.js').SessionUpdate) => void;
  }): Promise<StopReason>;
  /**
   * Load a previously-persisted session and replay its history as
   * `session/update` notifications (gap #26 slice 4). Returns `true` on
   * success, `false` when the session is unknown to the backend. Implementing
   * this is optional — the server advertises `loadSession` capability based
   * on {@link supportsLoadSession}.
   */
  loadSession?(args: {
    sessionId: string;
    emit?: (update: import('./types.js').SessionUpdate) => void;
  }): Promise<boolean>;
  /**
   * Whether {@link loadSession} is wired and meaningful — drives the
   * capability advert. MUST return a stable value across the lifetime of the
   * backend: the server queries this once at `initialize` time, and a value
   * that later diverges would produce a stale capability advert with no
   * mechanism to update the client (verifier LOW 3).
   */
  supportsLoadSession?(): boolean;
}

export interface AcpServerOptions {
  agentName?: string;
  agentVersion?: string;
}

export class AcpServer {
  private readonly conn: JsonRpcConnection;
  private readonly backend: AcpBackend;
  private readonly agentName: string;
  private readonly agentVersion: string;
  private readonly sessions = new Set<string>();
  /** In-flight turn controllers by sessionId, for session/cancel. */
  private readonly active = new Map<string, AbortController>();
  private initialized = false;

  constructor(conn: JsonRpcConnection, backend: AcpBackend, opts: AcpServerOptions = {}) {
    this.conn = conn;
    this.backend = backend;
    this.agentName = opts.agentName ?? 'sudo-ai';
    this.agentVersion = opts.agentVersion ?? '0.0.0';
    conn.onRequest((method, params) => this.handleRequest(method, params));
    conn.onNotification((method, params) => this.handleNotification(method, params));
  }

  /** Begin consuming the connection's input stream. */
  start(): void {
    this.conn.start();
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.onInitialize(params);
      case 'authenticate':
        // No auth methods advertised, so this is a no-op success.
        return {};
      case 'session/new':
        return this.onNewSession(params);
      case 'session/prompt':
        return this.onPrompt(params);
      case 'session/load':
        return this.onLoadSession(params);
      default:
        throw new AcpRpcError(JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method === 'session/cancel') {
      const sessionId = (params as CancelParams | undefined)?.sessionId;
      if (typeof sessionId === 'string') {
        this.active.get(sessionId)?.abort();
      }
    }
    // Unknown notifications are silently ignored, per JSON-RPC.
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private onInitialize(params: unknown): InitializeResult {
    if (this.initialized) {
      throw new AcpRpcError(JsonRpcErrorCode.InvalidRequest, 'already initialized');
    }
    this.initialized = true;
    // Negotiate down to the highest version we both support.
    const requested = (params as InitializeParams | undefined)?.protocolVersion;
    const protocolVersion =
      typeof requested === 'number' && requested >= 1
        ? Math.min(requested, ACP_PROTOCOL_VERSION)
        : ACP_PROTOCOL_VERSION;

    return {
      protocolVersion,
      agentCapabilities: {
        // Slice 4: advert reflects whether the backend has a session store
        // wired. The server method handler also guards against calls when
        // false so a non-compliant client can't probe past the capability.
        loadSession: this.backend.supportsLoadSession?.() === true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      agentInfo: { name: this.agentName, version: this.agentVersion },
      authMethods: [],
    };
  }

  private async onNewSession(params: unknown): Promise<NewSessionResult> {
    this.requireInitialized();
    const sessionParams = params && typeof params === 'object' ? (params as NewSessionParams) : {};
    const sessionId = await this.backend.createSession(sessionParams);
    this.sessions.add(sessionId);
    return { sessionId };
  }

  private async onPrompt(params: unknown): Promise<PromptResult> {
    this.requireInitialized();
    const p = params as PromptParams | undefined;
    if (!p || typeof p.sessionId !== 'string' || !Array.isArray(p.prompt)) {
      throw new AcpRpcError(
        JsonRpcErrorCode.InvalidParams,
        'session/prompt requires { sessionId: string, prompt: ContentBlock[] }',
      );
    }
    if (!this.sessions.has(p.sessionId)) {
      throw new AcpRpcError(JsonRpcErrorCode.InvalidParams, `unknown sessionId: ${p.sessionId}`);
    }
    // Single turn per session: a concurrent prompt would clobber the in-flight
    // turn's AbortController (detaching cancel), so reject it instead.
    if (this.active.has(p.sessionId)) {
      throw new AcpRpcError(JsonRpcErrorCode.InvalidParams, `a prompt turn is already in flight for sessionId: ${p.sessionId}`);
    }

    const text = extractText(p.prompt);
    const sessionId = p.sessionId;
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    try {
      return {
        stopReason: await this.backend.prompt({
          sessionId,
          text,
          signal: controller.signal,
          onChunk: (chunk: string) => {
            if (chunk.length === 0) return;
            const notification: SessionUpdateNotification = {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
            };
            this.conn.notify('session/update', notification);
          },
          emit: (update) => {
            const notification: SessionUpdateNotification = { sessionId, update };
            this.conn.notify('session/update', notification);
          },
        }),
      };
    } finally {
      this.active.delete(sessionId);
    }
  }

  /**
   * Issue a `session/request_permission` request to the connected client and
   * await its response (gap #26 slice 2). Wired into the backend's tools.
   * requestPermission injection at construction time by acp-main.ts.
   */
  async requestPermission(
    params: import('./types.js').RequestPermissionParams,
  ): Promise<import('./types.js').RequestPermissionResult> {
    return this.conn.sendRequest<import('./types.js').RequestPermissionResult>(
      'session/request_permission',
      params,
    );
  }

  /**
   * `session/load` handler. Refuses honestly when the backend does not
   * support load, when params are malformed, or when the backend reports the
   * session is unknown.
   */
  private async onLoadSession(params: unknown): Promise<import('./types.js').LoadSessionResult> {
    this.requireInitialized();
    const p = params as import('./types.js').LoadSessionParams | undefined;
    if (!p || typeof p.sessionId !== 'string' || p.sessionId === '') {
      throw new AcpRpcError(
        JsonRpcErrorCode.InvalidParams,
        'session/load requires { sessionId: string }',
      );
    }
    if (this.backend.supportsLoadSession?.() !== true || !this.backend.loadSession) {
      throw new AcpRpcError(
        JsonRpcErrorCode.MethodNotFound,
        'session/load is not supported by this agent (no session store wired)',
      );
    }
    const sessionId = p.sessionId;
    // Refuse to overwrite an in-flight prompt's history (verifier MED 2).
    // The symmetric guard in onPrompt blocks concurrent prompts; this one
    // blocks load-during-prompt which would otherwise produce a torn history
    // when the load replaced the array the prompt is appending to.
    if (this.active.has(sessionId)) {
      throw new AcpRpcError(
        JsonRpcErrorCode.InvalidParams,
        `a prompt turn is in flight for sessionId: ${sessionId} — cannot load`,
      );
    }
    let loaded: boolean;
    try {
      loaded = await this.backend.loadSession({
        sessionId,
        emit: (update) => {
          const notification: SessionUpdateNotification = { sessionId, update };
          this.conn.notify('session/update', notification);
        },
      });
    } catch (err) {
      throw new AcpRpcError(
        JsonRpcErrorCode.InvalidParams,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!loaded) {
      throw new AcpRpcError(JsonRpcErrorCode.InvalidParams, `unknown sessionId: ${sessionId}`);
    }
    this.sessions.add(sessionId);
    return {} as import('./types.js').LoadSessionResult;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new AcpRpcError(JsonRpcErrorCode.InvalidRequest, 'initialize must be called before session methods');
    }
  }
}

/** Concatenate the text from ACP content blocks (slice 1: text blocks only). */
export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextContentBlock => !!b && b.type === 'text' && typeof (b as TextContentBlock).text === 'string')
    .map((b) => b.text)
    .join('');
}
