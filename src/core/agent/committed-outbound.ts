/**
 * @file agent/committed-outbound.ts
 * @description Per-session "committed outbound side effect" evidence.
 *
 * A turn that has already sent a message, posted to a channel, spawned a
 * sub-agent, or created a cron job must NOT be blindly re-run on failure/retry —
 * doing so re-fires the side effect (and unlike the per-tool idempotency guard,
 * a re-run that REGENERATES slightly different content would slip past a
 * content-hash check). This is the run-level analog of the per-tool guard: the
 * agent loop marks the session the instant an outbound tool succeeds, the result
 * carries the flag, and the task queue refuses to auto-retry a task that already
 * committed outbound.
 *
 * Session-scoped and in-memory: it tracks evidence for the CURRENT run only.
 * cleared at run start. The durable gate lives on the task_queue row, which the
 * executor stamps from this flag — so the in-memory reset never loses a gate
 * decision.
 */

/** Tool names whose successful execution is an external, user-visible side effect. */
export function isOutboundToolName(name: string): boolean {
  if (typeof name !== 'string') return false;
  return (
    name.startsWith('comms.') ||
    name === 'message.send' ||
    name === 'sessions.spawn' ||
    name === 'cron.create'
  );
}

/** Session ids that have committed an outbound side effect this run. */
const committed = new Set<string>();

/** Record that `sessionId` performed an outbound side effect. No-op for empty id. */
export function markCommittedOutbound(sessionId: string | undefined | null): void {
  if (sessionId) committed.add(sessionId);
}

/** Whether `sessionId` has committed an outbound side effect this run. */
export function hasCommittedOutbound(sessionId: string | undefined | null): boolean {
  return !!sessionId && committed.has(sessionId);
}

/** Reset evidence for `sessionId` — called at the start of each run. */
export function clearCommittedOutbound(sessionId: string | undefined | null): void {
  if (sessionId) committed.delete(sessionId);
}
