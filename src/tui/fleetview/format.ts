/**
 * @file src/tui/fleetview/format.ts
 * @description Small pure formatters for the FleetView TUI (gap #25 slice 2).
 *
 * Kept separate from app.tsx so unit tests don't have to import ink/JSX. All
 * functions are pure and deterministic; the unit-test surface is essentially
 * the spec for what the TUI promises to display.
 */

/** Format a duration in ms as a compact human-readable string. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm.toString().padStart(2, '0')}m`;
}

/** Truncate a sub-agent id to a fixed prefix length for the TUI table. */
export function shortId(id: string, prefixLen = 8): string {
  if (!id) return '';
  if (id.length <= prefixLen) return id;
  return id.slice(0, prefixLen);
}

/** Wrap a task description for terminal columns; preserves whole words when possible. */
export function clipTask(task: string, maxLen: number): string {
  if (!task) return '';
  if (task.length <= maxLen) return task;
  return `${task.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Render the summary line "slots U/M  queued Q  idle I". */
export function summaryLine(args: {
  slotsUsed: number;
  slotsMax: number;
  queueWaiting: number;
  idleCount: number;
}): string {
  return `slots ${args.slotsUsed}/${args.slotsMax}  queued ${args.queueWaiting}  idle ${args.idleCount}`;
}
