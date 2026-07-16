/**
 * @file tests/secrets/snapshot.test.ts
 * @description secrets.reload / secrets.resolve snapshot helpers (posture-only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadSecretSnapshot, secretResolveProbe } from '../../src/core/secrets/snapshot.js';
import { requiredScopeFor } from '../../src/core/gateway/rpc-schema.js';

let root: string;
let snapshot: Record<string, string | undefined>;

function mkRoot(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', '.env'), lines.join('\n') + '\n');
  return dir;
}

beforeEach(() => { snapshot = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(snapshot)) if (v !== undefined) process.env[k] = v;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('secrets.reload snapshot', () => {
  it('R-1: applies a changed credential from config/.env to process.env', async () => {
    delete process.env['GATEWAY_TOKEN'];
    root = mkRoot(['GATEWAY_TOKEN=new-rotated-token']);
    const res = await reloadSecretSnapshot(root);
    expect(res.changed).toContain('GATEWAY_TOKEN');
    expect(process.env['GATEWAY_TOKEN']).toBe('new-rotated-token');
  });

  it('R-2: unchanged values are not reported', async () => {
    process.env['GATEWAY_TOKEN'] = 'same';
    root = mkRoot(['GATEWAY_TOKEN=same']);
    const res = await reloadSecretSnapshot(root);
    expect(res.changed).not.toContain('GATEWAY_TOKEN');
    expect(res.reloaded).toBe(0);
  });

  it('R-3: a valid new _REF is applied (resolves)', async () => {
    process.env['SNAP_SRC'] = 'resolved-via-ref';
    delete process.env['WEB_CHAT_TOKEN_REF'];
    root = mkRoot(['WEB_CHAT_TOKEN_REF={"source":"env","provider":"default","id":"SNAP_SRC"}']);
    const res = await reloadSecretSnapshot(root);
    expect(res.changed).toContain('WEB_CHAT_TOKEN');
    expect(res.unresolved).not.toContain('WEB_CHAT_TOKEN');
  });

  it('R-4: a broken new _REF is NOT applied (last-known-good, reported unresolved)', async () => {
    delete process.env['GATEWAY_TOKEN_REF'];
    root = mkRoot(['GATEWAY_TOKEN_REF={"source":"env","provider":"default","id":"DOES_NOT_EXIST_ZZ"}']);
    const res = await reloadSecretSnapshot(root);
    expect(res.unresolved).toContain('GATEWAY_TOKEN');
    expect(process.env['GATEWAY_TOKEN_REF']).toBeUndefined(); // not applied
  });

  it('R-5: does not touch non-secret env keys', async () => {
    delete process.env['SOME_RANDOM_VAR'];
    root = mkRoot(['SOME_RANDOM_VAR=whatever', 'GATEWAY_TOKEN=x']);
    await reloadSecretSnapshot(root);
    expect(process.env['SOME_RANDOM_VAR']).toBeUndefined();
  });
});

describe('secrets.resolve probe (posture-only)', () => {
  it('P-1: inline credential → posture inline, resolves true, NO value field', () => {
    process.env['GATEWAY_TOKEN'] = 'a-secret-value';
    const r = secretResolveProbe({ name: 'GATEWAY_TOKEN' });
    expect(r).toEqual({ ok: true, name: 'GATEWAY_TOKEN', posture: 'inline', resolves: true });
    expect(JSON.stringify(r)).not.toContain('a-secret-value');
  });

  it('P-2: missing credential → posture missing, resolves false', () => {
    delete process.env['GATEWAY_SECRET'];
    delete process.env['GATEWAY_SECRET_REF'];
    expect(secretResolveProbe({ name: 'GATEWAY_SECRET' })).toEqual({ ok: true, name: 'GATEWAY_SECRET', posture: 'missing', resolves: false });
  });

  it('P-3: inline ref probe returns source/provider + resolves, never the value', () => {
    process.env['PROBE_SRC'] = 'the-real-secret';
    const r = secretResolveProbe({ ref: { source: 'env', provider: 'vault', id: 'PROBE_SRC' } });
    expect(r).toEqual({ ok: true, posture: 'secretref:env', provider: 'vault', resolves: true });
    expect(JSON.stringify(r)).not.toContain('the-real-secret');
  });

  it('P-4: invalid ref → ok:false', () => {
    expect(secretResolveProbe({ ref: { source: 'bogus', provider: 'x', id: 'y' } })).toEqual({ ok: false, error: 'invalid SecretRef' });
    expect(secretResolveProbe({})).toEqual({ ok: false, error: 'provide { name } or { ref }' });
  });
});

describe('secrets.* RPC scopes', () => {
  it('SC-1: both methods require operator.admin', () => {
    expect(requiredScopeFor('secrets.reload')).toBe('operator.admin');
    expect(requiredScopeFor('secrets.resolve')).toBe('operator.admin');
  });
});
