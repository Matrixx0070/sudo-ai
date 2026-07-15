/**
 * @file tests/cli/secrets-command.test.ts
 * @description `sudo-ai secrets` audit / apply / configure handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSecretsAudit, runSecretsApply, runSecretsConfigure } from '../../src/cli/commands/secrets.js';

let root: string;
let envSnapshot: Record<string, string | undefined>;

function mkRoot(envLines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sec-cli-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', '.env'), envLines.join('\n') + '\n');
  return dir;
}

beforeEach(() => {
  envSnapshot = { ...process.env };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  // restore process.env exactly (handlers hydrate it from the temp .env)
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(envSnapshot)) if (v !== undefined) process.env[k] = v;
  vi.restoreAllMocks();
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('secrets audit', () => {
  it('A-1: clean gateway token → exit 0, no critical', async () => {
    root = mkRoot(['GATEWAY_TOKEN=a-sufficiently-long-token-1234']);
    expect(await runSecretsAudit(root)).toBe(0);
  });

  it('A-2: short GATEWAY_TOKEN → WARN but still exit 0', async () => {
    root = mkRoot(['GATEWAY_TOKEN=short']);
    const logs: string[] = [];
    (console.log as unknown as { mockRestore(): void }).mockRestore?.();
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    expect(await runSecretsAudit(root)).toBe(0);
    expect(logs.join('\n')).toContain('token_too_short');
  });
});

describe('secrets apply (dry-run)', () => {
  it('AP-1: no SecretRefs declared → exit 0', async () => {
    root = mkRoot(['GATEWAY_TOKEN=plain']);
    expect(await runSecretsApply(root)).toBe(0);
  });

  it('AP-2: a resolvable env SecretRef → exit 0', async () => {
    root = mkRoot([
      'AP_SRC_VALUE=resolved',
      'GATEWAY_TOKEN_REF={"source":"env","provider":"default","id":"AP_SRC_VALUE"}',
    ]);
    expect(await runSecretsApply(root)).toBe(0);
  });

  it('AP-3: an unresolvable SecretRef → exit 1', async () => {
    root = mkRoot([
      'GATEWAY_TOKEN_REF={"source":"env","provider":"default","id":"NOT_SET_ANYWHERE_ZZZ"}',
    ]);
    expect(await runSecretsApply(root)).toBe(1);
  });
});

describe('secrets configure', () => {
  it('C-1: missing required args → exit 1', () => {
    root = mkRoot([]);
    expect(runSecretsConfigure(root, { name: 'GATEWAY_TOKEN' })).toBe(1);
  });

  it('C-2: invalid source → exit 1', () => {
    root = mkRoot([]);
    expect(runSecretsConfigure(root, { name: 'X', source: 'bogus', id: 'Y' })).toBe(1);
  });

  it('C-3: advisory (no --write) prints the line, does NOT touch config/.env', () => {
    root = mkRoot(['EXISTING=1']);
    const before = readFileSync(join(root, 'config', '.env'), 'utf8');
    const logs: string[] = [];
    (console.log as unknown as { mockRestore(): void }).mockRestore?.();
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    expect(runSecretsConfigure(root, { name: 'GATEWAY_TOKEN', source: 'file', id: '/run/secrets/tok' })).toBe(0);
    expect(logs.join('\n')).toContain('GATEWAY_TOKEN_REF=');
    expect(readFileSync(join(root, 'config', '.env'), 'utf8')).toBe(before); // unchanged
  });

  it('C-4: --write appends the line + creates a .bak backup', () => {
    root = mkRoot(['EXISTING=1']);
    expect(runSecretsConfigure(root, { name: 'GATEWAY_TOKEN', source: 'file', id: '/run/secrets/tok', write: true })).toBe(0);
    const env = readFileSync(join(root, 'config', '.env'), 'utf8');
    expect(env).toContain('GATEWAY_TOKEN_REF={"source":"file","provider":"default","id":"/run/secrets/tok"}');
    expect(existsSync(join(root, 'config', '.env.bak'))).toBe(true);
  });

  it('C-5: refuses to clobber a differing existing value without --force', () => {
    root = mkRoot(['GATEWAY_TOKEN_REF={"source":"env","provider":"default","id":"OLD"}']);
    expect(runSecretsConfigure(root, { name: 'GATEWAY_TOKEN', source: 'file', id: '/new/path', write: true })).toBe(1);
    // with --force it overwrites in place
    expect(runSecretsConfigure(root, { name: 'GATEWAY_TOKEN', source: 'file', id: '/new/path', write: true, force: true })).toBe(0);
    const env = readFileSync(join(root, 'config', '.env'), 'utf8');
    expect(env).toContain('"id":"/new/path"');
    expect(env).not.toContain('"id":"OLD"');
  });
});
