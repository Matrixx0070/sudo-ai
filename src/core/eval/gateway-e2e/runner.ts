/**
 * @file runner.ts
 * @description Boot-a-real-child-process E2E harness. Spawns the full SUDO
 * daemon (`node --import tsx src/cli.ts`) on an ephemeral port with an
 * ISOLATED temp DATA_DIR (never the prod mind.db/cron), waits for /health,
 * drives YAML scenarios against the live process (POST /api/message → assert
 * reply / memory / cron side-effects), then tears the child down.
 *
 * Opt-in via SUDO_E2E=1; invoked through scripts/e2e/gateway.mts — never a
 * vitest file (a full daemon boot must not run in unit CI).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parseYaml } from '../../workflows/yaml-parser.js';
import { PROJECT_ROOT } from '../../shared/paths.js';

const E2E_TOKEN = 'e2e-test-token';

export interface Scenario {
  name: string;
  message: string;
  peerId: string;
  expect_reply_regex?: string;
  expect_cron_job_regex?: string;
  message2?: string;
  expect_reply2_regex?: string;
  timeout_ms?: number;
}

export interface ScenarioResult { name: string; passed: boolean; detail: string; }

/** Reserve a free TCP port (bind :0, read it, release). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Provider/channel creds are stripped so the child never attaches to live services. */
function childEnv(port: number, dataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX|TWILIO)_/.test(k)) delete env[k];
  }
  return {
    ...env,
    GATEWAY_PORT: String(port),
    DATA_DIR: dataDir,
    SUDO_AI_HOME: PROJECT_ROOT,
    WEB_CHAT_ENABLED: 'true',
    WEB_CHAT_TOKEN: E2E_TOKEN,
    NODE_ENV: 'test',
    SUDO_SELFTEST_DISABLE: '1',
  };
}

export interface Harness {
  child: ChildProcess;
  port: number;
  dataDir: string;
  kill(): Promise<void>;
}

export async function spawnGateway(): Promise<Harness> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'sudo-e2e-'));
  const child = spawn('node', ['--import', 'tsx', 'src/cli.ts'], {
    cwd: PROJECT_ROOT,
    env: childEnv(port, dataDir),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const kill = (): Promise<void> => new Promise((resolve) => {
    if (child.exitCode !== null) { rmSync(dataDir, { recursive: true, force: true }); return resolve(); }
    const done = (): void => { rmSync(dataDir, { recursive: true, force: true }); resolve(); };
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 8000);
  });
  return { child, port, dataDir, kill };
}

export async function waitForHealth(port: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) { const j = await r.json() as { status?: string }; if (j.status === 'ok') return; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`gateway on :${port} did not become healthy within ${timeoutMs}ms`);
}

async function sendMessage(port: number, peerId: string, text: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E2E_TOKEN}` },
    body: JSON.stringify({ peerId, text }),
  });
}

/** Poll the child's mind.db for the latest assistant reply in a session. */
function latestReply(dataDir: string, peerId: string): string | null {
  const dbPath = join(dataDir, 'mind.db');
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      `SELECT m.content AS content FROM messages m JOIN sessions s ON m.session_id = s.id
       WHERE s.title = ? AND m.role = 'assistant' AND length(m.content) > 1
       ORDER BY m.rowid DESC LIMIT 1`,
    ).get(`web:${peerId}`) as { content?: string } | undefined;
    return row?.content ?? null;
  } catch { return null; }
  finally { db.close(); }
}

function cronJobsText(dataDir: string): string {
  const f = join(dataDir, 'cron', 'jobs.json');
  return existsSync(f) ? readFileSync(f, 'utf-8') : '';
}

export async function runScenario(h: Harness, s: Scenario): Promise<ScenarioResult> {
  const timeout = s.timeout_ms ?? 120_000;
  try {
    await sendMessage(h.port, s.peerId, s.message);
    if (s.message2) { await new Promise((r) => setTimeout(r, 3000)); await sendMessage(h.port, s.peerId, s.message2); }

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const reply = latestReply(h.dataDir, s.peerId);
      const replyOk = !s.expect_reply_regex || (reply != null && new RegExp(s.expect_reply_regex, 'i').test(reply))
        || (!!s.expect_reply2_regex && reply != null && new RegExp(s.expect_reply2_regex, 'i').test(reply));
      const cronOk = !s.expect_cron_job_regex || new RegExp(s.expect_cron_job_regex, 'i').test(cronJobsText(h.dataDir));
      if (replyOk && cronOk) return { name: s.name, passed: true, detail: `reply=${(reply ?? '').slice(0, 60)}` };
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { name: s.name, passed: false, detail: `timed out; last reply=${(latestReply(h.dataDir, s.peerId) ?? '(none)').slice(0, 80)}` };
  } catch (err) {
    return { name: s.name, passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), 'utf-8')) as unknown as Scenario);
}

export async function main(): Promise<void> {
  if (process.env['SUDO_E2E'] !== '1') { console.log('SUDO_E2E!=1 — skipping gateway E2E'); return; }
  const scenarioDir = join(PROJECT_ROOT, 'src/core/eval/gateway-e2e/scenarios');
  const scenarios = loadScenarios(scenarioDir);
  console.log(`gateway-e2e: booting child daemon for ${scenarios.length} scenario(s)…`);
  const h = await spawnGateway();
  const results: ScenarioResult[] = [];
  try {
    await waitForHealth(h.port);
    console.log(`gateway-e2e: child healthy on :${h.port} (dataDir ${h.dataDir})`);
    for (const s of scenarios) {
      const r = await runScenario(h, s);
      console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
      results.push(r);
    }
  } finally {
    await h.kill();
  }
  const failed = results.filter((r) => !r.passed).length;
  console.log(`gateway-e2e: ${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}
