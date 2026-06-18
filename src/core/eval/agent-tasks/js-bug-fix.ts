/**
 * @file js-bug-fix.ts
 * @description Agent must fix a broken JavaScript helper so a held-out
 * Node.js test passes. Cross-language signal — confirms the bench works
 * outside Python.
 *
 * The bug: `parseAge('25 years')` should return `25` (Number), but the
 * naive implementation returns `NaN` because `Number(s)` chokes on the
 * suffix. Fix can use parseInt, regex, etc.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';
import { verifyWorkspaceExec } from '../verifiers/workspace-exec-verifier.js';

const INITIAL_PARSE_AGE_JS = `// parse-age.js — currently broken
function parseAge(s) {
  return Number(s);
}

module.exports = { parseAge };
`;

const HELD_OUT_TESTS_JS = `// test-parse-age.js — held-out tests the agent must satisfy.
// DO NOT modify this file. Only edit parse-age.js.
const assert = require('assert');
const { parseAge } = require('./parse-age');

assert.strictEqual(parseAge('25 years'), 25, "parseAge('25 years') should be 25");
assert.strictEqual(parseAge('0'), 0, "parseAge('0') should be 0");
assert.strictEqual(parseAge('42'), 42, "parseAge('42') should be 42");
assert.strictEqual(parseAge('  17 yo  '), 17, "parseAge('  17 yo  ') should be 17");
console.log('PASS');
`;

export const jsBugFixTask: AgentBenchTask = {
  id: 'agent-js-bug-fix',
  name: 'Fix parseAge() to extract integers from string suffixes',
  prompt: [
    'You are working in {workspace}. The file {workspace}/parse-age.js contains a broken function:',
    '',
    '```javascript',
    'function parseAge(s) {',
    '  return Number(s);',
    '}',
    '```',
    '',
    'The held-out test file {workspace}/test-parse-age.js asserts these cases:',
    "  parseAge('25 years')  === 25",
    "  parseAge('0')         === 0",
    "  parseAge('42')        === 42",
    "  parseAge('  17 yo  ') === 17",
    '',
    'TASK: Edit {workspace}/parse-age.js so all assertions pass. Module shape',
    'must stay `module.exports = { parseAge }`. Do NOT modify the test file.',
    '',
    'The verifier will run `node test-parse-age.js` and accept exit code 0.',
  ].join('\n'),
  timeoutMs: 120_000,
  maxIterations: 30,

  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'parse-age.js'), INITIAL_PARSE_AGE_JS, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'test-parse-age.js'), HELD_OUT_TESTS_JS, 'utf8');
  },

  async verifyWorkspace(workspaceDir: string) {
    return verifyWorkspaceExec(workspaceDir, {
      command: 'node test-parse-age.js',
      timeoutMs: 10_000,
      // V8 reserves ~1GB of address space at startup for CodeRange; the default
      // 512MB sandbox virt limit (ulimit -v) makes `node` fail to start (exit 133).
      memoryMB: 2048,
    });
  },
};
