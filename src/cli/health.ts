/**
 * @file cli/health.ts
 * @description HTTP health check client for SUDO-AI.
 *
 * Performs a lightweight GET /health request to the running SUDO-AI
 * API server and returns a structured result.
 */

import http from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthStatus = 'running' | 'stopped' | 'unreachable';

export interface HealthResult {
  status: HealthStatus;
  /** HTTP status code returned by the server, if a connection was made. */
  httpStatus?: number;
  /** Response body as a string, truncated to 200 chars. */
  body?: string;
  /** Error message when status is 'unreachable'. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP GET to `http://localhost:<port>/health` and return
 * a structured HealthResult.
 *
 * Never throws — all errors are captured in the result.
 *
 * @param port TCP port the SUDO-AI API server listens on.
 */
export function checkHealth(port: number): Promise<HealthResult> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));

        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = raw.substring(0, 200);
          const httpStatus = res.statusCode ?? 0;

          if (httpStatus >= 200 && httpStatus < 300) {
            resolve({ status: 'running', httpStatus, body });
          } else {
            resolve({ status: 'stopped', httpStatus, body });
          }
        });

        res.on('error', (err: Error) => {
          resolve({ status: 'unreachable', error: err.message });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'unreachable', error: `Timed out after ${TIMEOUT_MS}ms` });
    });

    req.on('error', (err: Error) => {
      // ECONNREFUSED is the normal case when the server is not running.
      resolve({ status: 'unreachable', error: err.message });
    });
  });
}
