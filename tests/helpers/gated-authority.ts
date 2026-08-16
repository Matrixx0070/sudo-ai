/**
 * @file gated-authority.ts
 * @description Test helper: pin a suite to `gated` execution authority.
 *
 * The shipped default is `autonomous` (owner directive 2026-08-16 — no
 * approval prompt on any surface; see docs/EXECUTION_AUTHORITY.md). Suites
 * that exist to exercise the human-in-the-loop machinery — prompt delivery,
 * park/resume, fail-closed denial, policy-store rules — must therefore declare
 * the mode they are testing instead of inheriting the default.
 *
 * This keeps the gated capability under test rather than deleting coverage
 * when the default posture changed.
 */

import { beforeEach, afterEach } from 'vitest';

/** Force `gated` authority for every test in the calling file. */
export function useGatedAuthority(): void {
  let saved: string | undefined;
  let savedLegacy: string | undefined;

  beforeEach(() => {
    saved = process.env['SUDO_AUTHORITY_MODE'];
    savedLegacy = process.env['SUDO_AUTO_APPROVE'];
    process.env['SUDO_AUTHORITY_MODE'] = 'gated';
    delete process.env['SUDO_AUTO_APPROVE'];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_AUTHORITY_MODE'];
    else process.env['SUDO_AUTHORITY_MODE'] = saved;
    if (savedLegacy === undefined) delete process.env['SUDO_AUTO_APPROVE'];
    else process.env['SUDO_AUTO_APPROVE'] = savedLegacy;
  });
}
