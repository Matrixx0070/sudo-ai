/**
 * Tests for restartCommand — the command meta.self-modify uses to restart the
 * live service. Defaults to the pm2 ecosystem-file form (the previous
 * `systemctl restart sudo-ai` targeted a unit that is masked on this
 * deployment), overridable via SUDO_RESTART_CMD.
 *
 * NOTE: doRestart() itself is deliberately not unit-tested — it spawns a real
 * detached restart, which must never fire inside the suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { restartCommand } from '../../src/core/tools/builtin/meta/self-modify.js';

const KEY = 'SUDO_RESTART_CMD';
const DEFAULT = 'pm2 restart ecosystem.config.cjs --only sudo-ai-v5 --update-env';
let saved: string | undefined;

beforeEach(() => { saved = process.env[KEY]; });
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('restartCommand', () => {
  it('defaults to the pm2 ecosystem-file restart (with --update-env)', () => {
    delete process.env[KEY];
    expect(restartCommand()).toBe(DEFAULT);
  });

  it('uses SUDO_RESTART_CMD verbatim when set', () => {
    process.env[KEY] = 'systemctl restart sudo-ai-v5';
    expect(restartCommand()).toBe('systemctl restart sudo-ai-v5');
  });

  it('trims a padded override', () => {
    process.env[KEY] = '  pm2 reload sudo-ai-v5  ';
    expect(restartCommand()).toBe('pm2 reload sudo-ai-v5');
  });

  it('falls back to the default for an empty / whitespace override', () => {
    process.env[KEY] = '   ';
    expect(restartCommand()).toBe(DEFAULT);
    process.env[KEY] = '';
    expect(restartCommand()).toBe(DEFAULT);
  });
});
