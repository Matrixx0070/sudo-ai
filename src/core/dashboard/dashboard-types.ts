/**
 * dashboard-types.ts
 *
 * Type definitions for the SUDO-AI dashboard module.
 */

/** Aggregated system statistics for the dashboard. */
export interface DashboardStats {
  uptime: number;              // seconds since process start
  totalRequests: number;       // total HTTP requests handled
  activeSessions: number;      // current active sessions
  memoryUsage: NodeJS.MemoryUsage;  // RSS, heap, external, arrayBuffers
  cpuUsage: number;            // percentage (0-100)
}

/** Health check results for subsystems. */
export interface DashboardHealth {
  status: 'healthy' | 'degraded' | 'down';
  checks: Array<{
    name: string;
    status: 'ok' | 'warn' | 'error';
    latency?: number;          // milliseconds
    message?: string;
  }>;
}

/** Dashboard server configuration. */
export interface DashboardConfig {
  port: number;                // HTTP listen port
  authToken: string;           // Bearer token for /api/* routes
  refreshIntervalMs: number;   // client-side refresh interval
  /**
   * Bind address (default `127.0.0.1`). When set to a non-loopback address,
   * the operator MUST also set `SUDO_DASHBOARD_INSECURE=1` as explicit opt-in
   * — the dashboard refuses to start otherwise. Slice 2 — Hermes parity.
   */
  bindAddress?: string;
  /**
   * Whitespace-trimmed list of allowed `Host:` header values (DNS-rebinding
   * defense). When the dashboard receives a request whose Host header (port
   * stripped, case-normalized) is not in this list, it returns 403 without
   * touching the auth backend. Slice 2.
   */
  hostAllowlist?: readonly string[];
  /**
   * When true, GET endpoints skip Bearer auth (loopback-trust pattern).
   * Set by the boot wiring based on bindAddress: loopback → true, non-loopback
   * → false. POST mutation endpoints ALWAYS require auth regardless.
   */
  loopbackTrust?: boolean;
}

/** Alignment signal breakdown. */
export interface AlignmentData {
  score: number;               // 0-1 aggregate
  signals: Record<string, number>;  // individual signal values
}

/** Recent activity event. */
export interface ActivityEvent {
  timestamp: string;           // ISO 8601
  type: string;                // event category
  summary: string;             // human-readable description
}

/**
 * Live FleetView data — what `/api/agents/live` returns (gap #25 slice 1).
 *
 * Structurally identical to `SwarmSnapshot` from `core/agent/swarm.ts`; kept as
 * a separate name here so the dashboard's public surface owns its own
 * vocabulary, and so a future surface (TUI / Hermes-style desktop) can map to
 * the same shape without taking a transitive dep on the swarm engine.
 *
 * Empty default: when no `__sudoAgentSwarm` is registered, the endpoint serves
 * `{ spawned: [], slotsUsed: 0, slotsMax: 0, queueWaiting: 0 }` so client
 * polling code never sees `null` and renders an empty fleet honestly.
 */
export interface LiveAgentsData {
  spawned: AgentSnapshotPublic[];
  slotsUsed: number;
  slotsMax: number;
  queueWaiting: number;
}

/** Per-agent public snapshot — must NOT include the AbortController. */
export interface AgentSnapshotPublic {
  id: string;
  task: string;
  startedAt: string;       // ISO 8601
  elapsedMs: number;       // now - startedAt
  sinceHeartbeatMs: number;
  idle: boolean;
}

/**
 * Protocol the dashboard expects from whatever registers as `agentSwarm` via
 * `registerDashboardGlobals`. The live wiring is `MultiAgentOrchestrator`
 * (cli.ts), which has the matching `getSnapshot(): SwarmSnapshot` method. The
 * shape match is verified at the call site by structural typing.
 */
export interface AgentSwarmSource {
  getSnapshot?: () => LiveAgentsData | undefined;
}

// ---------------------------------------------------------------------------
// Admin-power surfaces (#28b slice 1 — Hermes parity)
// ---------------------------------------------------------------------------

/**
 * Subset of the Brain class the dashboard needs for runtime model switching.
 * Lets `dashboard-server` stay decoupled from `core/brain/brain.ts`.
 */
export interface BrainSource {
  getModel(): string;
  setModel(target: string): void;
}

/**
 * Subset of `AutoUpdateManager` the dashboard needs for the update endpoints.
 * `checkNow` previews; `applyUpdate` actually mutates (git pull + build + pm2
 * reload), so only the latter is fire-and-forget from the route handler.
 *
 * Slice 1 only needs preview + apply. `getStatus()` is intentionally not
 * mirrored here — slice 2 will add a `GET /api/admin/update/status` endpoint
 * and the matching contract at that time.
 */
export interface UpdaterSource {
  checkNow(channel?: string): Promise<UpdateCheckResult>;
  applyUpdate(channel?: string): Promise<UpdateApplyResult>;
}

/** Mirror of `VersionCheckResult` from update-manager-types so the dashboard owns its own contract. */
export interface UpdateCheckResult {
  available: boolean;
  currentVersion?: string;
  newVersion?: string;
  channel?: string;
  reason?: string;
}

