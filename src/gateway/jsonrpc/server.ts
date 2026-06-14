/**
 * @file src/gateway/jsonrpc/server.ts
 * @description Wires the reusable acp/jsonrpc connection to the gateway method
 * registry (gap #25 slice 3).
 *
 * Separation of concerns:
 *   - JsonRpcConnection (acp/jsonrpc.ts) owns the wire protocol (NDJSON, parse
 *     errors, request/response dispatch, AcpRpcError serialization).
 *   - buildMethodRegistry (methods.ts) owns the gateway-specific methods.
 *   - This module glues the two: install a single request handler that looks
 *     the method up by name and falls back to MethodNotFound.
 *
 * Notifications are accepted but ignored — slice 3 has no inbound
 * notifications (no client→server push semantics yet).
 *
 * The streams are injected so tests can use PassThrough pipes; the entry
 * script wires process.stdin / process.stdout.
 */

import type { Readable, Writable } from 'node:stream';
import {
  AcpRpcError,
  JsonRpcConnection,
  JsonRpcErrorCode,
} from '../../core/acp/jsonrpc.js';
import { buildMethodRegistry, type MethodHandler } from './methods.js';
import type { GatewayConfig } from './fetcher.js';

/** Public surface returned by {@link startGatewayServer}. */
export interface GatewayServer {
  /** Underlying JSON-RPC connection (mostly for tests). */
  readonly connection: JsonRpcConnection;
  /** The method registry actually in use. */
  readonly methods: Map<string, MethodHandler>;
}

/**
 * Start a gateway server bound to the given streams + config. Idempotent —
 * `start()` on the underlying connection is guarded internally.
 */
export function startGatewayServer(
  input: Readable,
  output: Writable,
  config: GatewayConfig,
): GatewayServer {
  const methods = buildMethodRegistry(config);
  const connection = new JsonRpcConnection(input, output);

  connection.onRequest(async (method, params) => {
    const handler = methods.get(method);
    if (!handler) {
      throw new AcpRpcError(
        JsonRpcErrorCode.MethodNotFound,
        `method "${method}" is not implemented by this gateway`,
      );
    }
    return handler(params);
  });

  // Notifications are accepted (the connection swallows handler throws) but
  // intentionally do nothing today — see the file header.
  connection.onNotification(() => { /* slice 3 has no inbound notifications */ });

  connection.start();
  return { connection, methods };
}
