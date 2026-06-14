/**
 * @file src/core/dashboard/select-auth-backend.ts
 * @description Slice 4 — env-driven OAuth/JWT backend selector. Extracted
 * from cli.ts §8.6 so the wiring is testable in isolation AND so the boot
 * code path stays a 3-line call.
 *
 * **Hard-fail on misconfig (NOT a flag-mode opt-in):** when the operator
 * sets `SUDO_DASHBOARD_AUTH=nous|self-hosted`, they have EXPLICITLY chosen
 * OAuth. If the supporting env (key, issuer for self-hosted, etc.) is
 * missing or invalid, this throws. Boot catches the throw at the dashboard
 * wiring boundary and the dashboard refuses to start — same posture as the
 * non-loopback bind check (`SUDO_DASHBOARD_BIND` non-loopback without
 * `SUDO_DASHBOARD_INSECURE=1` throws). Silent fall-back to basic Bearer
 * would be a security-downgrade footgun: the operator believes OAuth is
 * active but every request is checked against the shared Bearer token.
 *
 * Returns `undefined` ONLY when no OAuth is requested (env unset OR
 * `SUDO_DASHBOARD_AUTH=basic`). The caller wires the default
 * `BasicAuthBackend` in that case.
 */

import type { AuthBackend } from './dashboard-types.js';
import {
  createNousAuthBackend,
  createSelfHostedAuthBackend,
  type JwtAlg,
} from './oauth-jwt-backend.js';

/** Recognized values of `SUDO_DASHBOARD_AUTH`. */
export type DashboardAuthMode = 'basic' | 'nous' | 'self-hosted';

/**
 * Decide which dashboard `AuthBackend` (if any) to register based on env.
 * See module header for the hard-fail rationale.
 *
 * @param env  Defaults to `process.env`. Tests pass a fresh object so the
 *             real process env is never mutated.
 * @returns    A constructed `AuthBackend` when `SUDO_DASHBOARD_AUTH=nous`
 *             or `=self-hosted`; `undefined` when the env is unset or
 *             `=basic` (caller uses default Bearer). Throws for any
 *             other value or for misconfigured OAuth opt-in.
 */
export function selectDashboardAuthBackend(env: NodeJS.ProcessEnv = process.env): AuthBackend | undefined {
  const raw = env['SUDO_DASHBOARD_AUTH'];
  const mode = (raw ?? 'basic').toLowerCase();
  if (mode === 'basic' || mode === '') return undefined;

  // Normalize the synonyms Hermes ships ("self_hosted" snake-case in the
  // plugin path; "self-hosted" in our docs). Accept both.
  const normalized: DashboardAuthMode =
    mode === 'nous' ? 'nous' :
    mode === 'self-hosted' || mode === 'self_hosted' ? 'self-hosted' :
    (() => {
      throw new Error(`SUDO_DASHBOARD_AUTH="${raw}" not recognized (expected basic | nous | self-hosted)`);
    })();

  const algRaw = (env['SUDO_DASHBOARD_OAUTH_ALG'] ?? 'RS256').toUpperCase();
  if (algRaw !== 'HS256' && algRaw !== 'RS256') {
    throw new Error(`SUDO_DASHBOARD_OAUTH_ALG="${algRaw}" not supported (expected HS256 or RS256)`);
  }
  const algorithm = algRaw as JwtAlg;

  const hmacSecret = env['SUDO_DASHBOARD_OAUTH_HMAC_SECRET'];
  const publicKeyPemRaw = env['SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM'];
  // PEM via env supports both inline PEM and a `\n`-escaped one-line form
  // (common in docker-compose env files). If the value already contains
  // a real newline, treat it as inline PEM and don't touch it.
  const publicKeyPem =
    publicKeyPemRaw === undefined ? undefined :
    publicKeyPemRaw.includes('\n') ? publicKeyPemRaw :
    publicKeyPemRaw.replace(/\\n/g, '\n');
  const expectedIssuer = env['SUDO_DASHBOARD_OAUTH_ISSUER'];
  const expectedAudience = env['SUDO_DASHBOARD_OAUTH_AUDIENCE'];
  const requiredScope = env['SUDO_DASHBOARD_OAUTH_REQUIRED_SCOPE'];

  const sharedOpts = {
    algorithm,
    ...(hmacSecret ? { hmacSecret } : {}),
    ...(publicKeyPem ? { publicKeyPem } : {}),
    ...(expectedIssuer ? { expectedIssuer } : {}),
    ...(expectedAudience ? { expectedAudience } : {}),
    ...(requiredScope ? { requiredScope } : {}),
  };

  if (normalized === 'nous') {
    // createNousAuthBackend supplies issuer + audience defaults but still
    // requires a signing key — bare construction throws if neither
    // hmacSecret nor publicKeyPem is provided.
    return createNousAuthBackend(sharedOpts);
  }

  // self-hosted: issuer is hard-required by the factory itself, but we
  // re-check here so the error message references the env var by name —
  // operator sees "missing SUDO_DASHBOARD_OAUTH_ISSUER" not
  // "createSelfHostedAuthBackend: expectedIssuer is required".
  if (!expectedIssuer) {
    throw new Error('SUDO_DASHBOARD_AUTH=self-hosted requires SUDO_DASHBOARD_OAUTH_ISSUER');
  }
  return createSelfHostedAuthBackend({ ...sharedOpts, expectedIssuer });
}
