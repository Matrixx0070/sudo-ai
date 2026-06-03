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
