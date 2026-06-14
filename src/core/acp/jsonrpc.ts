/**
 * @file acp/jsonrpc.ts
 * @description Minimal JSON-RPC 2.0 connection over newline-delimited stdio.
 *
 * ACP frames each JSON-RPC message as one line of UTF-8 JSON terminated by
 * `\n` (NDJSON), NOT the LSP Content-Length framing. This connection reads
 * line-buffered input, dispatches requests/notifications, and writes responses
 * and outbound notifications back as single lines.
 *
 * Slice 1 only RECEIVES requests/notifications and SENDS responses +
 * notifications (the agent never originates requests yet — fs/terminal/permission
 * client calls are a follow-up slice), so incoming responses are ignored.
 *
 * The streams are injected so the server is unit-testable with PassThrough
 * pipes; the CLI entry wires process.stdin / process.stdout.
 */

import type { Readable, Writable } from 'node:stream';

/**
 * Maximum bytes for a single message (one line). Guards against a peer that
 * streams without ever sending `\n`, which would otherwise grow the buffer
 * until the process OOMs. Generous enough for large pasted prompts.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** Error a request handler can throw to control the JSON-RPC error response. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** Resolves to the `result` value, or throws AcpRpcError to send an error. */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

export class JsonRpcConnection {
  private buffer = '';
  private started = false;
  private requestHandler: RequestHandler = () => {
    throw new AcpRpcError(JsonRpcErrorCode.MethodNotFound, 'no request handler installed');
  };
  private notificationHandler: NotificationHandler = () => { /* ignore */ };

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Begin consuming input. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => this.onData(chunk));
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') continue;
      if (line.length > MAX_LINE_BYTES) {
        this.send({ jsonrpc: '2.0', id: null, error: { code: JsonRpcErrorCode.ParseError, message: 'Message exceeds maximum size' } });
        continue;
      }
      void this.handleLine(line);
    }
    // Unterminated overlong line (no newline yet) — drop it to bound memory.
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      this.send({ jsonrpc: '2.0', id: null, error: { code: JsonRpcErrorCode.ParseError, message: 'Message exceeds maximum size' } });
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: JsonRpcErrorCode.ParseError, message: 'Parse error' } });
      return;
    }

    if (!msg || typeof msg !== 'object' || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string') {
      const rawId = msg?.['id'];
      const id = typeof rawId === 'number' || typeof rawId === 'string' ? rawId : null;
      this.send({ jsonrpc: '2.0', id, error: { code: JsonRpcErrorCode.InvalidRequest, message: 'Invalid request' } });
      return;
    }

    const method = msg['method'] as string;
    const params = msg['params'];
    const rawId = msg['id'];
    const hasId = typeof rawId === 'number' || typeof rawId === 'string';

    if (!hasId) {
      // Notification — no response, ever (including on handler throw).
      try {
        await this.notificationHandler(method, params);
      } catch {
        /* notifications get no response */
      }
      return;
    }

    const id = rawId as number | string;
    try {
      const result = await this.requestHandler(method, params);
      this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      if (err instanceof AcpRpcError) {
        const error: Record<string, unknown> = { code: err.code, message: err.message };
        if (err.data !== undefined) error['data'] = err.data;
        this.send({ jsonrpc: '2.0', id, error });
      } else {
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: JsonRpcErrorCode.InternalError, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  private send(msg: unknown): void {
    if (!this.output.writable) return;
    this.output.write(JSON.stringify(msg) + '\n');
  }
}
