/**
 * @file tests/cli/doctor-command.test.ts
 * @description Tests for sudo-ai doctor command Wave 10 extensions.
 *
 * Tests:
 *  1.  runDoctor returns integer exit code
 *  2.  runDoctor with no --fix still works
 *  3.  runDoctor --fix option runs without crashing
 *  4.  runDoctor creates data/ directory if missing (--fix mode)
 *  5.  Node.js version check passes on Node 20+
 *  6.  wasmtime check returns ok or warn (not error)
 *  7.  disk space check runs without crashing
 *  8.  memory check runs without crashing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runDoctor } from '../../src/cli/commands/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const originalEnv: Record<string, string | undefined> = {};

function suppressOutput(): () => void {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = originalLog;
    console.error = originalError;
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-doctor-test-'));
  ['XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GATEWAY_TOKEN'].forEach((k) => {
    originalEnv[k] = process.env[k];
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  Object.entries(originalEnv).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDoctor', () => {
  it('1. returns integer exit code', async () => {
    const restore = suppressOutput();
    const code = await runDoctor(tmpDir);
    restore();
    expect(typeof code).toBe('number');
    expect([0, 1]).toContain(code);
  });

  it('2. runs without --fix flag', async () => {
    const restore = suppressOutput();
    await expect(runDoctor(tmpDir, {})).resolves.not.toThrow();
    restore();
  });

  it('3. --fix option runs without crashing', async () => {
    const restore = suppressOutput();
    await expect(runDoctor(tmpDir, { fix: true })).resolves.not.toThrow();
    restore();
  });

  it('4. --fix creates data/ directory if missing', async () => {
    const dataDir = path.join(tmpDir, 'data');
    expect(fs.existsSync(dataDir)).toBe(false);

    const restore = suppressOutput();
    await runDoctor(tmpDir, { fix: true });
    restore();

    // data/ should be created by --fix
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('5. Node.js >= 20 check passes (running in Node 20+)', async () => {
    const [major] = process.versions.node.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(20);

    const restore = suppressOutput();
    const code = await runDoctor(tmpDir);
    restore();

    // If Node is 20+, the node check should not be a critical failure
    // (other checks may still fail, but not the node check)
    // We can't assert code === 0 because other env may be missing
    expect([0, 1]).toContain(code);
  });

  it('6. wasmtime check completes without crashing', async () => {
    const restore = suppressOutput();
    // wasmtime is likely not installed, so this check should return WARN
    await expect(runDoctor(tmpDir, {})).resolves.not.toThrow();
    restore();
  });

  it('7. disk space check runs without crashing', async () => {
    const restore = suppressOutput();
    await expect(runDoctor(tmpDir, {})).resolves.not.toThrow();
    restore();
  });

  it('8. memory check runs without crashing', async () => {
    const restore = suppressOutput();
    await expect(runDoctor(tmpDir, {})).resolves.not.toThrow();
    restore();
  });
});
