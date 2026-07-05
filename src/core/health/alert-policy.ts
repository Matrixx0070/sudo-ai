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
}

interface CheckAlertState {
  lastAlertAtMs: number;
  alerted: boolean;
  consecutiveDegraded: number;
}

export class HealthAlertPolicy {
  private readonly opts: AlertPolicyOptions;
  private readonly state = new Map<string, CheckAlertState>();

  constructor(opts: AlertPolicyOptions) {
    this.opts = opts;
  }

  onCheckResult(name: string, status: CheckStatus, nowMs: number): AlertDecision {
    const st = this.state.get(name) ?? { lastAlertAtMs: Number.NEGATIVE_INFINITY, alerted: false, consecutiveDegraded: 0 };

    if (status === 'healthy') {
      const wasAlerted = st.alerted;
      st.alerted = false;
      st.consecutiveDegraded = 0;
      this.state.set(name, st);
      return wasAlerted ? { action: 'recovered' } : { action: 'none' };
    }

    if (status === 'critical') {
      st.consecutiveDegraded = 0;
      if (nowMs - st.lastAlertAtMs >= this.opts.cooldownMs) {
        st.lastAlertAtMs = nowMs;
        st.alerted = true;
        this.state.set(name, st);
        return { action: 'alert', severity: 'critical' };
      }
      st.alerted = true;
      this.state.set(name, st);
      return { action: 'none' };
    }

    // degraded
    st.consecutiveDegraded += 1;
    if (
      st.consecutiveDegraded >= this.opts.degradedConsecutiveThreshold &&
      nowMs - st.lastAlertAtMs >= this.opts.cooldownMs
    ) {
      st.lastAlertAtMs = nowMs;
      st.alerted = true;
      this.state.set(name, st);
      return { action: 'alert', severity: 'high' };
    }
    this.state.set(name, st);
    return { action: 'none' };
  }
}
