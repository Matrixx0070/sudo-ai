/**
 * @file tests/cli/chat/provider-dotenv.test.ts
 * @description The TUI's config/.env hydration is load-bearing — pin it.
 *
 * `sudo-ai chat` is registered in cli/index.ts WITHOUT the `preAction` dotenv
 * hook that `grok` and `voice` install. The only thing that hydrates
 * config/.env for the whole TUI process is the module-scope `loadDotEnv(...)`
 * call in chat/provider.ts, which runs because App.tsx imports that module for
 * DEFAULT_SYSTEM.
 *
 * That makes it an invisible contract: provider.ts otherwise looks like a pure
 * types module, so the obvious "tidy up" is to delete the loader — which would
 * silently strip every API key, token and SUDO_* flag from the TUI.
 *
 * Measured both directions when the dead SDK path was removed:
 *   loadDotEnv present  -> importing cli/commands/chat.js yields SENTINEL=<value>
 *   loadDotEnv disabled -> the same import yields SENTINEL=ABSENT
 *
 * This test reproduces that protocol against the real entry point, in a fresh
 * process (module caching makes it one-shot), with a temporary sentinel .env.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.join(process.cwd(), 'config', '.env');
const SENTINEL_KEY = 'SUDO_TUI_DOTENV_SENTINEL';
const SENTINEL_VALUE = 'hydrated-by-provider-ts';

/** Import `target` in a fresh process and report the sentinel it observed. */
function sentinelAfterImporting(target: string): string {
  const script = `
    (async () => {
      await import(${JSON.stringify(target)});
      process.stdout.write('SENTINEL:' + (process.env[${JSON.stringify(SENTINEL_KEY)}] ?? 'ABSENT'));
    })();
  `;
  const out = execFileSync('npx', ['tsx', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
  });
  return (out.match(/SENTINEL:(.*)$/m)?.[1] ?? '').trim();
}

// Append a sentinel to config/.env (creating it if absent), and restore after.
const hadEnvFile = fs.existsSync(ENV_PATH);
const originalEnv = hadEnvFile ? fs.readFileSync(ENV_PATH, 'utf8') : null;
fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
fs.writeFileSync(
  ENV_PATH,
  `${originalEnv ?? ''}\n${SENTINEL_KEY}=${SENTINEL_VALUE}\n`,
);

afterAll(() => {
  if (originalEnv === null) fs.rmSync(ENV_PATH, { force: true });
  else fs.writeFileSync(ENV_PATH, originalEnv);
});

describe('TUI chat hydrates config/.env at import time', () => {
  it('importing the chat entry point loads config/.env into process.env', () => {
    const observed = sentinelAfterImporting(
      `${process.cwd()}/src/cli/commands/chat.js`,
    );
    expect(
      observed,
      'chat/provider.ts must keep its module-scope loadDotEnv(PATHS.ENV) — ' +
        'it is the only config/.env hydration on the `sudo-ai chat` path',
    ).toBe(SENTINEL_VALUE);
  }, 90_000);

  it('importing provider.ts alone is what performs the hydration', () => {
    const observed = sentinelAfterImporting(
      `${process.cwd()}/src/cli/commands/chat/provider.js`,
    );
    expect(observed).toBe(SENTINEL_VALUE);
  }, 90_000);
});