/** Mirror of `UpdateResult` from update-manager-types. */
export interface UpdateApplyResult {
  success: boolean;
  fromVersion: string;
  toVersion?: string;
  stage: string;
  error?: string;
}

/**
 * Subset of `AuditTrail` the dashboard needs to log admin-power invocations.
 * Matches `AuditTrail.record(entry)` from `core/security/audit-trail.ts:231`.
 */
export interface AuditSource {
  record(entry: {
    actor: string;
    action: string;
    resource: string;
    outcome: 'success' | 'failure' | 'denied' | 'error';
    metadata?: Record<string, unknown>;
  }): string;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Fleet registrar surfaces (#28c slice 1 — OpenClaw "one admin → N devices"
// model). The registrar mode is opt-in via SUDO_FLEET_REGISTRAR_MODE=1; when
// set, cli.ts constructs a RegistryStore + registers it under
// __sudoFleetRegistrar so the dashboard can serve `POST /api/fleet/register`
// (public, signature-verified) and `GET /api/admin/fleet/devices` (Bearer +
// admin opt-in).
// ---------------------------------------------------------------------------

/**
 * Structural shape the dashboard needs from a fleet registry. Implemented
 * by `RegistryStore` in `src/core/fleet/registry-store.ts`. The interface
 * stays minimal so the dashboard does not depend on better-sqlite3
 * transitively — registrar-disabled boots don't pay any extra cost.
 */
/** Row shape both list() and the source's per-row methods return. */
export interface FleetDeviceRow {
  deviceId: string;
  publicKeyPem: string;
  hostname: string;
  versionStr: string;
  firstRegisteredAt: string;
  lastRegisteredAt: string;
  metadataJson: string | null;
  /** Slice 4 — heartbeat (bumped on inbox poll). */
  lastSeenAt: string | null;
  /**
   * Slice 4 — admission state. Slice-4 follow-up adds `pending` for
   * the explicit-admin-approval workflow opt-in via
   * `SUDO_FLEET_ADMISSION_DEFAULT=pending`.
   */
  admissionStatus: 'approved' | 'revoked' | 'pending';
}

export interface FleetRegistrarSource {
  upsert(input: {
    deviceId: string;
    publicKeyPem: string;
    hostname: string;
    versionStr: string;
    metadata?: Record<string, string>;
  }): FleetDeviceRow;
  list(limit?: number): FleetDeviceRow[];
  count(): number;
  /** Slice 4 — bump heartbeat. */
  setLastSeen(deviceId: string, now?: Date): void;
  /**
   * Slice 4 — flip admission. The admin admit/revoke endpoints only
   * pass approved|revoked; the slice-4-follow-up upsert path stamps
   * `pending` on new rows, but admins do not transition INTO pending
   * (revoke is the way to block an already-admitted device).
   */
  setAdmissionStatus(deviceId: string, status: 'approved' | 'revoked' | 'pending'): FleetDeviceRow | undefined;
}

/**
 * Slice-2 command queue surface — what the dashboard dispatcher needs from
 * the queue, minus better-sqlite3 typings. Implemented by `CommandQueue`
 * in `src/core/fleet/command-queue.ts`.
 *
 * Kept narrow on purpose: any change here is a coordinated change with
 * both `CommandQueue` and the route dispatcher.
 */
export interface FleetCommandQueueSource {
  enqueue(input: {
    deviceId: string;
    command: { kind: string; args?: Record<string, unknown> };
    dispatcher: string;
  }): string;
  pickup(deviceId: string): FleetCommandRow | undefined;
  pickupLongPoll(deviceId: string, timeoutMs: number): Promise<FleetCommandRow | undefined>;
  complete(input: { commandId: string; result: { status: 'completed' | 'failed'; result?: unknown; error?: string } }): FleetCommandRow | undefined;
  get(commandId: string): FleetCommandRow | undefined;
  /** Slice 3 — per-device history for the admin UI panel. */
  listForDevice(deviceId: string, limit?: number): FleetCommandRow[];
  /**
   * Gap #28d slice 2 — per-device latest-completed-by-kind window query.
   * The fleet-alignment rollup at `/api/admin/fleet/alignment` calls this
   * with `'alignment.digest'` and joins the result against the registrar's
   * device list to derive a `reported / missing` split. Optional so the
   * field stays backward-compatible with any future structural impl that
   * predates the rollup endpoint.
   */
  latestCompletedByKindPerDevice?(kind: string): FleetCommandRow[];
}

// ---------------------------------------------------------------------------
// Federation state (gap #28d slice 3)
// ---------------------------------------------------------------------------

/**
 * The federation-state snapshot the admin URL exposes at
 * `/api/admin/federation/state`. Aggregates PeerRegistry +
 * AuditChainSync + FederationTokenPool reads into a single read-only
 * response — operators see the whole federation in one shot rather than
 * grepping logs.
 *
 * **Secret discipline.** Two fields in the underlying types carry
 * secrets — `PeerConfig.token` (peer-side auth bearer) and the encrypted
 * `FederationTokenWithDecrypted.token`. Neither appears here. The
 * projected `peers[]` entries are `{name, url}` only; tokens are
 * surfaced as counts, never as values. Any future field added to this
 * shape that REQUIRES sensitive data must justify the leak — the safe
 * default is to keep it out.
 */
export interface FederationState {
  /**
   * True iff the federation subsystem booted cleanly (PeerRegistry +
   * AuditChainSync wired in §6.4h). When false the other fields are
   * still safe to read but every count is zero / list is empty.
   */
  enabled: boolean;
  /** SUDO_INSTANCE_ID or `${hostname}-${pid}` fallback (matches §6.4h). */
  instanceId: string;
  /** Peers from PeerRegistry.getPeers() with `token` stripped. */
  peers: Array<{ name: string; url: string }>;
  /** AuditChainSync inbound-event observation window. */
  audit: {
    inboundEventCount: number;
    lastInboundTs: number | null;
    /** ISO-8601 derived from lastInboundTs for human-readable rendering. */
    lastInboundIso: string | null;
  };
  /**
   * FederationTokenPool aggregate counts. Individual token IDs are
   * intentionally omitted — operators who need them have `listTokens()`
   * via the gateway's federation-token-pool endpoint. The admin URL's
   * job is a fleet-wide health picture, not credential management.
   */
  tokens: {
    totalCount: number;
    activeCount: number;
    /** Provider → count of active tokens (e.g. `{openai: 3, anthropic: 1}`). */
    byProvider: Record<string, number>;
  };
}

/** Provider of federation state for the admin URL. */
export interface FederationStateSource {
  getState(): FederationState;
}

/** Row shape returned by FleetCommandQueueSource — wire-format-adjacent. */
export interface FleetCommandRow {
  commandId: string;
  deviceId: string;
  kind: string;
  argsJson: string | null;
  status: 'queued' | 'in_flight' | 'completed' | 'failed' | 'timeout';
  dispatcher: string;
  dispatchedAt: string;
  pickedUpAt: string | null;
  completedAt: string | null;
  resultJson: string | null;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Pluggable auth backend (#28b slice 2 — Hermes parity)
// ---------------------------------------------------------------------------

/**
 * Result of one authentication attempt by an `AuthBackend`.
 *
 * `principal` identifies who authenticated — currently a generic
 * "dashboard:basic" for the built-in Bearer backend; future OAuth backends
 * will return per-user subject claims. The principal is what the audit chain
 * actor field records when a mutation endpoint fires.
 */
export type AuthResult =
  | { ok: true; principal: string }
  | { ok: false; reason: string };

/**
 * Pluggable authentication backend (Hermes precedent: `plugins/dashboard_auth/
 * {basic,nous,self_hosted}/`). Each backend inspects the request and returns
 * a structural `AuthResult`.
 *
 * **Built-ins (slice 2 + slice 4):**
 *  - `BasicAuthBackend` — Bearer/?token (slice 2, `createBasicAuthBackend`).
 *  - OAuth JWT — Hermes `nous` / `self_hosted` parity (slice 4,
 *    `createOAuthJwtBackend`, `createNousAuthBackend`,
 *    `createSelfHostedAuthBackend`). Verifies HS256/RS256 JWTs using
 *    `node:crypto` (no new deps); see `oauth-jwt-backend.ts`.
 *
 * **Invariant:** `authenticate` is called AFTER the Host-header allowlist
 * guard, so the request's Host header has already been validated against
 * `DashboardConfig.hostAllowlist`. Backends that build a URL from
 * `req.headers.host` can rely on it being one of the allowlisted values.
 *
 * **Sync vs async (widened in slice 4):** the return type is now
 * `AuthResult | Promise<AuthResult>` so OAuth backends can run async JWT
 * verification (RS256 via `crypto.verify`). The route dispatcher awaits
 * the result. Sync backends (Bearer) keep returning a plain `AuthResult`
 * and incur no overhead — `Promise.resolve(syncResult)` collapses in the
 * dispatcher's `await`.
 */
export interface AuthBackend {
  /** Stable name (e.g. "basic", "oauth-nous") — surfaces in audit + logs. */
  readonly name: string;
  /**
   * Inspect the request and return whether it should be authorized for this
   * endpoint. `allowQueryToken` is honored by backends that support
   * query-string token fallback (Bearer does for known GETs; OAuth backends
   * MUST ignore it because a JWT in the URL would leak into access logs,
   * referrers, and browser history).
   *
   * May return a `Promise<AuthResult>`; the dispatcher awaits.
   */
  authenticate(
    req: import('node:http').IncomingMessage,
    opts: { allowQueryToken: boolean },
  ): AuthResult | Promise<AuthResult>;
}

/**
 * Allowed bind modes for the dashboard's HTTP listener. `loopback` (the
 * default) skips Bearer on GETs (loopback-trust pattern from Hermes); any
 * non-loopback bind FORCES authentication on every endpoint AND requires
 * `SUDO_DASHBOARD_INSECURE=1` as explicit operator opt-in to bind that
 * way at all.
 */
export type DashboardBindMode = 'loopback' | 'lan' | 'public';
