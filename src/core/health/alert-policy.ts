/**
 * @file alert-policy.ts
 * @description Pure decision layer for watchdog health alerts.
 *
 * Turns a stream of per-check results into alert/recovery decisions with
 * anti-spam semantics: per-check cooldown, a consecutive-tick threshold for
 * degraded (transient blips stay silent), and a single recovery notice when
 * a previously-alerted check comes back healthy. No I/O — fully unit-testable.
 */

export type CheckStatus = 'healthy' | 'degraded' | 'critical';

export type AlertDecision =
  | { action: 'alert'; severity: 'high' | 'critical' }
  | { action: 'recovered' }
  | { action: 'none' };

export interface AlertPolicyOptions {
  /** Minimum ms between alerts for the same check. */
  cooldownMs: number;
  /** Consecutive degraded ticks required before a degraded check alerts. */
  degradedConsecutiveThreshold: number;
  /**
   * Re-send interval for a STILL-BROKEN, unchanged state. The 2026-07-18 fix:
   * cooldownMs used to double as a re-alert timer, so two permanently-degraded
   * checks produced 200+ identical Telegram messages/day. Now a check alerts on
   * STATE CHANGE (new alert, degraded→critical escalation, recovery) and
   * otherwise reminds at most once per reminderMs (default 24h).
   */
  reminderMs: number;
}

interface CheckAlertState {
  lastAlertAtMs: number;
  alerted: boolean;
  consecutiveDegraded: number;
  /** Severity of the last alert sent ('high' | 'critical'), when alerted. */
  lastSeverity: 'high' | 'critical' | null;
}

export class HealthAlertPolicy {
  private readonly opts: AlertPolicyOptions;
  private readonly state = new Map<string, CheckAlertState>();

  constructor(opts: AlertPolicyOptions) {
    this.opts = opts;
  }

  onCheckResult(name: string, status: CheckStatus, nowMs: number): AlertDecision {
    const st = this.state.get(name) ?? {
      lastAlertAtMs: Number.NEGATIVE_INFINITY,
      alerted: false,
      consecutiveDegraded: 0,
      lastSeverity: null as 'high' | 'critical' | null,
    };

    if (status === 'healthy') {
      const wasAlerted = st.alerted;
      st.alerted = false;
      st.consecutiveDegraded = 0;
      st.lastSeverity = null;
      this.state.set(name, st);
      return wasAlerted ? { action: 'recovered' } : { action: 'none' };
    }

    if (status === 'critical') {
      st.consecutiveDegraded = 0;
      // State change (first alert or degraded→critical escalation) always
      // alerts — an escalation must not be swallowed by the cooldown. An
      // unchanged critical state re-alerts only after reminderMs.
      const isChange = !st.alerted || st.lastSeverity !== 'critical';
      const reminderDue = nowMs - st.lastAlertAtMs >= this.opts.reminderMs;
      if (isChange || reminderDue) {
        st.lastAlertAtMs = nowMs;
        st.alerted = true;
        st.lastSeverity = 'critical';
        this.state.set(name, st);
        return { action: 'alert', severity: 'critical' };
      }
      this.state.set(name, st);
      return { action: 'none' };
    }

    // degraded
    st.consecutiveDegraded += 1;
    const pastThreshold = st.consecutiveDegraded >= this.opts.degradedConsecutiveThreshold;
    if (!pastThreshold) {
      this.state.set(name, st);
      return { action: 'none' };
    }
    // First alert for this episode: gated by cooldown (blip damper). A
    // critical→degraded de-escalation stays silent (recovery will speak when
    // healthy). An unchanged degraded state re-alerts only after reminderMs.
    const isNew = !st.alerted;
    const reminderDue = st.alerted && st.lastSeverity === 'high' && nowMs - st.lastAlertAtMs >= this.opts.reminderMs;
    if ((isNew && nowMs - st.lastAlertAtMs >= this.opts.cooldownMs) || reminderDue) {
      st.lastAlertAtMs = nowMs;
      st.alerted = true;
      st.lastSeverity = 'high';
      this.state.set(name, st);
      return { action: 'alert', severity: 'high' };
    }
    this.state.set(name, st);
    return { action: 'none' };
  }
}
