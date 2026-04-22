/**
 * @file metrics.ts
 * @description Upgrade 44 — In-process metrics / telemetry collector.
 *
 * Provides counters, gauges, and timing measurements. Caps the internal ring
 * buffer at 10 000 entries; older entries are evicted in batches to stay under
 * the limit without blocking the hot path.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('health:metrics');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Metric {
  name: string;
  value: number;
  unit: string;
  timestamp: string;
  tags?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

class MetricsCollector {
  private readonly MAX_ENTRIES = 10_000;
  private readonly EVICT_COUNT = 5_000;

  private metrics: Metric[] = [];
  private readonly counters: Map<string, number> = new Map();

  // -------------------------------------------------------------------------
  // Write API
  // -------------------------------------------------------------------------

  /**
   * Increment a named counter and record the new cumulative value.
   *
   * @param name   - Metric name (e.g. 'llm.requests').
   * @param amount - Amount to add (default 1).
   * @param tags   - Optional key/value labels.
   */
  increment(name: string, amount: number = 1, tags?: Record<string, string>): void {
    if (!name) return;
    const current = this.counters.get(name) ?? 0;
    const next = current + amount;
    this.counters.set(name, next);
    this.record(name, next, 'count', tags);
  }

  /**
   * Record a point-in-time gauge value.
   *
   * @param name  - Metric name.
   * @param value - Current value.
   * @param unit  - Unit label (default 'value').
   * @param tags  - Optional key/value labels.
   */
  gauge(name: string, value: number, unit: string = 'value', tags?: Record<string, string>): void {
    if (!name) return;
    this.record(name, value, unit, tags);
  }

  /**
   * Record a duration measurement in milliseconds.
   *
   * @param name       - Metric name (e.g. 'llm.latency').
   * @param durationMs - Elapsed time in milliseconds.
   * @param tags       - Optional key/value labels.
   */
  timing(name: string, durationMs: number, tags?: Record<string, string>): void {
    if (!name) return;
    this.record(name, durationMs, 'ms', tags);
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /**
   * Return all recorded metrics, optionally filtered to those on or after `since`.
   *
   * @param since - ISO timestamp lower bound (inclusive).
   */
  getMetrics(since?: string): Metric[] {
    if (!since) return [...this.metrics];
    return this.metrics.filter((m) => m.timestamp >= since);
  }

  /** Return the current cumulative value of a counter (0 if unknown). */
  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Return a snapshot of all counter values as a plain object. */
  getSummary(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /** Clear all metrics and reset all counters. */
  reset(): void {
    this.metrics = [];
    this.counters.clear();
    log.info('Metrics collector reset');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private record(name: string, value: number, unit: string, tags?: Record<string, string>): void {
    this.metrics.push({ name, value, unit, timestamp: new Date().toISOString(), tags });

    if (this.metrics.length > this.MAX_ENTRIES) {
      this.metrics.splice(0, this.EVICT_COUNT);
      log.debug({ evicted: this.EVICT_COUNT }, 'Metrics buffer eviction');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const metrics = new MetricsCollector();
