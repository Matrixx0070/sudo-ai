/**
 * @file grok-livekit-bridge.ts
 * @description Node ↔ Python bridge for the Grok realtime voice turn over
 * LiveKit (grok-as-agent, browserless, seat-covered). Thin wrapper that spawns
 * `scripts/grok-web/grok_livekit_voice.py` (the only component needing Python:
 * the `livekit` WebRTC SDK + curl_cffi for the seat token mint). One JSON
 * request on stdin, one JSON response on stdout.
 *
 * SECRETS: the cookie is a session secret; it is passed on stdin ONLY and is
 * NEVER logged here (the python side never echoes it). Same-host invariant: the
 * python client must run on the machine that captured the session.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import type { GrokWebCreds, GrokWebErrorClass } from './grok-web-bridge.js';

const log = createLogger('llm:grok-livekit-bridge');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_livekit_voice.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';

/** One realtime voice turn: speak `inputWav`, capture the agent's reply to `outputPath`. */
export interface GrokLivekitRequest {
  inputWav: string;
  outputPath: string;
  /** Seconds to capture the agent reply after the user audio ends. Default 12. */
  captureSeconds?: number;
  timeoutSec?: number;
}

export interface GrokLivekitResponse {
  ok: boolean;
  path?: string;
  bytes?: number;
  durationMs?: number;
  sampleRate?: number;
  agentIdentity?: string;
  errorClass?: GrokWebErrorClass | 'no_agent' | 'no_audio' | 'bad_request';
  detail?: string;
}

export type SpawnFn = typeof spawn;

/**
 * Run one realtime voice turn. Resolves with the python response (including
 * structured `ok:false` errors); rejects never — a transport failure yields a
 * `bridge_error` response.
 */
export function callGrokLivekitBridge(
  req: GrokLivekitRequest,
  creds: GrokWebCreds,
  spawnFn: SpawnFn = spawn,
): Promise<GrokLivekitResponse> {
  const perOpMs = ((req.captureSeconds ?? 12) + 40) * 1000;
  const timeoutMs = Math.min(perOpMs, 180_000);

  return new Promise<GrokLivekitResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawnFn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

    const settle = (r: GrokLivekitResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => {
      log.warn({ timeoutMs }, 'grok-livekit bridge timed out');
      settle({ ok: false, errorClass: 'timeout', detail: `bridge timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (err: Error) => settle({ ok: false, errorClass: 'bridge_error', detail: `spawn failed: ${err.message}` }));
    child.on('close', (code: number | null) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        const parsed = JSON.parse(line) as GrokLivekitResponse;
        log.debug({ ok: parsed.ok, errorClass: parsed.errorClass, durationMs: parsed.durationMs }, 'grok-livekit bridge result');
        settle(parsed);
      } catch {
        settle({ ok: false, errorClass: 'bridge_error', detail: `no JSON from bridge (exit ${code}); stderr: ${stderr.slice(0, 200)}` });
      }
    });

    // Secrets go in ONLY here, on stdin. Never logged.
    try {
      child.stdin?.write(JSON.stringify({ ...req, ...creds }));
      child.stdin?.end();
    } catch (err) {
      settle({ ok: false, errorClass: 'bridge_error', detail: `stdin write failed: ${String(err)}` });
    }
  });
}
