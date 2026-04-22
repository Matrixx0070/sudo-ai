#!/usr/bin/env tsx
/**
 * @file scripts/soak.ts
 * @description Wave 8F: Soak test runner for SUDO-AI v5 admin endpoints.
 *
 * Usage:
 *   node scripts/soak.ts [--duration=60] [--rps=10] [--target=http://localhost:18900] [--token=<bearer>]
 *
 * Output: JSON summary + PASS/FAIL verdict.
 * Exit code: 0 on PASS, 1 on FAIL.
 *
 * FAIL criteria:
 *   - Any endpoint error rate > 1%
 *   - Any endpoint p99 latency > 2000ms
 */

import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface SoakConfig {
  duration: number;   // seconds
  rps: number;        // requests per second (total across all endpoints)
  target: string;     // base URL
  token: string;      // bearer token (empty = unauthenticated)
  pid?: number;       // optional PID for RSS measurement
}

function parseArgs(argv: string[]): SoakConfig {
  const args = argv.slice(2);
  let duration = 60;
  let rps = 10;
  let target = 'http://localhost:18900';
  let token = '';

  for (const arg of args) {
    const [key, val] = arg.replace(/^--/, '').split('=');
    if (!key || val === undefined) continue;
    switch (key) {
      case 'duration': duration = parseInt(val, 10); break;
      case 'rps':      rps      = parseInt(val, 10); break;
      case 'target':   target   = val; break;
      case 'token':    token    = val; break;
    }
  }

  // Validate
  if (!Number.isFinite(duration) || duration < 1) duration = 60;
  if (!Number.isFinite(rps) || rps < 1) rps = 10;

  return { duration, rps, target, token };
}

// ---------------------------------------------------------------------------
// Endpoints to rotate through
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  '/v1/admin/digest',
  '/v1/admin/alignment',
  '/v1/admin/trust',
  '/v1/admin/patterns',
  '/v1/admin/calibration',
  '/v1/admin/diagnostics',
  '/v1/admin/reanchor/stats',
  '/v1/admin/veto/threshold',
  '/v1/admin/remediation/stats',
];

// ---------------------------------------------------------------------------
// Latency percentile calculation
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Per-endpoint stats
// ---------------------------------------------------------------------------

interface EndpointStats {
  endpoint: string;
  latencies: number[];
  errorCount: number;
  totalRequests: number;
  statusCodes: Record<number, number>;
}

function makeEndpointStats(endpoint: string): EndpointStats {
  return { endpoint, latencies: [], errorCount: 0, totalRequests: 0, statusCodes: {} };
}

// ---------------------------------------------------------------------------
// RSS sampling
// ---------------------------------------------------------------------------

