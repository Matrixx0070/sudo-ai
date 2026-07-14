/**
 * textproc process runner (Spec 10): spawn with argv arrays only — no shell
 * string interpolation of user input, ever. Where a pipe is genuinely needed
 * (bytes extraction), callers use a FIXED bash template with user values
 * passed as positional parameters, which bash never re-parses as syntax.
 *
 * Output collection is byte-capped: the child is killed as soon as the cap
 * is exceeded, so a runaway `sed` over a multi-GB file cannot balloon memory
 * — the cap bounds RSS on our side and SIGKILL bounds the child.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when stdout was cut at maxBytes (child killed early — expected for previews). */
  truncated: boolean;
}

export interface RunOptions {
  /** Stream this file into the child's stdin (fallback scripts read stdin). */
  stdinFile?: string;
  /** Write this string to the child's stdin. Mutually exclusive with stdinFile. */
  stdinText?: string;
  timeoutMs?: number;
  /** Cap on collected stdout bytes (default 1 MiB). */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Run `cmd argv...` and collect capped output. Never throws — errors land in stderr/code. */
export function runArgv(cmd: string, argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        code,
        truncated,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes >= maxBytes) return;
      const room = maxBytes - outBytes;
      if (chunk.length > room) {
        out.push(chunk.subarray(0, room));
        outBytes = maxBytes;
        truncated = true;
        child.kill('SIGKILL'); // stop the stream at the cap — bounded memory
      } else {
        out.push(chunk);
        outBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes >= 16_384) return;
      err.push(chunk.subarray(0, 16_384 - errBytes));
      errBytes += chunk.length;
    });
    child.on('error', (e) => {
      err.push(Buffer.from(String(e)));
      finish(127);
    });
    child.on('close', (code, signal) => {
      // A cap/timeout SIGKILL with data collected is a successful preview.
      finish(code ?? (signal && (truncated || outBytes > 0) ? 0 : 1));
    });

    if (opts.stdinFile) {
      const rs = createReadStream(opts.stdinFile);
      rs.on('error', (e) => {
        err.push(Buffer.from(`stdin read failed: ${String(e)}`));
        child.kill('SIGKILL');
      });
      // EPIPE when the child exits early (head -c) is expected — swallow it.
      child.stdin.on('error', () => rs.destroy());
      rs.pipe(child.stdin);
    } else if (opts.stdinText !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.write(opts.stdinText);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Run a FIXED bash pipeline template with user values as positional args.
 * The template must reference values ONLY as "$1"…"$9" — never interpolate.
 */
export function runBashTemplate(template: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runArgv('/bin/bash', ['-c', template, '_', ...args], opts);
}
