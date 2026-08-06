/**
 * @file tests/core/shared/credential-root.test.ts
 * @description ADR 0011 — the credential root must NOT follow a late DATA_DIR
 * override, and must NOT share a name with any other subsystem's env knob.
 *
 * `DATA_DIR` was one knob for two orthogonal concerns: instance STATE (dbs,
 * caches — isolating it is routine) and principal CREDENTIALS (OAuth tokens,
 * web-seat sessions, device identity, signing keys — isolating them means the
 * agent stops being itself). Callers that isolate state reassign `process.env['DATA_DIR']`
 * mid-process; correctness then depended on whether `paths.ts` happened to be
 * in the caller's static import graph. It once wasn't, and an 18-day-expired
 * token silently served turns.
 *
 * `CREDENTIAL_DIR` names the second root. Two properties must hold:
 *
 *   1. It DEFAULTS to `DATA_DIR` — not `PROJECT_ROOT/data`. Staging sets
 *      `DATA_DIR=<root>/data-staging` before the process starts (a deployment
 *      decision); a `PROJECT_ROOT/data` default would silently repoint staging
 *      at PRODUCTION credentials.
 *   2. A `SUDO_CREDENTIAL_DIR` pin survives a later `DATA_DIR` reassignment —
 *      that is what makes "isolate state, keep credentials" expressible.
 *   3. It is INDEPENDENT of `SUDO_IDENTITY_DIR`, which `agent/alignment-seed.ts`
 *      already owns with an unrelated meaning (the operator identity-ANCHOR
 *      DOCUMENTS dir, default `<root>/config`). A shared name means one
 *      subsystem silently reconfigures the other; both directions were
 *      reproduced before the rename, so both are pinned here.
 *
 * Protocol (must run in a FRESH process — module caching makes it one-shot):
 *   import the target -> THEN set DATA_DIR=<sentinel> -> THEN load paths.js
 *
 * The first case is a DISCRIMINATOR: a target that does NOT pull paths.js must
 * let the sentinel win. Without it, every "sentinel did not win" assertion
 * below could pass vacuously (e.g. if the sentinel were simply never readable).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const SENTINEL = '/tmp/SENTINEL-CREDENTIAL-ROOT';
const ROOT = process.cwd();

interface Probe {
  DATA_DIR: string;
  CREDENTIAL_DIR: string;
  credentialPathJoined: string;
  /** What alignment-seed.ts resolves as the identity-ANCHOR DOCUMENTS dir. */
  alignmentAnchorDir: string;
}

/**
 * Run the protocol in a fresh process.
 *
 * @param target         module imported BEFORE the sentinel is set
 * @param preEnv         env applied before anything is imported (i.e. the
 *                       "set before the process starts" deployment decision)
 * @param setSentinel    whether to reassign DATA_DIR after importing `target`
 */
