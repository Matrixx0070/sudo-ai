/**
 * BrainIdleBreaker — cross-call guard against runaway paid fan-out to a wedged
 * provider. Trips after N consecutive idle-timeouts with no output, blocks new
 * calls during a cooldown, half-opens after it, and fully closes on real
 * progress. Clock is injected so no wall-clock/timers are needed.
 */
import { describe, it, expect } from 'vitest';
import { BrainIdleBreaker } from '../../src/core/brain/idle-breaker.js';

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('BrainIdleBreaker', () => {
  it('does not block below the threshold', () => {
    const b = new BrainIdleBreaker({ maxConsecutive: 3, cooldownMs: 1000, now: () => 0 });
    b.recordIdleTimeout();
    b.recordIdleTimeout();
    expect(b.shouldBlock()).toBe(false);
  });

  it('opens (blocks) once N consecutive idle-timeouts are reached', () => {
    const clk = makeClock();
    const b = new BrainIdleBreaker({ maxConsecutive: 3, cooldownMs: 1000, now: clk.now });
    b.recordIdleTimeout();
    b.recordIdleTimeout();
    const n = b.recordIdleTimeout();
    expect(n).toBe(3);
    expect(b.shouldBlock()).toBe(true);
  });

  it('durable progress fully closes the breaker and resets the streak', () => {
    const b = new BrainIdleBreaker({ maxConsecutive: 2, cooldownMs: 1000, now: () => 0 });
    b.recordIdleTimeout();
    b.recordIdleTimeout();
    expect(b.shouldBlock()).toBe(true);
    b.recordDurableProgress();
    expect(b.shouldBlock()).toBe(false);
    // A fresh idle timeout must start counting from zero again.
    b.recordIdleTimeout();
    expect(b.shouldBlock()).toBe(false);
  });

  it('half-opens after the cooldown so a probe can get through', () => {
    const clk = makeClock();
    const b = new BrainIdleBreaker({ maxConsecutive: 2, cooldownMs: 60_000, now: clk.now });
    b.recordIdleTimeout();
    b.recordIdleTimeout();
    expect(b.shouldBlock()).toBe(true);        // open
    clk.advance(59_999);
    expect(b.shouldBlock()).toBe(true);         // still within cooldown
    clk.advance(2);
    expect(b.shouldBlock()).toBe(false);        // half-open: probe allowed
  });

  it('re-opens and restarts the cooldown when the probe also idle-times-out', () => {
    const clk = makeClock();
    const b = new BrainIdleBreaker({ maxConsecutive: 2, cooldownMs: 1000, now: clk.now });
    b.recordIdleTimeout();
    b.recordIdleTimeout();
    clk.advance(1001);
    expect(b.shouldBlock()).toBe(false);        // half-open
    b.recordIdleTimeout();                       // probe failed
    expect(b.shouldBlock()).toBe(true);          // re-opened, cooldown restarted
    clk.advance(999);
    expect(b.shouldBlock()).toBe(true);
  });

  it('is disabled when maxConsecutive is 0', () => {
    const b = new BrainIdleBreaker({ maxConsecutive: 0, cooldownMs: 1000, now: () => 0 });
    expect(b.disabled).toBe(true);
    for (let i = 0; i < 20; i++) b.recordIdleTimeout();
    expect(b.shouldBlock()).toBe(false);
  });

  it('reads threshold/cooldown from env when options are absent', () => {
    const prevMax = process.env['SUDO_BRAIN_IDLE_BREAKER_MAX'];
    const prevCd = process.env['SUDO_BRAIN_IDLE_BREAKER_COOLDOWN_MS'];
    process.env['SUDO_BRAIN_IDLE_BREAKER_MAX'] = '2';
    process.env['SUDO_BRAIN_IDLE_BREAKER_COOLDOWN_MS'] = '500';
    try {
      const b = new BrainIdleBreaker({ now: () => 0 });
      b.recordIdleTimeout();
      b.recordIdleTimeout();
      expect(b.shouldBlock()).toBe(true);
      expect(b.snapshot().maxConsecutive).toBe(2);
    } finally {
      if (prevMax === undefined) delete process.env['SUDO_BRAIN_IDLE_BREAKER_MAX'];
      else process.env['SUDO_BRAIN_IDLE_BREAKER_MAX'] = prevMax;
      if (prevCd === undefined) delete process.env['SUDO_BRAIN_IDLE_BREAKER_COOLDOWN_MS'];
      else process.env['SUDO_BRAIN_IDLE_BREAKER_COOLDOWN_MS'] = prevCd;
    }
  });
});
