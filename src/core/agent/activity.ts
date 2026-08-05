/**
 * @file agent/activity.ts
 * @description Is the agent currently serving a person?
 *
 * Background work (mission advancement) must never land while the owner is
 * mid-conversation — OpenClaw's heartbeat gates every wake on exactly this and
 * retries the skip. sudo-ai had no equivalent signal, so the first mission
 * scheduler fired on a blind timer regardless of what the machine was doing.
 *
 * Deliberately counts USER-facing turns only. Mission turns themselves run
 * through the cron seam and must NOT mark the system busy, or a mission would
 * block its own next step.
 */

let activeUserTurns = 0;
let activeCronJobs = 0;

/** Mark a user-facing turn started. Returns the matching `end` (idempotent). */
export function beginUserTurn(): () => void {
  activeUserTurns += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeUserTurns = Math.max(0, activeUserTurns - 1);
  };
}

/**
 * Mark a cron job running. OpenClaw's heartbeat skips on
 * HEARTBEAT_SKIP_CRON_IN_PROGRESS for the same reason: two autonomous work
 * turns competing for the machine is worse than either waiting.
 * NOTE: mission advances do NOT pass through the cron runner, so this can
 * never make a mission block itself.
 */
export function beginCronJob(): () => void {
  activeCronJobs += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeCronJobs = Math.max(0, activeCronJobs - 1);
  };
}

/** True while at least one user-facing turn is in flight. */
export function isServingUser(): boolean {
  return activeUserTurns > 0;
}

/** True while at least one cron job is running. */
export function isCronActive(): boolean {
  return activeCronJobs > 0;
}

/** The single busy predicate background work should gate on. */
export function isMachineBusy(): boolean {
  return isServingUser() || isCronActive();
}

/** Current count — for logs and tests. */
export function activeUserTurnCount(): number {
  return activeUserTurns;
}

/** Test seam. */
export function __resetActivityForTests(): void {
  activeUserTurns = 0;
  activeCronJobs = 0;
}
