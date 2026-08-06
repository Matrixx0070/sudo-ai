/**
 * @file tests/core/shared/identity-root.test.ts
 * @description ADR 0011 — the identity root must NOT follow a late DATA_DIR override.
 *
 * `DATA_DIR` was one knob for two orthogonal concerns: instance STATE (dbs,
 * caches — isolating it is routine) and principal IDENTITY (OAuth tokens,
 * device identity, signing keys — isolating it means the agent stops being
 * itself). Callers that isolate state reassign `process.env['DATA_DIR']`
 * mid-process; correctness then depended on whether `paths.ts` happened to be
 * in the caller's static import graph. It once wasn't, and an 18-day-expired
 * token silently served turns.
 *
 * `IDENTITY_DIR` names the second root. Two properties must hold:
 *
 *   1. It DEFAULTS to `DATA_DIR` — not `PROJECT_ROOT/data`. Staging sets
 *      `DATA_DIR=<root>/data-staging` before the process starts (a deployment
 *      decision); a `PROJECT_ROOT/data` default would silently repoint staging
 *      at PRODUCTION credentials.
 *   2. A `SUDO_IDENTITY_DIR` pin survives a later `DATA_DIR` reassignment —
 *      that is what makes "isolate state, keep identity" expressible.
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

const SENTINEL = '/tmp/SENTINEL-IDENTITY-ROOT';
const ROOT = process.cwd();

interface Probe {
  DATA_DIR: string;
  IDENTITY_DIR: string;
  identityPathJoined: string;
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
      process.stdout.write('RESULT:' + JSON.stringify({
        DATA_DIR: paths.DATA_DIR,
        IDENTITY_DIR: paths.IDENTITY_DIR,
        identityPathJoined: paths.identityPath('claude-oauth.json'),
      }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const out = execFileSync('npx', ['tsx', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DATA_DIR: '', SUDO_IDENTITY_DIR: '' },
  });
  const m = out.match(/RESULT:(\{.*\})/);
  if (!m) throw new Error(`probe produced no RESULT; output was:\n${out}`);
  return JSON.parse(m[1]!) as Probe;
}

/** A module guaranteed NOT to pull paths.ts — the discriminator's target. */
const PATHS_FREE_TARGET = 'node:path';

/** A real identity site; its static graph pulls paths.ts. */
const IDENTITY_SITE = `${ROOT}/src/llm/claude-oauth-manager.js`;

describe('ADR 0011 — identity root vs state root', () => {
  it('DISCRIMINATOR: with paths.js unloaded, the sentinel DOES win (instrument works)', () => {
    const r = probe(PATHS_FREE_TARGET);
    expect(r.DATA_DIR, 'the sentinel must be capable of winning, or every assertion below is vacuous')
      .toBe(SENTINEL);
    // Identity legitimately follows here: nothing was pinned, and paths.ts had
    // not captured a root yet. This is the "set before process start" case.
    expect(r.IDENTITY_DIR).toBe(SENTINEL);
  }, 90_000);

  it('a pinned SUDO_IDENTITY_DIR does NOT follow a late DATA_DIR override', () => {
    const pinned = `${ROOT}/data`;
    const r = probe(PATHS_FREE_TARGET, { SUDO_IDENTITY_DIR: pinned });
    // State moved (that was the caller's request) ...
    expect(r.DATA_DIR).toBe(SENTINEL);
    // ... identity did not.
    expect(r.IDENTITY_DIR, 'identity must ignore a mid-process DATA_DIR reassignment').toBe(pinned);
    expect(r.identityPathJoined).toBe(`${pinned}/claude-oauth.json`);
    expect(r.identityPathJoined).not.toContain('SENTINEL');
  }, 90_000);

  it('importing a real identity site pre-captures the owner root; the sentinel loses', () => {
    const r = probe(IDENTITY_SITE);
    expect(r.DATA_DIR).not.toContain('SENTINEL');
    expect(r.IDENTITY_DIR).toBe(`${ROOT}/data`);
    expect(r.identityPathJoined).toBe(`${ROOT}/data/claude-oauth.json`);
  }, 90_000);

  it('IDENTITY_DIR defaults to a pre-start DATA_DIR (staging), NOT PROJECT_ROOT/data', () => {
    // ecosystem.config.cjs sets DATA_DIR=<root>/data-staging before the process
    // starts. A PROJECT_ROOT/data default would point staging at PROD creds.
    const staging = `${ROOT}/data-staging`;
    const r = probe(PATHS_FREE_TARGET, { DATA_DIR: staging }, /* setSentinel */ false);
    expect(r.DATA_DIR).toBe(staging);
    expect(r.IDENTITY_DIR, 'identity must follow a DATA_DIR set before process start').toBe(staging);
    expect(r.identityPathJoined).toBe(`${staging}/claude-oauth.json`);
  }, 90_000);
});
