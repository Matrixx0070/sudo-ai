/**
 * BO1 / scorecard-S18 — benchmark driver.
 *
 * Sends N messages to the local gateway `POST /api/message` ({ peerId, text })
 * sequentially, timing each turn, and prints per-turn + summary latency JSON.
 * Loopback requests skip auth. Port from GATEWAY_PORT (default 18900).
 *
 * Usage (via tsx, from the repo root):
 *   npx tsx scripts/beat-openclaw/run-bench.ts \
 *     [--n 50] [--peer bench] [--port 18900] [--text "ping {i}"] [--out bench.json]
 *
 * NOTE: this drives a REAL agent turn per message and therefore spends model
 * budget. The coordinator runs the live baseline — do not point this at prod
 * casually. Safe to build/typecheck without invoking.
 */

import { writeFileSync } from 'node:fs';

interface Args {
  n: number;
  peer: string;
  port: number;
  text: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const envPort = Number(process.env['GATEWAY_PORT'] ?? '18900');
  const out: Args = { n: 50, peer: 'bench', port: Number.isFinite(envPort) ? envPort : 18900, text: 'ping {i}' };
  // Parse a numeric flag, honoring an explicit 0 (a plain `Number(x) || def`
  // would silently fall back to the default on 0 — a dangerous footgun for --n).
  const num = (raw: string | undefined, def: number): number => {
    const v = Number(raw);
    return Number.isFinite(v) ? v : def;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--n' && next !== undefined) { out.n = num(next, out.n); i++; }
    else if (a === '--peer' && next) { out.peer = next; i++; }
    else if (a === '--port' && next !== undefined) { out.port = num(next, out.port); i++; }
    else if (a === '--text' && next) { out.text = next; i++; }
    else if (a === '--out' && next) { out.out = next; i++; }
  }
  return out;
}

interface TurnResult {
  i: number;
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
}

async function sendOne(url: string, peerId: string, text: string): Promise<{ status: number; ok: boolean; error?: string }> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId, text }),
    });
    // Drain the body so the connection frees cleanly.
    await resp.text().catch(() => '');
    return { status: resp.status, ok: resp.ok };
  } catch (err) {
    return { status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = `http://127.0.0.1:${args.port}/api/message`;
  const turns: TurnResult[] = [];

  for (let i = 1; i <= args.n; i++) {
    const text = args.text.replaceAll('{i}', String(i));
    const t0 = Date.now();
    const res = await sendOne(url, args.peer, text);
    const latencyMs = Date.now() - t0;
    const turn: TurnResult = { i, ok: res.ok, status: res.status, latencyMs, ...(res.error ? { error: res.error } : {}) };
    turns.push(turn);
    console.error(`[${i}/${args.n}] status=${res.status} ${latencyMs}ms${res.error ? ' err=' + res.error : ''}`);
  }

  const okTurns = turns.filter((t) => t.ok);
  const latencies = okTurns.map((t) => t.latencyMs).sort((a, b) => a - b);
  const median = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)]! : 0;
  const avg = okTurns.length > 0 ? Math.round(okTurns.reduce((s, t) => s + t.latencyMs, 0) / okTurns.length) : 0;

  const summary = {
    url,
    peerId: args.peer,
    requested: args.n,
    ok: okTurns.length,
    failed: turns.length - okTurns.length,
    avgLatencyMs: avg,
    medianLatencyMs: median,
    minLatencyMs: latencies[0] ?? 0,
    maxLatencyMs: latencies[latencies.length - 1] ?? 0,
    turns,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(summary, null, 2));
    console.error(`wrote ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
