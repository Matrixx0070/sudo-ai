/**
 * @file sessions/run-generation.ts
 * @description RunGenerationRegistry — invalidation tokens for in-flight
 * agent turns.
 *
 * Each conversation key (`${channel}:${peerId}`) carries a monotonically
 * increasing generation number. Turn handlers capture the generation before
 * calling the agent loop and discard the reply when it changed while the
 * turn was running. Without this, /reset archives the session but the stale
 * in-flight reply is still delivered to the user afterwards.
 */

export class RunGenerationRegistry {
  private readonly generations = new Map<string, number>();

  /** Current generation for a conversation key (0 if never bumped). */
  current(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  /** Invalidate all in-flight turns for a key. Returns the new generation. */
  bump(key: string): number {
    const next = this.current(key) + 1;
    this.generations.set(key, next);
    return next;
  }

  /** True when a turn that started at `generation` has been invalidated. */
  isStale(key: string, generation: number): boolean {
    return this.current(key) !== generation;
  }
}

/** Module-level singleton shared by turn handlers and control commands. */
export const runGenerations = new RunGenerationRegistry();
