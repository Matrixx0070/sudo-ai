/**
 * log-ring.ts
 *
 * Bounded in-process log ring buffer for the `GET /api/admin/logs` endpoint
 * (gap #28b slice 3 — Hermes-parity admin powers).
 *
 * The ring captures lines written to `process.stdout` and `process.stderr` by
 * wrapping their `.write` methods. Capture is non-destructive: every original
 * write still happens, so PM2, journald, tee, and tests see the same output.
 *
 * Why monkey-patch instead of pipe: a stdout pipe would force buffering on
 * a foreign listener and could subtly alter flush behavior of the supervised
 * process; wrapping `.write` keeps the original sink path identical and only
 * forks a copy off into the ring.
 *
 * Kill switches:
 *   SUDO_DASHBOARD_LOG_RING_DISABLE=1 — `attachLogRing()` becomes a no-op,
 *     `globalThis.__sudoLogRing` stays undefined, and the dashboard logs
 *     endpoint reports "log_ring_not_registered".
 */

const DEFAULT_MAX_LINES = 5000;
const MAX_USER_LINES_REQUEST = 5000;
const DEFAULT_USER_LINES_REQUEST = 200;

/** One captured log line. */
export interface LogLine {
  /** ISO 8601 UTC timestamp. */
  ts: string;
  /** Source stream. */
  stream: 'stdout' | 'stderr';
  /** Raw line text WITH trailing newline stripped. */
  text: string;
}

/** Read API surface — what the dashboard endpoint calls. */
export interface LogRingReader {
  /**
   * Return the last `lines` entries (oldest → newest).
   * Caller-provided line counts are clamped to [1, MAX_USER_LINES_REQUEST].
   */
  tail(lines: number): LogLine[];
  /** Total lines currently buffered. */
  size(): number;
  /** Capacity of the ring buffer (max retained lines). */
  capacity(): number;
}

/**
 * Internal mutable ring + the install/uninstall surface — exported so the
 * test suite can construct a fresh instance without monkey-patching the
 * suite's own stdout.
 */
export class LogRing implements LogRingReader {
  private readonly buf: LogLine[] = [];
  private readonly max: number;
  /** Set when `attach()` is active so `detach()` can restore the originals. */
  private originalStdoutWrite: typeof process.stdout.write | null = null;
  private originalStderrWrite: typeof process.stderr.write | null = null;

  constructor(maxLines: number = DEFAULT_MAX_LINES) {
    if (!Number.isFinite(maxLines) || maxLines <= 0) {
      throw new Error('LogRing maxLines must be a positive finite number');
    }
    this.max = Math.floor(maxLines);
  }