function probe(
  target: string,
  preEnv: Record<string, string> = {},
  setSentinel = true,
): Probe {
  const script = `
    (async () => {
      ${Object.entries(preEnv)
        .map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
        .join('\n      ')}
      await import(${JSON.stringify(target)});
      ${setSentinel ? `process.env['DATA_DIR'] = ${JSON.stringify(SENTINEL)};` : ''}
      const paths = await import(${JSON.stringify(`${ROOT}/src/core/shared/paths.js`)});
      const seed = await import(${JSON.stringify(`${ROOT}/src/core/agent/alignment-seed.js`)});
      process.stdout.write('RESULT:' + JSON.stringify({
        DATA_DIR: paths.DATA_DIR,
        CREDENTIAL_DIR: paths.CREDENTIAL_DIR,
        credentialPathJoined: paths.credentialPath('claude-oauth.json'),
        alignmentAnchorDir: seed.resolveIdentityDir(),
      }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const out = execFileSync('npx', ['tsx', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: scrubbedEnv(),
  });
  const m = out.match(/RESULT:(\{.*\})/);
  if (!m) throw new Error(`probe produced no RESULT; output was:\n${out}`);
  return JSON.parse(m[1]!) as Probe;
}

/**
 * The child's baseline env with every root knob DELETED (not blanked).
 * `alignment-seed.ts` reads its var with `??`, so a blank string is a value
 * there — blanking would silently test '' instead of the default.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e['DATA_DIR'];
  delete e['SUDO_CREDENTIAL_DIR'];
  delete e['SUDO_IDENTITY_DIR'];
  return e;
}

/** A module guaranteed NOT to pull paths.ts — the discriminator's target. */
const PATHS_FREE_TARGET = 'node:path';

/** A real identity site; its static graph pulls paths.ts. */
const IDENTITY_SITE = `${ROOT}/src/llm/claude-oauth-manager.js`;

/** The pre-existing, UNRELATED owner of `SUDO_IDENTITY_DIR` (alignment anchor). */
const ANCHOR_SENTINEL = '/tmp/SENTINEL-ALIGNMENT-ANCHOR';

describe('ADR 0011 — identity root vs state root', () => {
  it('DISCRIMINATOR: with paths.js unloaded, the sentinel DOES win (instrument works)', () => {
    const r = probe(PATHS_FREE_TARGET);
    expect(r.DATA_DIR, 'the sentinel must be capable of winning, or every assertion below is vacuous')
      .toBe(SENTINEL);
    // Identity legitimately follows here: nothing was pinned, and paths.ts had
    // not captured a root yet. This is the "set before process start" case.
    expect(r.CREDENTIAL_DIR).toBe(SENTINEL);
  }, 90_000);

  it('a pinned SUDO_CREDENTIAL_DIR does NOT follow a late DATA_DIR override', () => {
    const pinned = `${ROOT}/data`;
    const r = probe(PATHS_FREE_TARGET, { SUDO_CREDENTIAL_DIR: pinned });
    // State moved (that was the caller's request) ...
    expect(r.DATA_DIR).toBe(SENTINEL);
    // ... identity did not.
    expect(r.CREDENTIAL_DIR, 'identity must ignore a mid-process DATA_DIR reassignment').toBe(pinned);
    expect(r.credentialPathJoined).toBe(`${pinned}/claude-oauth.json`);
    expect(r.credentialPathJoined).not.toContain('SENTINEL');
  }, 90_000);

  it('importing a real identity site pre-captures the owner root; the sentinel loses', () => {
    const r = probe(IDENTITY_SITE);
    expect(r.DATA_DIR).not.toContain('SENTINEL');
    expect(r.CREDENTIAL_DIR).toBe(`${ROOT}/data`);
    expect(r.credentialPathJoined).toBe(`${ROOT}/data/claude-oauth.json`);
  }, 90_000);

  it('CREDENTIAL_DIR defaults to a pre-start DATA_DIR (staging), NOT PROJECT_ROOT/data', () => {
    // ecosystem.config.cjs sets DATA_DIR=<root>/data-staging before the process
    // starts. A PROJECT_ROOT/data default would point staging at PROD creds.
    const staging = `${ROOT}/data-staging`;
    const r = probe(PATHS_FREE_TARGET, { DATA_DIR: staging }, /* setSentinel */ false);
    expect(r.DATA_DIR).toBe(staging);
    expect(r.CREDENTIAL_DIR, 'identity must follow a DATA_DIR set before process start').toBe(staging);
    expect(r.credentialPathJoined).toBe(`${staging}/claude-oauth.json`);
  }, 90_000);

  // -------------------------------------------------------------------------
  // Name-collision regression (both directions).
  //
  // `SUDO_IDENTITY_DIR` was already taken by agent/alignment-seed.ts
  // (`resolveIdentityDir()` → the operator identity-anchor DOCUMENTS dir,
  // default <root>/config). Reusing it for the credential root made each knob
  // silently reconfigure the other subsystem. Each case below carries its own
  // discriminator: the variable IS shown to move its own subsystem in the same
  // run, so "the other one did not move" can never pass vacuously.
  // -------------------------------------------------------------------------

  it('SUDO_IDENTITY_DIR moves the alignment anchor and does NOT move the credential root', () => {
    const r = probe(PATHS_FREE_TARGET, { SUDO_IDENTITY_DIR: ANCHOR_SENTINEL }, /* setSentinel */ false);
    // DISCRIMINATOR: the variable is readable and does move its own subsystem.
    expect(r.alignmentAnchorDir, 'SUDO_IDENTITY_DIR must still own the alignment anchor dir')
      .toBe(ANCHOR_SENTINEL);
    // ... and must not drag credentials with it (that would be "no usable token").
    expect(r.CREDENTIAL_DIR, 'the alignment anchor knob must not repoint credential stores')
      .toBe(`${ROOT}/data`);
    expect(r.credentialPathJoined).toBe(`${ROOT}/data/claude-oauth.json`);
  }, 90_000);

  it('SUDO_CREDENTIAL_DIR moves the credential root and does NOT move the alignment anchor', () => {
    const pinned = `${ROOT}/data`;
    const r = probe(PATHS_FREE_TARGET, { SUDO_CREDENTIAL_DIR: pinned, DATA_DIR: `${ROOT}/data-staging` }, false);
    // DISCRIMINATOR: the pin wins over the pre-start DATA_DIR, so it is live.
    expect(r.DATA_DIR).toBe(`${ROOT}/data-staging`);
    expect(r.CREDENTIAL_DIR, 'SUDO_CREDENTIAL_DIR must own the credential root').toBe(pinned);
    // ... and must not drag the alignment anchor off <root>/config, which would
    // flip anchorPresent to false → DEGRADED_SEED (~0.51, below the 0.6 gate).
    expect(r.alignmentAnchorDir, 'the credential knob must not repoint the alignment anchor')
      .toBe(`${ROOT}/config`);
  }, 90_000);
});
