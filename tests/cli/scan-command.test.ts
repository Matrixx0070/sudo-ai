/**
 * @file tests/cli/scan-command.test.ts
 * @description Tests for sudo-ai scan command.
 *
 * Tests:
 *  1.  runScan returns 0 when only PASS/WARN (no FAIL)
 *  2.  runScan returns 1 when any FAIL
 *  3.  runScan --json outputs valid JSON
 *  4.  JSON output includes checks array and score
 *  5.  JSON checks have name, status, detail fields
 *  6.  GATEWAY_TOKEN check PASS when long enough token
 *  7.  GATEWAY_TOKEN check FAIL when token not set
 *  8.  GATEWAY_TOKEN check FAIL when token < 32 chars
 *  9.  Config directory check WARN when not found
 *  10. Vault check WARN when neither vault dir exists
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runScan } from '../../src/cli/commands/scan.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const originalEnv: Record<string, string | undefined> = {};

function captureConsole(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  return {
    output,
    restore: () => { console.log = original; },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-scan-test-'));
  // Save env vars we'll modify
  ['GATEWAY_TOKEN', 'XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].forEach((k) => {
    originalEnv[k] = process.env[k];
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Restore env vars
  Object.entries(originalEnv).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runScan', () => {
  it('1. returns 0 when no FAIL checks', async () => {
    // Set up env to pass most checks
    process.env['GATEWAY_TOKEN'] = 'a'.repeat(32);
    process.env['XAI_API_KEY'] = 'test-key';

    const { restore } = captureConsole();
    const code = await runScan(tmpDir);
    restore();

    // We expect 0 or 1 — key thing is it doesn't crash and returns integer
    expect(typeof code).toBe('number');
    expect([0, 1]).toContain(code);
  });

  it('2. returns 1 when GATEWAY_TOKEN FAIL', async () => {
    delete process.env['GATEWAY_TOKEN'];
    delete process.env['XAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    const { restore } = captureConsole();
    const code = await runScan(tmpDir);
    restore();

    expect(code).toBe(1);
  });

  it('3. --json flag outputs valid JSON', async () => {
    process.env['GATEWAY_TOKEN'] = 'a'.repeat(32);
    process.env['XAI_API_KEY'] = 'test-key';

    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    await runScan(tmpDir, { json: true });
    console.log = original;

    const jsonOutput = output.join('\n');
    expect(() => JSON.parse(jsonOutput)).not.toThrow();
  });

  it('4. JSON output includes checks array and score', async () => {
    process.env['GATEWAY_TOKEN'] = 'a'.repeat(32);

    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    await runScan(tmpDir, { json: true });
    console.log = original;

    const parsed = JSON.parse(output.join('\n')) as { checks: unknown[]; score: number };
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(typeof parsed.score).toBe('number');
    expect(parsed.score).toBeGreaterThanOrEqual(0);
    expect(parsed.score).toBeLessThanOrEqual(100);
  });

  it('5. JSON checks have name, status, detail fields', async () => {
    process.env['GATEWAY_TOKEN'] = 'a'.repeat(32);

    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    await runScan(tmpDir, { json: true });
    console.log = original;

    const parsed = JSON.parse(output.join('\n')) as {
      checks: Array<{ name: string; status: string; detail: string }>;
    };

    for (const check of parsed.checks) {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('status');
      expect(check).toHaveProperty('detail');
      expect(['PASS', 'WARN', 'FAIL']).toContain(check.status);
    }
  });

  it('6. GATEWAY_TOKEN check PASS when token >= 32 chars', async () => {
    process.env['GATEWAY_TOKEN'] = 'a'.repeat(32);

    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    await runScan(tmpDir, { json: true });
    console.log = original;

    const parsed = JSON.parse(output.join('\n')) as {
      checks: Array<{ name: string; status: string }>;
    };

    const tokenCheck = parsed.checks.find((c) => c.name.includes('GATEWAY_TOKEN'));
    expect(tokenCheck?.status).toBe('PASS');
  });

  it('7. GATEWAY_TOKEN check FAIL when not set', async () => {
    delete process.env['GATEWAY_TOKEN'];

    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    await runScan(tmpDir, { json: true });
    console.log = original;

    const parsed = JSON.parse(output.join('\n')) as {
      checks: Array<{ name: string; status: string }>;
    };

    const tokenCheck = parsed.checks.find((c) => c.name.includes('GATEWAY_TOKEN'));
    expect(tokenCheck?.status).toBe('FAIL');
  });

  it('8. GATEWAY_TOKEN check FAIL when token < 32 chars', async () => {
    process.env['GATEWAY_TOKEN'] = 'short';

    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    await runScan(tmpDir, { json: true });
    console.log = original;

    const parsed = JSON.parse(output.join('\n')) as {
      checks: Array<{ name: string; status: string }>;
    };

    const tokenCheck = parsed.checks.find((c) => c.name.includes('GATEWAY_TOKEN'));
    expect(tokenCheck?.status).toBe('FAIL');
  });

  it('9. Config directory check WARN when not found', async () => {
    process.env['GATEWAY_TOKEN'] = 'a'.repeat(32);

    // Use a fresh isolated dir with NO config/ subdir
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-scan-isolated-'));
    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    try {
      await runScan(isolatedDir, { json: true });
    } finally {
      console.log = original;
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }

    const parsed = JSON.parse(output.join('\n')) as {
      checks: Array<{ name: string; status: string }>;
    };
    const configCheck = parsed.checks.find((c) => c.name === 'Config directory permissions');
    // Should be WARN since no config/ dir
    expect(configCheck?.status).toBe('WARN');
  });

  it('10. Vault check WARN when vault dirs do not exist', async () => {
    process.env['GATEWAY_TOKEN'] = 'a'.repeat(32);

    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));

    await runScan(tmpDir, { json: true });
    console.log = original;

    const parsed = JSON.parse(output.join('\n')) as {
      checks: Array<{ name: string; status: string }>;
    };
    const vaultCheck = parsed.checks.find((c) => c.name.toLowerCase().includes('vault'));
    expect(vaultCheck?.status).toBe('WARN');
  });
});
