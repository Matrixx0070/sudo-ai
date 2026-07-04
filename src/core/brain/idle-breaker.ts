/**
 * @file brain/idle-breaker.ts
 * @description Cross-call circuit breaker against runaway paid fan-out to a
 * wedged provider.
 *
 * The failover loop already bounds ONE brain call to MAX_FAILOVER_ATTEMPTS, and
 * providers.ts bounds a single stalled claude-oauth stream (headers + body-idle
 * timeout). Neither stops the CROSS-CALL case: a provider that accepts the
 * connection but never streams anything makes every attempt idle-time-out, and
 * the agent loop calls the brain once per iteration — so a wedged tier can fan
 * out hundreds of paid attempts across a single turn before anything gives up.
 * (OpenClaw's embedded runtime added the same guard after one heartbeat fired
 * 761–1384 paid Anthropic calls in 60s; our own heartbeat cost-bomb history is
 * the same failure shape.)
 *
 * This tracks CONSECUTIVE attempts that idle-timed-out WITHOUT producing durable
 * output, keyed on real progress — a completed turn resets it; partial tokens
 * before a stall do NOT (a provider dribbling then stalling must not defeat the
 * guard). After `maxConsecutive` trips the breaker OPENS and new calls
 * short-circuit instead of paying for another wedge. It auto-recovers: after
 * `cooldownMs` it half-opens and lets a single probe through, so a transient
 * provider outage doesn't wedge the brain until process restart.
 *
 * Env:
 *   SUDO_BRAIN_IDLE_BREAKER_MAX          consecutive idle timeouts to trip (default 5; 0 disables)
 *   SUDO_BRAIN_IDLE_BREAKER_COOLDOWN_MS  half-open probe delay once open (default 60000)
 */

function envInt(name: string, def: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : def;
}

export interface BrainIdleBreakerOptions {
  /** Consecutive idle timeouts before the breaker opens. 0 disables the breaker. */
  maxConsecutive?: number;
  /** Delay after opening before a single half-open probe is allowed through. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class BrainIdleBreaker {
  private consecutive = 0;
  private openedAt: number | null = null;
  private readonly maxConsecutive: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: BrainIdleBreakerOptions = {}) {
    this.maxConsecutive = opts.maxConsecutive ?? envInt('SUDO_BRAIN_IDLE_BREAKER_MAX', 5);
    this.cooldownMs = opts.cooldownMs ?? envInt('SUDO_BRAIN_IDLE_BREAKER_COOLDOWN_MS', 60_000);
    this.now = opts.now ?? Date.now;
  }

  /** Whether the breaker is entirely disabled (threshold 0). */
  get disabled(): boolean {
    return this.maxConsecutive <= 0;
  }

  /**
   * Should a NEW brain call be blocked right now? True only while the breaker is
   * open AND the cooldown has not elapsed. Once the cooldown passes it returns
   * false (half-open) to let a single probe attempt through; the probe's outcome
   * (recordDurableProgress / recordIdleTimeout) then closes or re-opens it.
   */
  shouldBlock(): boolean {
    if (this.disabled) return false;
    if (this.consecutive < this.maxConsecutive || this.openedAt === null) return false;
    return this.now() - this.openedAt < this.cooldownMs;
  }

  /** A completed turn / real output — the provider is healthy. Fully closes the breaker. */
  recordDurableProgress(): void {
    this.consecutive = 0;
    this.openedAt = null;
  }

  /**
   * An attempt that idle-timed-out with no durable output. Increments the streak
   * and, on reaching the threshold, (re)stamps the open time so the cooldown
   * window restarts. Returns the new consecutive count.
   */
  recordIdleTimeout(): number {
    this.consecutive += 1;
    if (this.consecutive >= this.maxConsecutive) {
      this.openedAt = this.now();
    }
    return this.consecutive;
  }

  /** Human-readable reason for the short-circuit error / logs. */
  reason(): string {
    return `brain idle circuit open: ${this.consecutive} consecutive provider idle-timeouts with no output; `
      + `pausing new calls for ${this.cooldownMs}ms to avoid runaway paid fan-out `
      + `(SUDO_BRAIN_IDLE_BREAKER_MAX=${this.maxConsecutive})`;
  }

  /** Snapshot for structured logging / tests. */
  snapshot(): { consecutive: number; open: boolean; maxConsecutive: number } {
    return { consecutive: this.consecutive, open: this.shouldBlock(), maxConsecutive: this.maxConsecutive };
  }
}
