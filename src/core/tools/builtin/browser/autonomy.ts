/**
 * @file autonomy.ts
 * @description Unattended-mode switch for browser/computer tools.
 *
 * `computer.use` and `browser.auth` ship with requiresConfirmation:true, which
 * stalls an unattended agent waiting for a human. For a fully-autonomous personal
 * agent that gate is wrong on the happy path — but blanket-removing it is unsafe,
 * so per the narrow-autonomy posture it stays ON by default and is lifted only
 * when the operator opts in with SUDO_BROWSER_UNATTENDED=1.
 *
 * When unattended, safety is enforced by the runtime guardrails instead of a
 * per-call prompt: the ConfidenceGate (SUDO_VERIFY_GATE) evaluates destructive
 * tools by rolling success rate, and the StuckDetector / DoomLoop abort runaway
 * loops. So this trades a human prompt for the automated escalation path, rather
 * than removing safety.
 */

/**
 * True when the operator has enabled unattended browser/computer operation.
 * Read at module-load time by the affected tools; set it before starting the agent.
 */
export function unattendedEnabled(): boolean {
  return process.env['SUDO_BROWSER_UNATTENDED'] === '1';
}

/**
 * Value for a tool's `requiresConfirmation`: confirm unless unattended mode is on.
 */
export function requiresConfirmationDefault(): boolean {
  return !unattendedEnabled();
}
