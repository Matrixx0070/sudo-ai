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