  /**
   * Append a single line. Newlines IN the text are split into separate
   * entries so a single multi-line `console.log` call shows up correctly.
   * Lines longer than 8 KB are truncated with an explicit "[truncated]"
   * suffix so a runaway producer cannot bloat one slot.
   */
  push(stream: 'stdout' | 'stderr', text: string): void {
    if (text.length === 0) return;
    // Splitting on '\n' preserves intra-line content; trailing empty segment
    // (from text ending with '\n') is dropped because we want one entry per
    // logical line, not one per delimiter.
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i] ?? '';
      // Skip the trailing empty fragment that always follows a '\n' terminator.
      // Mid-string empty segments (blank lines emitted on purpose) are kept.
      if (i === parts.length - 1 && seg === '') continue;
      const trimmed = seg.length > 8192 ? seg.slice(0, 8192) + ' [truncated]' : seg;
      this.buf.push({ ts: new Date().toISOString(), stream, text: trimmed });
      if (this.buf.length > this.max) this.buf.shift();
    }
  }

  tail(lines: number): LogLine[] {
    let n = Math.floor(lines);
    if (!Number.isFinite(n) || n <= 0) n = DEFAULT_USER_LINES_REQUEST;
    if (n > MAX_USER_LINES_REQUEST) n = MAX_USER_LINES_REQUEST;
    // Caller's clamp ceiling may exceed our actual buffer length — slice
    // handles that with a no-throw clamp-to-length.
    const start = Math.max(0, this.buf.length - n);
    return this.buf.slice(start);
  }

  size(): number { return this.buf.length; }
  capacity(): number { return this.max; }

  /**
   * Wrap `process.stdout.write` and `process.stderr.write` so each line is
   * mirrored into the ring while still flowing to the original sink. Calling
   * `attach()` a second time on the same ring is a no-op so boot wiring is
   * idempotent.
   */
  attach(): void {
    if (this.originalStdoutWrite !== null || this.originalStderrWrite !== null) return;
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
    this.originalStderrWrite = process.stderr.write.bind(process.stderr);

    const wrap = (stream: 'stdout' | 'stderr', original: typeof process.stdout.write) => {
      // Returning the wrapper. Signature is intentionally widened — `process.stdout.write`
      // has 3 overloads (buffer, string+cb, string+encoding+cb) which TS sees as a union
      // function type. We forward all args verbatim to the original and only inspect the
      // first argument to push into the ring.
      return (...args: unknown[]): boolean => {
        try {
          const first = args[0];
          if (typeof first === 'string') {
            this.push(stream, first);
          } else if (first instanceof Uint8Array) {
            // Decode as UTF-8 best-effort; binary stdout would be rare for a
            // logging surface and decoded garbage is preferable to skipping.
            this.push(stream, Buffer.from(first).toString('utf8'));
          }
        } catch {
          // Capture must never break the underlying write — swallow.
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        return (original as any)(...args);
      };
    };

    process.stdout.write = wrap('stdout', this.originalStdoutWrite) as typeof process.stdout.write;
    process.stderr.write = wrap('stderr', this.originalStderrWrite) as typeof process.stderr.write;
  }

  /**
   * Restore the original write functions. Idempotent.
   *
   * **Stacking caveat.** If a third party monkey-patches `process.stdout
   * .write` AFTER `attach()` and BEFORE `detach()`, this restore writes
   * the original directly onto `process.stdout.write`, discarding that
   * third-party wrapper. Today no production code path stacks wrappers
   * (vault, dashboard, logger all use bound methods or pino transports);
   * the only stacking happens inside the test suite and is contained
   * with its own try/finally. If a second runtime interceptor is ever
   * added, swap this to a chain-aware restore (track-and-call-superior).
   */
  detach(): void {
    if (this.originalStdoutWrite !== null) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }
    if (this.originalStderrWrite !== null) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }
  }
}

interface LogRingGlobals { __sudoLogRing?: LogRingReader }
const ringGlobals = globalThis as LogRingGlobals;

/**
 * Construct + attach a process-wide ring and register it as
 * `globalThis.__sudoLogRing`. Called once from cli.ts §8.5b boot wiring.
 * Honors the `SUDO_DASHBOARD_LOG_RING_DISABLE=1` kill switch.
 *
 * **Idempotent across the global slot.** A second call returns the same
 * ring instance instead of layering a new wrap on top of the existing
 * one. Without this guard a hot-reload (or two test-suite setups that
 * forgot to `_clearRegisteredLogRing` between them) would stack
 * `wrap2(wrap1(original))`, making the first wrap unreachable and
 * un-detachable — silently doubling every log line and leaking the
 * original `process.stdout.write` reference forever.
 */
export function attachLogRing(maxLines: number = DEFAULT_MAX_LINES): LogRing | undefined {
  if (process.env['SUDO_DASHBOARD_LOG_RING_DISABLE'] === '1') return undefined;
  const existing = ringGlobals.__sudoLogRing;
  if (existing instanceof LogRing) return existing;
  const ring = new LogRing(maxLines);
  ring.attach();
  ringGlobals.__sudoLogRing = ring;
  return ring;
}

/** Registered ring (process-wide), or `undefined` when not attached. */
export function getRegisteredLogRing(): LogRingReader | undefined {
  return ringGlobals.__sudoLogRing;
}

/** Test-only: clear the global ring registration (does not detach an attached ring). */
export function _clearRegisteredLogRing(): void {
  delete ringGlobals.__sudoLogRing;
}
