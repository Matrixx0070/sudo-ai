/**
 * @file tests/security/gw7-audit-cli.test.ts
 * @description GW-7 — the `security-audit` check catalog + --fix whitelist.
 * Each check is exercised with a synthetic env/fixture; contextual severity
 * flips are asserted; --fix is proven to only touch its whitelist; the exit-code
 * contract is checked. (Distinct from the OSV dependency audit tests in
 * security-audit.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import {
  runAuditChecks,
  fixableFindings,
  SENSITIVE_FILES,
  type AuditDeps,
} from '../../src/core/security/security-audit.js';
import { applyFixes } from '../../src/cli/commands/security-audit.js';
import { CONTRADICTIONS } from '../../src/core/config/flag-lint.js';

function deps(env: NodeJS.ProcessEnv, over: Partial<AuditDeps> = {}): AuditDeps {
  return {
    env,
    manifest: ['SUDO_KNOWN_FLAG'],
    fileExists: () => false,
    fileMode: () => null,
    ...over,
  };
}

/** A clean baseline: budget on, loopback, no weakening flags. SUDO_KAIROS=0
 * because Kairos restart authority is default-ON (GW-3c) and the audit rightly
 * flags it HIGH otherwise. */
function cleanEnv(): NodeJS.ProcessEnv {
  return { SUDO_DAILY_LLM_BUDGET_USD: '5', SUDO_SECRETS_REF: '0', SUDO_KAIROS: '0' };
}

