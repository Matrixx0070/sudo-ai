/**
 * @file tests/cli/chat/adapter-data-dir.test.ts
 * @description The TUI adapter must pre-capture the owner's DATA_DIR.
 *
 * agent-loop-adapter.ts reassigns process.env['DATA_DIR'] to a TUI-private
 * state dir (SQLite isolation). But DATA_DIR is ALSO the credential root:
 * claude-oauth-manager resolves `<DATA_DIR>/claude-oauth.json` through
 * paths.ts, which caches DATA_DIR at first import. So whichever module pulls
 * paths.ts FIRST decides where tokens are read from.
 *
 * Measured before the fix: importing the adapter alone left DATA_DIR movable,
 * so tokens resolved inside the private dir — where an 18-day-expired copy
 * silently served turns while the UI named a model that never ran. It only
 * worked in production because App.tsx imports provider.js (-> constants.js ->
 * paths.js) first, a guarantee resting on a single value import.
 *
 * The adapter now imports paths.js itself. This pins that, using the same
 * discriminating protocol that found the bug: import the module, THEN set a
 * sentinel DATA_DIR, THEN load paths.js. If the module already pulled paths.js,
 * the sentinel is ignored.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/** Run the protocol in a FRESH process — module caching makes it one-shot. */
function capturedDataDirAfterImporting(target: string): string {
  const script = `
    (async () => {
      await import(${JSON.stringify(target)});
      process.env['DATA_DIR'] = '/tmp/SENTINEL-DATA-DIR';
      const paths = await import('${process.cwd()}/src/core/shared/paths.js');
      process.stdout.write('RESULT:' + paths.DATA_DIR);
    })();
  `;
  const out = execFileSync('npx', ['tsx', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 25_000,
  });
  return (out.match(/RESULT:(.*)$/m)?.[1] ?? '').trim();
}

describe('TUI adapter pre-captures the owner DATA_DIR', () => {
  it('importing the adapter alone pins DATA_DIR to the real data dir', () => {
    const captured = capturedDataDirAfterImporting(
      `${process.cwd()}/src/cli/commands/chat/agent-loop-adapter.js`,
    );
    expect(captured, 'adapter must import paths.js so credentials never follow the private state dir')
      .not.toContain('SENTINEL');
    expect(captured).toBe(`${process.cwd()}/data`);
  }, 30_000);

  it('the runtime guard THROWS if identity ever equals the private state dir', () => {
    // Simulate the failure: force paths.ts to capture the TUI's own state dir,
    // so identity === state. _bootstrap() must refuse rather than quietly read
    // credentials from a stale private copy.
    const tuiDir = `${process.env['HOME'] ?? '/root'}/.sudo-ai/tui-data`;
    const script = `
      process.env['DATA_DIR'] = ${JSON.stringify('PLACEHOLDER')};
      (async () => {
        const { TuiAgentAdapter } = await import('${process.cwd()}/src/cli/commands/chat/agent-loop-adapter.js');
        try {
          const it = new TuiAgentAdapter().stream({ sessionId: 'guard', message: 'x', signal: new AbortController().signal });
          await it.next();
          process.stdout.write('NO_THROW');
        } catch (e) { process.stdout.write('THREW:' + String(e.message).slice(0, 90)); }
      })();
    `.replace('PLACEHOLDER', tuiDir);
    const out = execFileSync('npx', ['tsx', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 25_000,
    });
    expect(out).toContain('THREW:');
    expect(out).toContain('identity root was not captured');
  }, 30_000);

  it('the protocol discriminates — a module that does NOT load paths.js lets the sentinel win', () => {
    // dispatcher.js is a pure in-process event bus with no paths.js dependency.
    const captured = capturedDataDirAfterImporting(
      `${process.cwd()}/src/cli/commands/chat/dispatcher.js`,
    );
    expect(captured, 'if this stops showing the sentinel the test proves nothing')
      .toContain('SENTINEL');
  }, 30_000);
});
