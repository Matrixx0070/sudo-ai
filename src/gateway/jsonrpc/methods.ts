/**
 * @file src/gateway/jsonrpc/methods.ts
 * @description JSON-RPC 2.0 method implementations for the FleetView gateway
 * (gap #25 slice 3).
 *
 * Methods are pure adapters: they take a JSON-RPC `params` value, GET the
 * matching dashboard HTTP endpoint, and return the parsed result. On error
 * they throw `AcpRpcError` so the JsonRpcConnection serializes the standard
 * `{code, message, data?}` envelope.
 *
 * The handler map is built by `buildMethodRegistry()` so the same factory can
 * be re-used in tests with a stub config (different host/port). Method names
 * use dot-separated namespaces matching the dashboard URL shape
 * (`agents.snapshot` ↔ `/api/agents/live`, `dashboard.stats` ↔ `/api/stats`).
 */

// `AcpRpcError`/`JsonRpcErrorCode` are imported from the ACP module because the
// JSON-RPC plumbing was first written there; both classes are protocol-neutral
// and reused by this gateway. A follow-up slice will hoist them under
// `src/core/jsonrpc/` and re-export from `src/core/acp/jsonrpc.ts` for
// backward compatibility — tracked as a non-blocking refactor.
import { AcpRpcError, JsonRpcErrorCode } from '../../core/acp/jsonrpc.js';
import { dashboardGet, type GatewayConfig } from './fetcher.js';

/** Gateway version surfaced by the handshake method. Bump on shape changes. */
export const GATEWAY_VERSION = '1.0.0';

/**
 * Application-defined error codes (JSON-RPC 2.0 spec §5.1 reserves the range
 * -32000 to -32099 for application errors). Using the standard `InvalidRequest`
 * code for upstream-auth failures would collide with the JsonRpcConnection's
 * own emission for malformed envelopes — clients switching on error code could
 * not distinguish "you sent bad JSON-RPC" from "the gateway is misconfigured."
 */
export const GatewayErrorCode = {
  /** Upstream dashboard server returned 401 — the gateway's Bearer token is wrong. */
  UpstreamUnauthorized: -32000,
} as const;

/** Result shape for `gateway.version` — used by clients as a feature-probe. */
export interface GatewayVersion {
  version: string;
  protocol: 'jsonrpc-2.0';
  framing: 'ndjson';
  methods: string[];
}

/**
 * Map a FetchResult error onto an AcpRpcError. 401 surfaces with the
 * application-defined `UpstreamUnauthorized` code so JSON-RPC clients can
 * distinguish "the gateway's upstream auth is misconfigured" from "your
 * request envelope was malformed" (which the connection emits as
 * InvalidRequest). Everything else is InternalError with the underlying
 * detail so a client can surface or retry.
 */
function rpcError(error: string, status?: number): AcpRpcError {
  if (status === 401) {
    return new AcpRpcError(GatewayErrorCode.UpstreamUnauthorized, error);
  }
  return new AcpRpcError(JsonRpcErrorCode.InternalError, error);
}

/** Handler signature — what each method registers with the JSON-RPC server. */
export type MethodHandler = (params: unknown) => Promise<unknown>;

/**
 * Build the registry of method handlers bound to a config. The set of method
 * names is exposed via `gateway.version` so a client can feature-detect at
 * handshake time.
 */
export function buildMethodRegistry(config: GatewayConfig): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>();

  // -------------------------------------------------------------------------
  // gateway.version — handshake
  // -------------------------------------------------------------------------

  handlers.set('gateway.version', async (_params: unknown): Promise<GatewayVersion> => {
    return {
      version: GATEWAY_VERSION,
      protocol: 'jsonrpc-2.0',
      framing: 'ndjson',
      methods: [...handlers.keys()].sort(),
    };
  });

  // -------------------------------------------------------------------------
  // agents.snapshot — live FleetView (gap #25 slice 1 endpoint)
  // -------------------------------------------------------------------------

  handlers.set('agents.snapshot', async (_params: unknown): Promise<unknown> => {
    const r = await dashboardGet<unknown>(config, '/api/agents/live');
    if (!r.ok) throw rpcError(r.error, r.status);
    return r.data;
  });

  // -------------------------------------------------------------------------
  // dashboard.{stats,health,alignment,metrics} — direct GETs
  // -------------------------------------------------------------------------

  for (const [name, path] of [
    ['dashboard.stats', '/api/stats'],
    ['dashboard.health', '/api/health'],
    ['dashboard.alignment', '/api/alignment'],
  ] as const) {
    handlers.set(name, async (_params: unknown): Promise<unknown> => {
      const r = await dashboardGet<unknown>(config, path);
      if (!r.ok) throw rpcError(r.error, r.status);
      return r.data;
    });
  }

  // -------------------------------------------------------------------------
  // dashboard.metrics — Prometheus text -> map<string,string>
  //
  // The dashboard serves text/plain in Prometheus exposition format. We parse
  // it into a plain object so JSON-RPC clients don't have to ship a metrics
  // parser. Lines starting with `#` (HELP/TYPE) are ignored.
  // -------------------------------------------------------------------------

  handlers.set(
    'dashboard.metrics',
    async (_params: unknown): Promise<Record<string, string>> => {
      const r = await dashboardGet<string>(
        config,
        '/api/metrics',
        (s) => s, // raw text — we parse below
      );
      if (!r.ok) throw rpcError(r.error, r.status);
      const out: Record<string, string> = {};
      for (const line of r.data.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const sp = trimmed.indexOf(' ');
        if (sp === -1) continue;
        const key = trimmed.slice(0, sp).trim();
        const value = trimmed.slice(sp + 1).trim();
        if (key) out[key] = value;
      }
      return out;
    },
  );

  // -------------------------------------------------------------------------
  // dashboard.activity — recent activity events. Accepts {limit?: number}.
  // -------------------------------------------------------------------------

  handlers.set('dashboard.activity', async (params: unknown): Promise<unknown> => {
    let limit = 50;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const raw = (params as Record<string, unknown>)['limit'];
      // Accept either a finite number or a numeric string — JSON-RPC clients
      // shaped by jq pipelines / HTTP-to-stdio bridges often stringify numbers.
      let coerced: number | undefined;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        coerced = raw;
      } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
        coerced = parseInt(raw.trim(), 10);
      }
      if (coerced !== undefined) {
        limit = Math.max(1, Math.min(100, Math.floor(coerced)));
      } else if (raw !== undefined) {
        throw new AcpRpcError(
          JsonRpcErrorCode.InvalidParams,
          'limit must be a finite number (or numeric string) between 1 and 100',
        );
      }
    }
    const r = await dashboardGet<unknown>(config, `/api/activity?limit=${limit}`);
    if (!r.ok) throw rpcError(r.error, r.status);
    return r.data;
  });

  return handlers;
}