describe('GW-7 runAuditChecks', () => {
  it('a clean-ish env produces no HIGH/CRITICAL (exit 0)', () => {
    const r = runAuditChecks(deps(cleanEnv()));
    expect(r.findings.some((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL')).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('budget off → HIGH (exit 1)', () => {
    const r = runAuditChecks(deps({ SUDO_SECRETS_REF: '0', SUDO_KAIROS: '0' }));
    expect(r.findings.find((f) => f.id === 'budget.off')?.severity).toBe('HIGH');
    expect(r.exitCode).toBe(1);
  });

  it('SUDO_SANDBOX_DISABLE severity is contextual: MEDIUM alone, CRITICAL with untrusted inbound', () => {
    const base = { ...cleanEnv(), SUDO_SANDBOX_DISABLE: '1' };
    const alone = runAuditChecks(deps(base));
    expect(alone.findings.find((f) => f.id === 'posture.SUDO_SANDBOX_DISABLE')?.severity).toBe('MEDIUM');
    expect(alone.exitCode).toBe(0);

    const exposed = runAuditChecks(deps({ ...base, WEBHOOKS_ENABLED: '1' }));
    expect(exposed.findings.find((f) => f.id === 'posture.SUDO_SANDBOX_DISABLE')?.severity).toBe('CRITICAL');
    expect(exposed.exitCode).toBe(2);
  });

  it('ghost flag → LOW finding', () => {
    const r = runAuditChecks(deps({ ...cleanEnv(), SUDO_TOTALLY_MADE_UP: '1' }));
    const ghost = r.findings.find((f) => f.id === 'flags.ghost.SUDO_TOTALLY_MADE_UP');
    expect(ghost?.severity).toBe('LOW');
  });

  it('contradiction check reuses the GW-10 table (shared source of truth)', () => {
    expect(CONTRADICTIONS.some((c) => c.id === 'sandbox-disabled-with-untrusted-inbound')).toBe(true);
    const r = runAuditChecks(deps({ ...cleanEnv(), SUDO_SANDBOX_DISABLE: '1', WEBHOOKS_ENABLED: '1' }));
    expect(r.findings.find((f) => f.id === 'flags.contradiction.sandbox-disabled-with-untrusted-inbound')?.severity).toBe('HIGH');
  });

  it('secrets.env-not-ref fires for a raw cred with a _REF seam, suppressed when _REF set', () => {
    const raw = runAuditChecks(deps({ ...cleanEnv(), SUDO_SECRETS_REF: '1', GATEWAY_TOKEN: 'abc' }));
    expect(raw.findings.some((f) => f.id === 'secrets.env-not-ref.GATEWAY_TOKEN')).toBe(true);

    const migrated = runAuditChecks(deps({ ...cleanEnv(), SUDO_SECRETS_REF: '1', GATEWAY_TOKEN: 'abc', GATEWAY_TOKEN_REF: '{"source":"file","id":"x"}' }));
    expect(migrated.findings.some((f) => f.id === 'secrets.env-not-ref.GATEWAY_TOKEN')).toBe(false);
  });

  it('auth.unset fires only when exposed beyond loopback with no token', () => {
    const loopback = runAuditChecks(deps({ ...cleanEnv() }));
    expect(loopback.findings.some((f) => f.id === 'auth.unset')).toBe(false);

    const exposed = runAuditChecks(deps({ ...cleanEnv(), SUDO_GATEWAY_BIND: '0.0.0.0' }));
    expect(exposed.findings.find((f) => f.id === 'auth.unset')?.severity).toBe('HIGH');
  });

  it('net.listeners flags a non-canonical dashboard port', () => {
    const r = runAuditChecks(deps({ ...cleanEnv(), SUDO_DASHBOARD_PORT: '9999' }));
    expect(r.findings.find((f) => f.id === 'net.listeners.dashboard-port')?.severity).toBe('LOW');
  });

  it('fs.perms flags a group/other-readable sensitive file and marks it fixable', () => {
    const target = SENSITIVE_FILES[0];
    const r = runAuditChecks(deps(cleanEnv(), {
      fileExists: (p) => p === target,
      fileMode: (p) => (p === target ? 0o644 : null),
    }));
    const finding = r.findings.find((f) => f.id === `fs.perms.${target}`);
    expect(finding?.severity).toBe('MEDIUM');
    expect(finding?.fixable).toBe(true);
    expect(finding?.fixPath).toBe(target);
  });

  it('fs.perms does NOT fire when the file is already 0600', () => {
    const target = SENSITIVE_FILES[0];
    const r = runAuditChecks(deps(cleanEnv(), {
      fileExists: (p) => p === target,
      fileMode: (p) => (p === target ? 0o600 : null),
    }));
    expect(r.findings.some((f) => f.id.startsWith('fs.perms.'))).toBe(false);
  });

  it('findings are sorted worst-first', () => {
    const r = runAuditChecks(deps({ SUDO_SECRETS_REF: '0', SUDO_SANDBOX_DISABLE: '1', WEBHOOKS_ENABLED: '1' }));
    const ranks = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 } as const;
    for (let i = 1; i < r.findings.length; i++) {
      expect(ranks[r.findings[i - 1]!.severity]).toBeGreaterThanOrEqual(ranks[r.findings[i]!.severity]);
    }
  });
});

describe('GW-7 --fix whitelist', () => {
  it('applyFixes only chmods fixable file-perm findings, nothing else', () => {
    const r = runAuditChecks(deps({ ...cleanEnv(), SUDO_SANDBOX_DISABLE: '1', WEBHOOKS_ENABLED: '1' }, {
      fileExists: (p) => p === SENSITIVE_FILES[0],
      fileMode: (p) => (p === SENSITIVE_FILES[0] ? 0o644 : null),
    }));
    const chmodded: Array<{ p: string; mode: number }> = [];
    const applied = applyFixes(fixableFindings(r), (p, mode) => { chmodded.push({ p, mode }); }, '/root');
    // Only the one fixable finding is touched; the CRITICAL sandbox finding is NOT auto-fixed.
    expect(applied).toEqual([SENSITIVE_FILES[0]]);
    expect(chmodded).toHaveLength(1);
    expect(chmodded[0]!.mode).toBe(0o600);
    expect(chmodded[0]!.p).toContain(SENSITIVE_FILES[0]);
  });

  it('applyFixes is a no-op when there are no fixable findings', () => {
    const r = runAuditChecks(deps(cleanEnv()));
    const chmodded: string[] = [];
    const applied = applyFixes(fixableFindings(r), (p) => { chmodded.push(p); });
    expect(applied).toEqual([]);
    expect(chmodded).toEqual([]);
  });
});
