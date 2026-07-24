/**
 * PulseAudioSink — a private PulseAudio server with a `grokvoice` null sink.
 *
 * This is the audio plumbing for the Path A grok voice-mode relay (grok-as-agent
 * realtime voice). The box has NO hardware sound (`/dev/snd` = seq/timer only),
 * so a null sink is the only headless capture path — PROVEN to work: a tone
 * played into the sink is recovered from `<sink>.monitor`.
 *
 *   - agent OUT: grok's browser plays its synthesized voice into the null sink;
 *     `captureMonitor()` taps `<sink>.monitor` with ffmpeg to a WAV.
 *   - agent IN: a fake-mic WAV (fed to Chrome via
 *     --use-file-for-fake-audio-capture) carries the user/agent audio into grok;
 *     `fakeMicPath()` is where the relay writes it.
 *
 * Everything runs against a PRIVATE server on a dedicated XDG_RUNTIME_DIR, so it
 * never touches the system PulseAudio. Owner/flag gating lives in the relay
 * service that drives this, not here.
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('voice:pulse');

/** Result of running one command. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Injectable command runner. `timeoutMs` (when set) sends SIGTERM after the
 * deadline and resolves normally — used to bound a `parec` capture to a fixed
 * duration while keeping whatever it has written so far.
 */
export type RunFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs?: number },
) => Promise<RunResult>;

const defaultRun: RunFn = (cmd, args, opts) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, { env: opts.env });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    if (opts.timeoutMs) {
      timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, opts.timeoutMs);
    }
    child.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(err) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });

export interface PulseAudioSinkOptions {
  /** Dedicated runtime dir for the private server. Default /tmp/pa-grokvoice. */
  runtimeDir?: string;
  /** Null sink name. Default "grokvoice". */
  sinkName?: string;
  /** Injectable command runner (defaults to child_process spawn). */
  run?: RunFn;
}

export class PulseAudioSink {
  readonly runtimeDir: string;
  readonly sinkName: string;
  private readonly run: RunFn;
  private started = false;

  constructor(opts: PulseAudioSinkOptions = {}) {
    this.runtimeDir = opts.runtimeDir ?? '/tmp/pa-grokvoice';
    this.sinkName = opts.sinkName ?? 'grokvoice';
    this.run = opts.run ?? defaultRun;
  }

  /** The monitor source name to record the sink's playback from. */
  get monitorSource(): string {
    return `${this.sinkName}.monitor`;
  }

  /** Path the relay writes the fake-mic WAV to (agent IN → Chrome). */
  fakeMicPath(): string {
    return path.join(this.runtimeDir, 'fake-mic.wav');
  }

  private env(): Record<string, string> {
    return { ...process.env, XDG_RUNTIME_DIR: this.runtimeDir } as Record<string, string>;
  }

  /**
   * Start a private PulseAudio daemon with the null sink. Idempotent: if the
   * sink is already present it returns without spawning a second daemon.
   */
  async start(): Promise<void> {
    if (this.started && (await this.sinkPresent())) return;
    const r = await this.run(
      'pulseaudio',
      [
        '-n',
        '--daemonize=yes',
        '--exit-idle-time=-1',
        '--load=module-native-protocol-unix',
        `--load=module-null-sink sink_name=${this.sinkName} sink_properties=device.description=${this.sinkName}`,
      ],
      { env: this.env() },
    );
    if (r.code !== 0) {
      throw new Error(`pulseaudio failed to start (exit ${r.code}): ${r.stderr.slice(0, 300)}`);
    }
    if (!(await this.sinkPresent())) {
      throw new Error(`null sink "${this.sinkName}" did not appear after starting PulseAudio`);
    }
    this.started = true;
    log.info({ sink: this.sinkName, runtimeDir: this.runtimeDir }, 'grokvoice null sink ready');
  }

  /** True when the null sink is listed by the private server. */
  async sinkPresent(): Promise<boolean> {
    const r = await this.run('pactl', ['list', 'short', 'sinks'], { env: this.env() });
    return r.code === 0 && r.stdout.split('\n').some((l) => l.split('\t')[1] === this.sinkName);
  }

  /**
   * Capture the sink's monitor (agent OUT) for `durationMs` into a mono WAV.
   * Uses `ffmpeg -f pulse -t <dur>` (not `parec`): ffmpeg records an exact
   * duration and finalizes the file itself — `parec` has to be signalled to
   * stop and drops its buffered PCM on SIGTERM (writes only the header).
   */
  async captureMonitor(
    durationMs: number,
    outPath: string,
    opts: { sampleRate?: number; channels?: number } = {},
  ): Promise<string> {
    const seconds = (durationMs / 1000).toFixed(3);
    const r = await this.run(
      'ffmpeg',
      [
        '-y', '-f', 'pulse', '-i', this.monitorSource,
        '-t', seconds,
        '-ac', String(opts.channels ?? 1),
        '-ar', String(opts.sampleRate ?? 24000),
        '-c:a', 'pcm_s16le', outPath, '-loglevel', 'error',
      ],
      { env: this.env(), timeoutMs: durationMs + 5000 }, // safety cap; ffmpeg self-terminates at -t
    );
    if (r.code !== 0) {
      throw new Error(`ffmpeg pulse capture failed (exit ${r.code}): ${r.stderr.slice(0, 300)}`);
    }
    return outPath;
  }

  /** Kill the private daemon and remove its runtime dir. Best-effort. */
  async stop(): Promise<void> {
    await this.run('pulseaudio', ['--kill'], { env: this.env() }).catch(() => undefined);
    await rm(this.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    this.started = false;
    log.info({ sink: this.sinkName }, 'grokvoice null sink stopped');
  }
}