function sampleRss(pid: number): number | null {
  try {
    const raw = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const kb = parseInt(raw, 10);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

function getCurrentPid(): number | null {
  return process.pid ?? null;
}

// ---------------------------------------------------------------------------
// Single request function
// ---------------------------------------------------------------------------

async function doRequest(
  url: string,
  token: string,
  stats: EndpointStats,
): Promise<void> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const start = Date.now();
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    stats.latencies.push(latencyMs);
    stats.totalRequests++;
    stats.statusCodes[resp.status] = (stats.statusCodes[resp.status] ?? 0) + 1;
    // Consume body
    await resp.text();
    if (resp.status >= 500) {
      stats.errorCount++;
    }
  } catch {
    const latencyMs = Date.now() - start;
    stats.latencies.push(latencyMs);
    stats.totalRequests++;
    stats.errorCount++;
    stats.statusCodes[0] = (stats.statusCodes[0] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Main soak runner
// ---------------------------------------------------------------------------

async function runSoak(config: SoakConfig): Promise<void> {
  const { duration, rps, target, token } = config;
  const intervalMs = 1000 / rps;
  const endTime = Date.now() + duration * 1000;

  // Stats map: endpoint → stats
  const statsMap = new Map<string, EndpointStats>();
  for (const ep of ENDPOINTS) {
    statsMap.set(ep, makeEndpointStats(ep));
  }

  // RSS samples
  const rssSamples: Array<{ ts: number; rssKb: number }> = [];
  const pid = getCurrentPid();
  let reqIdx = 0;

  // RSS sampling every 10s
  const rssInterval = setInterval(() => {
    if (pid === null) return;
    const rssKb = sampleRss(pid);
    if (rssKb !== null) {
      rssSamples.push({ ts: Date.now(), rssKb });
      console.log(`[RSS] t=${Math.round((Date.now() - (endTime - duration * 1000)) / 1000)}s  rss=${rssKb}KB (${(rssKb / 1024).toFixed(1)}MB)`);
    }
  }, 10_000);

  console.log(`\nSoak test started: target=${target}  duration=${duration}s  rps=${rps}`);
  console.log(`Endpoints: ${ENDPOINTS.length}  interval=${intervalMs.toFixed(1)}ms per request\n`);

  // Request loop
  const pending: Promise<void>[] = [];

  while (Date.now() < endTime) {
    const ep = ENDPOINTS[reqIdx % ENDPOINTS.length]!;
    reqIdx++;

    const stats = statsMap.get(ep)!;
    const url = `${target}${ep}`;
    const p = doRequest(url, token, stats);
    pending.push(p);

    // Throttle by sleeping for interval
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }

  // Wait for all inflight requests
  await Promise.allSettled(pending);
  clearInterval(rssInterval);

  // ---------------------------------------------------------------------------
  // Build summary
  // ---------------------------------------------------------------------------

  const summary: {
    config: SoakConfig;
    durationActual: number;
    totalRequests: number;
    totalErrors: number;
    overallErrorRate: number;
    endpoints: Array<{
      endpoint: string;
      requests: number;
      errors: number;
      errorRate: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      statusCodes: Record<number, number>;
      pass: boolean;
    }>;
    rssSamples: Array<{ ts: number; rssKb: number }>;
    verdict: 'PASS' | 'FAIL';
    failReasons: string[];
  } = {
    config,
    durationActual: duration,
    totalRequests: 0,
    totalErrors: 0,
    overallErrorRate: 0,
    endpoints: [],
    rssSamples,
    verdict: 'PASS',
    failReasons: [],
  };

  const ERROR_RATE_THRESHOLD = 0.01;
  const P99_LATENCY_THRESHOLD_MS = 2000;

  for (const [ep, stats] of statsMap) {
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const errorRate = stats.totalRequests > 0 ? stats.errorCount / stats.totalRequests : 0;

    const pass = errorRate <= ERROR_RATE_THRESHOLD && p99 <= P99_LATENCY_THRESHOLD_MS;

    if (!pass) {
      if (errorRate > ERROR_RATE_THRESHOLD) {
        summary.failReasons.push(`${ep}: error rate ${(errorRate * 100).toFixed(2)}% > 1%`);
      }
      if (p99 > P99_LATENCY_THRESHOLD_MS) {
        summary.failReasons.push(`${ep}: p99 ${p99}ms > ${P99_LATENCY_THRESHOLD_MS}ms`);
      }
      summary.verdict = 'FAIL';
    }

    summary.endpoints.push({
      endpoint: ep,
      requests: stats.totalRequests,
      errors: stats.errorCount,
      errorRate: parseFloat((errorRate * 100).toFixed(2)),
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      statusCodes: stats.statusCodes,
      pass,
    });

    summary.totalRequests += stats.totalRequests;
    summary.totalErrors += stats.errorCount;
  }

  summary.overallErrorRate = summary.totalRequests > 0
    ? parseFloat(((summary.totalErrors / summary.totalRequests) * 100).toFixed(2))
    : 0;

  // ---------------------------------------------------------------------------
  // Print results
  // ---------------------------------------------------------------------------

  console.log('\n' + '='.repeat(70));
  console.log('SOAK TEST RESULTS');
  console.log('='.repeat(70));
  console.log(`Total requests:   ${summary.totalRequests}`);
  console.log(`Total errors:     ${summary.totalErrors}`);
  console.log(`Overall error %:  ${summary.overallErrorRate}%`);
  console.log('');
  console.log('Per-endpoint latency (ms):');
  console.log(`${'Endpoint'.padEnd(40)} ${'Req'.padStart(6)} ${'Err%'.padStart(6)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'PASS'.padStart(6)}`);
  console.log('-'.repeat(90));
  for (const ep of summary.endpoints) {
    const passStr = ep.pass ? 'YES' : 'NO ';
    console.log(`${ep.endpoint.padEnd(40)} ${String(ep.requests).padStart(6)} ${String(ep.errorRate).padStart(5)}% ${String(ep.p50Ms).padStart(7)}ms ${String(ep.p95Ms).padStart(7)}ms ${String(ep.p99Ms).padStart(7)}ms ${passStr.padStart(6)}`);
  }

  if (rssSamples.length > 0) {
    console.log('\nRSS samples (KB):');
    for (const s of rssSamples) {
      console.log(`  t=${new Date(s.ts).toISOString()}  rss=${s.rssKb}KB`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('JSON SUMMARY:');
  console.log(JSON.stringify(summary, null, 2));
  console.log('='.repeat(70));
  console.log(`\nVERDICT: ${summary.verdict}`);
  if (summary.failReasons.length > 0) {
    console.log('FAIL REASONS:');
    for (const r of summary.failReasons) {
      console.log(`  - ${r}`);
    }
  }
  console.log('');

  process.exit(summary.verdict === 'PASS' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const config = parseArgs(process.argv);
runSoak(config).catch((err: unknown) => {
  console.error('Soak runner fatal error:', String(err));
  process.exit(2);
});
