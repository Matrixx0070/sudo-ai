/**
 * @file index.ts
 * @description Public API for the SUDO-AI Self-Healing / Auto-Recovery module.
 *
 * Usage:
 *   import { Watchdog, ErrorMemory } from '../health/index.js';
 *
 *   const watchdog = new Watchdog();
 *   watchdog.start();          // begins 60-second health check loop
 *   watchdog.getStatus();      // returns HealthCheck[]
 *   watchdog.isHealthy();      // true when no check is 'critical'
 *   watchdog.stop();           // stops the loop
 *
 *   const mem = new ErrorMemory();
 *   mem.remember(err, 'network', 'retry with backoff');
 *   mem.suggestFix(err);       // returns string | null
 *   mem.markFixWorked(id);
 *   mem.close();
 */

export { Watchdog } from './watchdog.js';
export type { HealthCheck } from './watchdog.js';

export { ErrorMemory } from './error-memory.js';
export type { PastError, ErrorCategory } from './error-memory.js';

export { fixLogRotation, fixDiskSpace, fixMemory, fixBrainCooldown } from './fixes.js';

// Upgrade 44: Metrics / Telemetry
export { metrics } from './metrics.js';
export type { Metric } from './metrics.js';
