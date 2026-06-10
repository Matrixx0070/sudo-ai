/**
 * @file cli/commands/bench.ts
 * @description `sudo-ai bench` CLI command implementation.
 *
 * Calls POST /v1/admin/bench/run, polls for completion, then
 * fetches and prints the BenchReport in Markdown or JSON format.
 *
 * Options:
 *   --models   Comma-separated model IDs (default: system default)
 *   --tasks    Comma-separated task IDs (default: all 5 built-in)
 *   --conditions no_skills,skills_on,skills_optimized (default: all 3)
 *   --seeds    Number of seeds per cell (default: 1)
 *   --output   markdown | json (default: markdown)
 *
 * Exit 0 if successRate >= 0.5, exit 1 otherwise.
 */

import http from 'node:http';
import { createLogger } from '../../core/shared/logger.js';
import type { BenchReport } from '../../core/shared/wave10-types.js';

const log = createLogger('cli:bench');

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS  = 120_000;

// ---------------------------------------------------------------------------
// HTTP helpers — raw node:http, no framework
// ---------------------------------------------------------------------------

function httpRequest(
  urlStr: string,
  method: string,
  extraHeaders: Record<string, string>,
  body?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const portStr = parsed.port || '18900';
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port:     portStr,
      path:     parsed.pathname + parsed.search,
      method,
      headers:  extraHeaders,
    };
    const req = http.request(opts, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiPost(baseUrl: string, path: string, token: string | undefined, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type':   'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return httpRequest(new URL(path, baseUrl).href, 'POST', headers, payload);
}

async function apiGet(baseUrl: string, path: string, token: string | undefined): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return httpRequest(new URL(path, baseUrl).href, 'GET', headers);
}

// ---------------------------------------------------------------------------
// Main bench command
// ---------------------------------------------------------------------------

export interface BenchCommandOptions {
  models?:     string;
  tasks?:      string;
  conditions?: string;
  seeds?:      string;
  output?:     string;
}

export async function runBench(opts: BenchCommandOptions): Promise<number> {
  const baseUrl    = process.env['GATEWAY_URL'] ?? 'http://localhost:18900';
  const token      = process.env['GATEWAY_TOKEN'];
  const models     = opts.models     ? opts.models.split(',').map(s => s.trim()).filter(Boolean)     : [];
  const tasks      = opts.tasks      ? opts.tasks.split(',').map(s => s.trim()).filter(Boolean)      : [];
  const conditions = opts.conditions ? opts.conditions.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const seeds      = opts.seeds      ? parseInt(opts.seeds, 10) : 1;
  const outputFmt  = opts.output === 'json' ? 'json' : 'markdown';

  // POST /v1/admin/bench/run
  let runId: string;
  try {
    const resp = await apiPost(baseUrl, '/v1/admin/bench/run', token, {
      models:     models.length > 0 ? models     : undefined,
      tasks:      tasks.length > 0  ? tasks      : undefined,
      conditions,
      seeds,
    }) as { runId?: string; error?: { message: string } };

    if (resp.error) {
      console.error(`[bench] API error: ${resp.error.message}`);
      return 1;
    }
    if (!resp.runId) {
      console.error('[bench] No runId in response');
      return 1;
    }
    runId = resp.runId;
    console.log(`[bench] Run queued: ${runId}`);
  } catch (err) {
    // C3: detect ECONNREFUSED (including inside AggregateError) and give an
    // actionable message immediately — do NOT enter the 2-minute poll loop.
    const isConnRefused = (e: unknown): boolean => {
      if (!e || typeof e !== 'object') return false;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return true;
      // AggregateError wraps multiple connection errors
      if (e instanceof AggregateError) {
        return Array.isArray(e.errors) && e.errors.some(isConnRefused);
      }
      // Also check message string as fallback
      const msg = (e as Error).message ?? '';
      return msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND');
    };

    if (isConnRefused(err)) {
      console.error(
        `Error: could not connect to SUDO-AI gateway at ${baseUrl}. Is the bot running? Start it with: node --import tsx src/cli.ts`,
      );
      log.error({ err: String(err) }, 'bench: gateway connection refused');
      return 1;
    }

    // Other errors (5xx, parse failure, etc.) — fail fast with status info
    console.error(`[bench] Failed to queue run: ${err instanceof Error ? err.message : String(err)}`);
    log.error({ err: String(err) }, 'bench: failed to POST /v1/admin/bench/run');
    return 1;
  }

  // Poll until done
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let report: BenchReport | undefined;

  while (Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await apiGet(baseUrl, `/v1/admin/bench/results?runId=${encodeURIComponent(runId)}`, token) as {
        data: unknown[];
        report?: BenchReport;
        error?: { message: string };
      };
      if (res.error) {
        log.warn({ runId, error: res.error.message }, 'bench: poll error — retrying');
        continue;
      }
      if (res.report) {
        report = res.report;
        break;
      }
      process.stdout.write(res.data.length === 0 ? '.' : 'r');
    } catch (pollErr) {
      log.warn({ err: String(pollErr) }, 'bench: poll request failed — retrying');
    }
  }

  process.stdout.write('\n');

  if (!report) {
    console.error('[bench] Timed out waiting for bench run to complete');
    return 1;
  }

  if (outputFmt === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.markdownSummary);
  }

  return report.successRate >= 0.5 ? 0 : 1;
}
