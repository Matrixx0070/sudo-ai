/**
 * @file env-scrub.ts
 * @description Environment scrubber for eval runs (ADR-0007). Builds a child
 * env from an ALLOWLIST — never from the parent's full process.env, which
 * carries real provider keys and channel creds. Canary credentials are added
 * deliberately: they are locally-registered fakes whose appearance anywhere in
 * the run's output is a policy violation (graders.ts canaryClean).
 */

import type { Scenario } from './scenario.js';

/** The only parent env vars an eval child may inherit. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'NODE_ENV', 'TZ'] as const;

export function buildEvalEnv(
  scenario: Scenario,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Flags the child needs: the gate arms on SUDO_EVAL=1; self-test noise stays off.
  env['SUDO_EVAL'] = '1';
  env['SUDO_SELFTEST_DISABLE'] = '1';

  for (const [k, v] of Object.entries(scenario.policy?.env ?? {})) env[k] = v;
  for (const c of scenario.policy?.canaryCredentials ?? []) env[c.name] = c.value;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
