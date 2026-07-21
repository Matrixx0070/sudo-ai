/**
 * @file grok-voice-session.ts
 * @description A PERSISTENT realtime voice session with grok's voice agent over
 * LiveKit (grok-as-agent), on the $30 seat. Unlike grok-realtime-voice.ts (one
 * turn, connect-per-turn), this keeps ONE LiveKit room open across many turns, so
 * grok's conversation context persists and there is no per-turn join latency.
 *
 * Manages the persistent `scripts/grok-web/grok_livekit_session.py` process
 * (line-delimited JSON protocol): `start()` joins the room, `speak(wav)` runs one
 * turn (grok's server-side VAD handles turn-taking + barge-in; the python client
 * segments the reply by audio onset + trailing silence), `stop()` leaves.
 *
 * Gated by `SUDO_GROK_WEBSESSION`; secrets stay in the on-disk session file the
 * python reads locally — never passed through logs.
 */

import { spawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import { getGrokWebSessionManager, type GrokWebSessionManager } from './grok-web-session-manager.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-voice-session');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_livekit_session.py');
const SESSION_PATH = path.join(DATA_DIR, 'grok-web-session.json');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';
const WORK_DIR = path.join(DATA_DIR, 'grok-realtime-voice');

interface SessionEvent {
  event: 'ready' | 'reply' | 'error' | 'bye';
  agentIdentity?: string;
  turn?: number;
  path?: string;
  durationMs?: number;
  errorClass?: string;
  detail?: string;
}

export interface GrokVoiceTurnResult {
  replyWav: Buffer;
  durationMs: number;
  turn: number;
}

export interface GrokVoiceSessionDeps {
  spawnFn?: typeof spawn;
  manager?: GrokWebSessionManager;
}

/** A persistent multi-turn realtime voice session with grok's agent. */
export class GrokVoiceSession {
  private readonly spawnFn: typeof spawn;
  private readonly manager: GrokWebSessionManager;
  private child: ReturnType<typeof spawn> | null = null;
  private rl: Interface | null = null;
  /** Resolver for the reply of the turn currently in flight (one at a time). */
  private pendingReply: ((e: SessionEvent) => void) | null = null;
  private turnCount = 0;

  constructor(deps: GrokVoiceSessionDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.manager = deps.manager ?? getGrokWebSessionManager();
  }

  /** Join the room. Resolves once grok's agent is present ("ready"). */
  async start(timeoutMs = 30_000): Promise<{ agentIdentity?: string }> {
    if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
    await this.manager.ensureHealthy(); // refresh/validate the on-disk session
    await mkdir(WORK_DIR, { recursive: true });

    const child = this.spawnFn(PYTHON_BIN, [SCRIPT_PATH, SESSION_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.rl = createInterface({ input: child.stdout! });
    this.rl.on('line', (line) => this.onLine(line));

    return new Promise<{ agentIdentity?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grok voice session did not become ready in time')), timeoutMs);
      this.readyWaiter = { resolve: (id) => { clearTimeout(timer); resolve(id); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
  }

  private readyWaiter: { resolve: (v: { agentIdentity?: string }) => void; reject: (e: Error) => void } | null = null;

  private onLine(line: string): void {
    let e: SessionEvent;
    try { e = JSON.parse(line) as SessionEvent; } catch { return; }
    if (e.event === 'ready') {
      this.readyWaiter?.resolve({ ...(e.agentIdentity ? { agentIdentity: e.agentIdentity } : {}) });
      this.readyWaiter = null;
    } else if (e.event === 'reply') {
      this.pendingReply?.(e);
      this.pendingReply = null;
    } else if (e.event === 'error') {
      const err = new Error(`grok voice session error: ${e.errorClass ?? 'unknown'}${e.detail ? ` (${e.detail})` : ''}`);
      if (this.readyWaiter) { this.readyWaiter.reject(err); this.readyWaiter = null; }
      if (this.pendingReply) { const p = this.pendingReply; this.pendingReply = null; p({ event: 'error', detail: err.message }); }
    }
  }

  /** Run one turn: speak `inputWav`, return grok's spoken reply. */
  async speak(inputWav: Buffer, timeoutMs = 60_000): Promise<GrokVoiceTurnResult> {
    if (!this.child) throw new Error('session not started');
    if (this.pendingReply) throw new Error('a turn is already in flight');
    const n = ++this.turnCount;
    const inPath = path.join(WORK_DIR, `sess-in-${n}.wav`);
    const outPath = path.join(WORK_DIR, `sess-reply-${n}.wav`);
    await writeFile(inPath, inputWav, { mode: 0o600 });

    try {
      const ev = await new Promise<SessionEvent>((resolve, reject) => {
        const timer = setTimeout(() => { this.pendingReply = null; reject(new Error('turn timed out')); }, timeoutMs);
        this.pendingReply = (e) => { clearTimeout(timer); resolve(e); };
        this.child!.stdin!.write(JSON.stringify({ cmd: 'speak', wav: inPath, out: outPath }) + '\n');
      });
      if (ev.event === 'error') throw new Error(ev.detail ?? 'turn failed');
      if (!ev.path) throw new Error('grok voice turn produced no reply');
      const replyWav = await readFile(ev.path);
      log.info({ turn: ev.turn, bytes: replyWav.length, durationMs: ev.durationMs }, 'grok voice session turn complete');
      return { replyWav, durationMs: ev.durationMs ?? 0, turn: ev.turn ?? n };
    } finally {
      await rm(inPath, { force: true }).catch(() => undefined);
      await rm(outPath, { force: true }).catch(() => undefined);
    }
  }

  /** Leave the room and stop the process. */
  async stop(): Promise<void> {
    if (!this.child) return;
    try { this.child.stdin?.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* gone */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { this.child?.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 5_000);
      this.child?.on('close', () => { clearTimeout(t); resolve(); });
    });
    this.rl?.close();
    this.child = null;
    this.rl = null;
  }
}

export { GrokWebDisabledError, isGrokWebSessionEnabled };
