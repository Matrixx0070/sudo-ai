/**
 * @file tests/cli/chat/provider-dotenv.test.ts
 * @description Pin the TUI's config/.env bootstrap — WITHOUT touching real credentials.
 *
 * `sudo-ai chat` is registered in cli/index.ts without the `preAction` dotenv
 * hook that `grok` and `voice` install, so the module-scope `loadDotEnv(PATHS.ENV)`
 * in chat/provider.ts is the ONLY thing hydrating config/.env for the whole TUI
 * process. After the dead SDK path was deleted, provider.ts is types + one const
 * + that call — exactly the shape a future dead-code sweep deletes. Deleting it
 * strips every API key from the TUI with no other failing test. This file is that
 * test.
 *
 * SAFETY: an earlier version of this test read and overwrote the real
 * `config/.env` (241 lines of live credentials) at module scope; it was reverted
 * in commit 1c5523ca. This version never reads or writes any real credential
 * file. `paths.ts` resolves PROJECT_ROOT from `SUDO_AI_HOME`, so the child
 * process is pointed at a tmpdir whose `config/.env` is a fixture. Each child
 * asserts the resolved PATHS.ENV really is inside that tmpdir before concluding.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();

/** A fake project root: <tmp>/config/.env holds the sentinel, nothing else. */
let fakeHome = '';

beforeAll(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-dotenv-'));
  fs.mkdirSync(path.join(fakeHome, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, 'config', '.env'),
    [
      '# comment line',
      '',
      'SUDO_TEST_DOTENV_SENTINEL=loadbearing',
      'SUDO_TEST_DOTENV_QUOTED="quoted value"',
    ].join('\n'),
    { mode: 0o600 },
  );
});

afterAll(() => {
  if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
});

/**
 * Import `target` in a FRESH process rooted at the tmpdir, then report the
 * sentinel and the config path that root resolved to.
 */
function importUnderFakeHome(target: string): { sentinel: string; envPath: string } {
  const script = `
    (async () => {
      await import(${JSON.stringify(target)});
      const { PATHS } = await import('${REPO}/src/core/shared/constants.js');
      process.stdout.write('ENVPATH:' + PATHS.ENV + '\\n');
      process.stdout.write('SENTINEL:' + (process.env['SUDO_TEST_DOTENV_SENTINEL'] ?? 'ABSENT') + '\\n');
    })();
  `;
  const childEnv = { ...process.env, SUDO_AI_HOME: fakeHome };
  delete childEnv['SUDO_TEST_DOTENV_SENTINEL'];
  const out = execFileSync('npx', ['tsx', '-e', script], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: childEnv,
  });
  return {
    sentinel: (out.match(/^SENTINEL:(.*)$/m)?.[1] ?? '').trim(),
    envPath: (out.match(/^ENVPATH:(.*)$/m)?.[1] ?? '').trim(),
  };
}

describe('TUI config/.env bootstrap is load-bearing', () => {
  it('importing the chat command hydrates the fixture .env', () => {
    const { sentinel, envPath } = importUnderFakeHome(`${REPO}/src/cli/commands/chat.js`);
    // Guard the guard: if this ever points at the real repo, fail loudly rather
    // than silently exercising production credentials.
    expect(envPath, 'the child must be rooted at the tmpdir, never the repo').toBe(
      path.join(fakeHome, 'config', '.env'),
    );
    expect(sentinel, 'chat/provider.ts must call loadDotEnv(PATHS.ENV) at module scope').toBe(
      'loadbearing',
    );
  }, 90_000);

  it('the protocol discriminates — a module that does NOT bootstrap leaves it ABSENT', () => {
    // dispatcher.js is a pure in-process event bus; it never loads dotenv.
    const { sentinel, envPath } = importUnderFakeHome(
      `${REPO}/src/cli/commands/chat/dispatcher.js`,
    );
    expect(envPath).toBe(path.join(fakeHome, 'config', '.env'));
    expect(sentinel, 'if this stops showing ABSENT the test above proves nothing').toBe('ABSENT');
  }, 90_000);
});

describe('loadDotEnv parser (tmpdir fixture only)', () => {
  // Also runs in a child under SUDO_AI_HOME: importing provider.js in THIS
  // process would run its module-scope loadDotEnv against the real
  // <repo>/config/.env and hydrate live credentials into the test runner.
  it('parses keys, strips quotes, skips comments, and never clobbers an existing key', () => {
    const unitFile = path.join(fakeHome, 'unit.env');
    fs.writeFileSync(unitFile, [
      '# a comment',
      '',
      'SUDO_TEST_PARSE_PLAIN=plain',
      "SUDO_TEST_PARSE_SQ='single'",
      'SUDO_TEST_PARSE_DQ="double"',
      'SUDO_TEST_PARSE_PRESET=from-file',
      '=novalue',
    ].join('\n'));

    const script = `
      (async () => {
        process.env['SUDO_TEST_PARSE_PRESET'] = 'from-env';
        const { loadDotEnv } = await import('${REPO}/src/cli/commands/chat/provider.js');
        loadDotEnv(${JSON.stringify(unitFile)});
        loadDotEnv(${JSON.stringify(path.join(fakeHome, 'nope', '.env'))}); // missing file must not throw
        const { PATHS } = await import('${REPO}/src/core/shared/constants.js');
        process.stdout.write('ENVPATH:' + PATHS.ENV + '\\n');
        process.stdout.write('OUT:' + JSON.stringify({
          plain: process.env['SUDO_TEST_PARSE_PLAIN'] ?? null,
          sq: process.env['SUDO_TEST_PARSE_SQ'] ?? null,
          dq: process.env['SUDO_TEST_PARSE_DQ'] ?? null,
          preset: process.env['SUDO_TEST_PARSE_PRESET'] ?? null,
        }) + '\\n');
      })();
    `;
    const childEnv = { ...process.env, SUDO_AI_HOME: fakeHome };
    const out = execFileSync('npx', ['tsx', '-e', script], {
      cwd: REPO, encoding: 'utf8', timeout: 60_000, env: childEnv,
    });
    expect((out.match(/^ENVPATH:(.*)$/m)?.[1] ?? '').trim()).toBe(
      path.join(fakeHome, 'config', '.env'),
    );
    expect(JSON.parse(out.match(/^OUT:(.*)$/m)?.[1] ?? '{}')).toEqual({
      plain: 'plain',
      sq: 'single',
      dq: 'double',
      preset: 'from-env',
    });
  }, 90_000);
});
