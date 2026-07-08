/**
 * @file slim-heartbeat.ts
 * @description Slim-context gating for the system.heartbeat health tick.
 *
 * Every heartbeat tick (~48/day at the 30-min interval) used to carry the full
 * agent loadout — the complete assembled system prompt (~28-29k tokens) plus
 * the full routed toolset — only to reply "HEARTBEAT_OK" on a healthy system.
 * This module decides when a cron agent-turn may use the minimal heartbeat
 * prompt + tool allowlist instead.
 *
 * Scope is deliberately narrow: ONLY the job literally named
 * `system.heartbeat` (see HeartbeatRunner) qualifies. Commitment follow-ups
 * (`commitment:*`), self-build sentinels, and user-created cron agent turns
 * are real work and keep the normal prompt/tools — the gate keys on the job
 * NAME, never on "came from cron" or on the payload's lightContext flag
 * (commitment jobs set lightContext too).
 *
 * Kill-switch: SUDO_SLIM_HEARTBEAT=0 restores the full loadout (default ON,
 * matching the repo's default-on convention). Every consumer of this gate is
 * fail-open: if the slim path errors at any stage, the full prompt/tools run.
 */

/** The HeartbeatRunner job name (mirrors HEARTBEAT_JOB_NAME in heartbeat.ts). */
export const HEARTBEAT_JOB_NAME = 'system.heartbeat' as const;

/** Default ON; SUDO_SLIM_HEARTBEAT=0 disables. Read at call time so tests can toggle. */
export function isSlimHeartbeatEnabled(): boolean {
  return process.env['SUDO_SLIM_HEARTBEAT'] !== '0';
}

/**
 * Should this cron agent-turn use the slim heartbeat context?
 * True ONLY for the system.heartbeat job with the kill-switch not thrown.
 */
export function shouldSlimHeartbeatTurn(jobName: string): boolean {
  return jobName === HEARTBEAT_JOB_NAME && isSlimHeartbeatEnabled();
}

/**
 * Tool allowlist for heartbeat ticks — exactly what workspace/HEARTBEAT.md
 * instructs the agent to run (system-health, cost-check, task-sweep sections)
 * plus the escape hatches (exec for `pm2 restart`, tool.search for anything
 * unforeseen). ~8 schemas instead of the ~23 the full router sends.
 */
export const SLIM_HEARTBEAT_TOOLS: readonly string[] = [
  'system.self-diagnostic', // HEARTBEAT.md system-health
  'automation.cron-health', // HEARTBEAT.md system-health
  'meta.cost-tracker',      // HEARTBEAT.md cost-check
  'meta.task-manager',      // HEARTBEAT.md task-sweep
  'meta.health-check',      // general health probe
  'meta.service-control',   // safe remediation (service restart)
  'system.exec',            // pm2 restart / log reads per HEARTBEAT.md
  'meta.search-tools',      // escape hatch — find anything not listed
] as const;
