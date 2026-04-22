/**
 * @file sampler.ts
 * @description Collects raw OS and hardware metrics for the embodied-state
 * subsystem of SUDO-AI v4.
 *
 * All OS calls are synchronous (os module) except for the network reachability
 * probe, which is an async DNS resolution with a hard 3-second timeout via
 * AbortSignal.timeout.  The function never throws — sampling failures are
 * logged and safe defaults are returned so the engine always has a value.
 */

import os from 'node:os';
import { statfsSync } from 'node:fs';
import dns from 'node:dns/promises';
import { createLogger } from '../../shared/logger.js';
import type { RawSystemMetrics } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('consciousness:embodied-state');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DNS probe target — Cloudflare public resolver, globally routable. */
const DNS_PROBE_HOST = '1.1.1.1';

/** Maximum milliseconds to wait for the DNS probe before treating as offline. */
const DNS_TIMEOUT_MS = 3_000;

/** Root filesystem mount point used for disk stats. */
const ROOT_FS = '/';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sample the current state of the host system and return a `RawSystemMetrics`
 * snapshot.  The async portion (network probe) is awaited internally; the
 * caller receives a single resolved object.
 *
 * Never throws.  On any sub-sampling failure the affected fields fall back to
 * safe neutral values and a warning is emitted to the log.
 *
 * @returns Resolved `RawSystemMetrics` snapshot.
 */
export async function sampleMetrics(): Promise<RawSystemMetrics> {
  // --- Synchronous OS metrics (always available) ---------------------------

  const loadAvg = os.loadavg();
  const cpuLoadAvg1m = loadAvg[0] ?? 0;
  const cpuCount = Math.max(os.cpus().length, 1); // guard against 0
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const uptimeSeconds = os.uptime();

  // --- Disk stats via statfsSync -------------------------------------------

  let diskTotalBytes = 1;  // safe non-zero defaults
  let diskUsedBytes = 0;

  try {
    const stat = statfsSync(ROOT_FS);
    // statfsSync returns { bsize, blocks, bfree, bavail, files, ffree }
    // Total = bsize * blocks; Available to root = bsize * bfree
    diskTotalBytes = stat.bsize * stat.blocks;
    const diskFreeBytes = stat.bsize * stat.bfree;
    diskUsedBytes = Math.max(diskTotalBytes - diskFreeBytes, 0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, 'sampler: statfsSync failed, disk metrics defaulting to 0');
  }

  // --- Network reachability probe ------------------------------------------

  let networkReachable = false;
  let pingLatencyMs: number | null = null;

  try {
    const t0 = Date.now();
    // dns.promises.resolve does not expose a typed options bag in all @types
    // versions.  We cast through unknown to pass the AbortSignal without
    // triggering a spurious TS2694 on older type definitions.
    await (dns.resolve as (host: string, opts: { signal: AbortSignal }) => Promise<string[]>)(
      DNS_PROBE_HOST,
      { signal: AbortSignal.timeout(DNS_TIMEOUT_MS) },
    );
    pingLatencyMs = Date.now() - t0;
    networkReachable = true;
  } catch (err: unknown) {
    // AbortError = timeout; other errors = DNS failure — both map to offline.
    const msg = err instanceof Error ? err.message : String(err);
    log.debug({ error: msg }, 'sampler: network probe failed — treating as offline');
    networkReachable = false;
    pingLatencyMs = null;
  }

  const metrics: RawSystemMetrics = {
    cpuLoadAvg1m,
    cpuCount,
    totalMemBytes,
    freeMemBytes,
    diskTotalBytes,
    diskUsedBytes,
    networkReachable,
    pingLatencyMs,
    uptimeSeconds,
  };

  log.debug(
    {
      cpuLoad: cpuLoadAvg1m.toFixed(2),
      cpuCount,
      memFreeMB: (freeMemBytes / 1_048_576).toFixed(0),
      diskUsedGB: (diskUsedBytes / 1_073_741_824).toFixed(1),
      networkReachable,
      pingMs: pingLatencyMs,
      uptimeSec: uptimeSeconds,
    },
    'sampler: metrics collected',
  );

  return metrics;
}
