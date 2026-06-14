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
 * a structural `AuthResult`. The dashboard ships ONE built-in backend in
 * slice 2 — `BasicAuthBackend` wrapping the existing Bearer/?token logic —
 * plus the contract. OAuth backends are slice 4+.
 *
 * **Invariant:** `authenticate` is called AFTER the Host-header allowlist
 * guard, so the request's Host header has already been validated against
 * `DashboardConfig.hostAllowlist`. Backends that build a URL from
 * `req.headers.host` can rely on it being one of the allowlisted values.
 *
 * **Sync vs async:** the return type is currently `AuthResult` (sync only)
 * and the route dispatcher does NOT await. Any custom backend registered
 * today must complete synchronously. When OAuth backends land in slice 4+,
 * the interface will widen to `AuthResult | Promise<AuthResult>` and the
 * dispatcher will become async — that is the known breaking-change point.
 */
export interface AuthBackend {
  /** Stable name (e.g. "basic", "oauth-nous") — surfaces in audit + logs. */
  readonly name: string;
  /**
   * Inspect the request and return whether it should be authorized for this
   * endpoint. `allowQueryToken` is honored by backends that support
   * query-string token fallback (Bearer does for known GETs; OAuth ignores).
   *
   * **Slice-4 breaking-change note:** when OAuth backends land they will need
   * async JWT verification, at which point this returns `AuthResult |
   * Promise<AuthResult>` and `authenticateRequest` becomes async. Slice 2
   * keeps it sync to avoid a non-load-bearing dispatch refactor.
   */
  authenticate(
    req: import('node:http').IncomingMessage,
    opts: { allowQueryToken: boolean },
  ): AuthResult;
}

/**
 * Allowed bind modes for the dashboard's HTTP listener. `loopback` (the
 * default) skips Bearer on GETs (loopback-trust pattern from Hermes); any
 * non-loopback bind FORCES authentication on every endpoint AND requires
 * `SUDO_DASHBOARD_INSECURE=1` as explicit operator opt-in to bind that
 * way at all.
 */
export type DashboardBindMode = 'loopback' | 'lan' | 'public';
