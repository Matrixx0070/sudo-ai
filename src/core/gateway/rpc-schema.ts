/**
 * gateway/rpc-schema.ts — runtime (zod) validation + the schema-validated WS RPC
 * handshake (Slice C/2).
 *
 * Gated by SUDO_GATEWAY_RPC_V2 so existing /ws clients keep working: when off
 * (default), the WS server behaves exactly as before (no connect frame required,
 * no per-method scope check). When on, the first frame must be `connect` (→ hello-ok
 * carrying the granted operator scopes + method list), and every subsequent call is
 * scope-checked against the auth principal resolved at upgrade.
 *
 * Kept separate from rpc-types.ts, which stays dependency-free.
 */
import { z } from 'zod';
import { hasScope, type GatewayPrincipal, type OperatorScope } from './auth.js';
import type { RpcEvent } from './rpc-types.js';

/** sudo-ai's own WS RPC protocol version (independent of the OpenAI-compat HTTP). */
export const RPC_PROTOCOL_VERSION = 1;

/** SUDO_GATEWAY_RPC_V2=1 enables the connect handshake + per-method scope checks. */
export function rpcV2Enabled(): boolean {
  return process.env['SUDO_GATEWAY_RPC_V2'] === '1';
}

/** Request frame shape (zod mirror of RpcRequest). */
export const RpcRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

/** connect params — protocol negotiation (all optional; forward-compatible). */
export const ConnectParamsSchema = z
  .object({
    minProtocol: z.number().int().optional(),
    maxProtocol: z.number().int().optional(),
  })
  .passthrough()
  .optional();

/** Per-method operator scope. Unknown methods default to write (safe-by-default). */
const METHOD_SCOPES: Record<string, OperatorScope> = {
  health: 'operator.read',
  'sessions.list': 'operator.read',
  'tools.catalog': 'operator.read',
  'cron.list': 'operator.read',
  'chat.send': 'operator.write',
  'chat.abort': 'operator.write',
  'sessions.send': 'operator.write',
  'cron.add': 'operator.write',
  'cron.remove': 'operator.write',
  'secrets.reload': 'operator.admin',
  'secrets.resolve': 'operator.admin',
};

/** A per-connection event sequencer (see RpcEvent). */
export interface EventSequencer {
  /** Stamp the next event with a 1-based monotonic seq (+ optional stateVersion). */
  next(event: string, data: unknown, stateVersion?: number): RpcEvent;
  /** The last seq handed out (0 before the first event). */
  readonly current: number;
}

/**
 * Create a per-connection event sequencer implementing the OpenClaw ordering
 * contract (invariants I3/I66). Each `next()` returns an RpcEvent stamped with a
 * fresh 1-based monotonic `seq`; pass `stateVersion` when the underlying state
 * changes so a client can detect a discontinuity and refresh. There is no
 * server-push emitter today — this is the canonical builder for when one is added,
 * so events are born sequenced instead of retrofitted. See RpcEvent for the
 * client-side gap-recovery contract.
 */
export function createEventSequencer(): EventSequencer {
  let seq = 0;
  return {
    next(event: string, data: unknown, stateVersion?: number): RpcEvent {
      seq += 1;
      return stateVersion === undefined
        ? { type: 'event', event, data, seq }
        : { type: 'event', event, data, seq, stateVersion };
    },
    get current(): number { return seq; },
  };
}

export function requiredScopeFor(method: string): OperatorScope {
  return METHOD_SCOPES[method] ?? 'operator.write';
}

/**
 * True when the principal may call the method.
 *
 * NOTE: today every authenticated WS principal is operator.admin (gateway-secret /
 * gateway-token / loopback all resolve to admin), so this is currently permissive.
 * It becomes load-bearing when narrower WS credentials exist (e.g. scoped device
 * tokens) — the enforcement point is already here.
 */
export function mayCallMethod(principal: GatewayPrincipal | undefined, method: string): boolean {
  if (!principal) return false;
  return hasScope(principal, requiredScopeFor(method));
}

export interface HelloOk {
  type: 'hello-ok';
  protocol: number;
  scopes: OperatorScope[];
  methods: string[];
  server: { name: string; protocol: number };
}

export function buildHelloOk(
  principal: GatewayPrincipal | undefined,
  methods: string[],
): HelloOk {
  return {
    type: 'hello-ok',
    protocol: RPC_PROTOCOL_VERSION,
    scopes: principal?.scopes ?? [],
    methods,
    server: { name: 'sudo-ai', protocol: RPC_PROTOCOL_VERSION },
  };
}
