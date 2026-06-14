/**
 * @file tests/fleet/fleet-live-daemon-e2e.test.ts
 * @description Gap #28c — end-to-end fleet hardening test against a REAL
 * spawned sudo-ai daemon. Complements `fleet-slice4-hardening.test.ts`,
 * which exercises the dashboard server *in-process*. This one spawns the
 * actual CLI (`tsx src/cli/index.ts start`) so we catch wiring bugs in:
 *   - CLI env handling (SUDO_FLEET_REGISTRAR_MODE, SUDO_DASHBOARD_TOKEN,
 *     SUDO_DASHBOARD_PORT, SUDO_ADMIN_POWERS, DATA_DIR)
 *   - registrar / command-queue / nonce-store construction order
 *   - dashboard server registration of the fleet globals
 *   - loopback bind + Bearer auth
 *   - real Ed25519 sign/verify on real TCP — no in-process test doubles
 *
 * Memory `feedback-real-e2e-test-exec-features` flagged exactly this gap:
 * exec/sandbox/fleet-shaped features hide bugs in subprocess wiring that
 * unit tests + verifier miss until a live container/daemon catches them.
 *
 * **Opt-in by default.** Set `SUDO_FLEET_LIVE_E2E=1` to run. Skipping
 * keeps `pnpm test` fast; CI can add this on a dedicated job.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  generateKeyPairSync,
  createPublicKey,
  createHash,
  sign as cryptoSign,
} from 'node:crypto';

const RUN_LIVE = process.env['SUDO_FLEET_LIVE_E2E'] === '1';
const describeOrSkip = RUN_LIVE ? describe : describe.skip;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function computeDeviceId(publicKeyPem: string): string {
  const pk = createPublicKey(publicKeyPem);
  return createHash('sha256').update(pk.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') { srv.close(); reject(new Error('no port')); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function httpJson(base: string, method: string, urlPath: string, init: { headers?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {}): Promise<{ status: number; json: unknown }> {
  const url = new URL(urlPath, base);
  if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text.length ? JSON.parse(text) : undefined; } catch { /* leave undefined */ }
  return { status: res.status, json };
}

describeOrSkip('fleet live daemon E2E (#28c)', () => {
  it('challenge → register → dispatch → long-poll → result → heartbeat → revoke', { timeout: 120_000 }, async () => {
    const port = await pickFreePort();
    const base = `http://127.0.0.1:${port}`;
    const token = 'live-e2e-admin-token';
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fleet-live-e2e-'));
    const logPath = path.join(dataDir, 'daemon.log');
    const out = openSync(logPath, 'a');

    const tsx = path.resolve('node_modules/.bin/tsx');
    const cli = path.resolve('src/cli/index.ts');
    const env = {
      ...process.env,
      DATA_DIR: dataDir,
      SUDO_FLEET_REGISTRAR_MODE: '1',
      SUDO_DASHBOARD_PORT: String(port),
      SUDO_DASHBOARD_TOKEN: token,
      SUDO_ADMIN_POWERS: '1',
      SUDO_DASHBOARD_DISABLE: '0',
      SUDO_DISCORD_DISABLE: '1',
      SUDO_TELEGRAM_DISABLE: '1',
      SUDO_DASHBOARD_LOG_RING_DISABLE: '1',
      NODE_ENV: 'test',
    };
    const daemon = spawn(tsx, [cli, 'start'], { env, stdio: ['ignore', out, out] });
    let exited = false;
    daemon.on('exit', () => { exited = true; });

    const teardown = async (): Promise<void> => {
      if (!exited) {
        daemon.kill('SIGTERM');
        for (let i = 0; i < 20 && !exited; i++) await sleep(250);
        if (!exited) daemon.kill('SIGKILL');
      }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    try {
      // Boot probe — /api/health returns 200 on a loopback GET (loopback-trust skips auth).
      const bootDeadline = Date.now() + 90_000;
      let booted = false;
      while (Date.now() < bootDeadline) {
        try {
          const r = await fetch(`${base}/api/health`);
          if (r.status === 200) { booted = true; break; }
        } catch { /* still booting */ }
        await sleep(500);
      }
      expect(booted, 'daemon should expose /api/health within boot timeout').toBe(true);

      // Synthetic device identity.
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const deviceId = computeDeviceId(publicKeyPem);
      const sign = (data: string): string => b64url(cryptoSign(null, Buffer.from(data, 'utf8'), privateKey));
      const signHeaders = (method: string, urlPath: string): Record<string, string> => {
        const ts = Date.now();
        const data = `${method.toUpperCase()}\n${urlPath}\n${ts}\n${deviceId}`;
        return {
          'X-Fleet-Signature': sign(data),
          'X-Fleet-Timestamp': String(ts),
          'X-Fleet-Device-Id': deviceId,
        };
      };
      const adminHeaders = { authorization: `Bearer ${token}` };

      // 1. Challenge.
      let r = await httpJson(base, 'GET', '/api/fleet/challenge', { query: { deviceId } });
      expect(r.status).toBe(200);
      const nonce = (r.json as { nonce: string }).nonce;
      expect(typeof nonce).toBe('string');

      // 2. Register — signed canonical payload.
      const payload = {
        version: 2 as const,
        deviceId,
        publicKeyPem,
        hostname: 'live-e2e-host',
        version_str: '4.1.0-live-e2e',
        ts: Date.now(),
        nonce,
        metadata: { run: 'fleet-live-e2e' },
      };
      const sigReg = sign(canonicalJson(payload));
      r = await httpJson(base, 'POST', '/api/fleet/register', { body: { payload, signature: sigReg } });
      expect(r.status).toBe(200);
      expect((r.json as { ok: boolean }).ok).toBe(true);

      // 3. Replay — slice-4 nonce store must refuse.
      r = await httpJson(base, 'POST', '/api/fleet/register', { body: { payload, signature: sigReg } });
      expect(r.status).toBe(400);
      expect((r.json as { reason: string }).reason).toBe('nonce_consumed_or_unknown');

      // 4. Admin list — see device, status=approved, lastSeenAt null (pre-inbox).
      r = await httpJson(base, 'GET', '/api/admin/fleet/devices', { headers: adminHeaders });
      expect(r.status).toBe(200);
      const found = (r.json as { devices: Array<{ deviceId: string; admissionStatus: string; lastSeenAt: string | null }> }).devices.find((d) => d.deviceId === deviceId);
      expect(found?.admissionStatus).toBe('approved');
      expect(found?.lastSeenAt).toBeNull();

      // 5. Admin dispatch.
      r = await httpJson(base, 'POST', '/api/admin/fleet/dispatch', {
        headers: adminHeaders,
        body: { deviceId, command: { kind: 'model.get' } },
      });
      expect(r.status).toBe(202);
      const commandId = (r.json as { commandId: string }).commandId;
      expect(typeof commandId).toBe('string');

      // 6. Device long-polls inbox — must return the same command.
      const inboxPath = `/api/fleet/device/${deviceId}/inbox`;
      r = await httpJson(base, 'GET', `${inboxPath}?wait=5`, { headers: signHeaders('GET', inboxPath) });
      expect(r.status).toBe(200);
      const cmd = r.json as { commandId: string; kind: string };
      expect(cmd.commandId).toBe(commandId);
      expect(cmd.kind).toBe('model.get');

      // 7. Device posts result.
      const resultPath = `/api/fleet/device/${deviceId}/result`;
      r = await httpJson(base, 'POST', resultPath, {
        headers: signHeaders('POST', resultPath),
        body: { commandId, status: 'completed', result: { model: 'mock-model-id' } },
      });
      expect(r.status).toBe(200);
      expect((r.json as { status: string }).status).toBe('completed');

      // 8. Command history reflects the completion.
      r = await httpJson(base, 'GET', `/api/admin/fleet/devices/${deviceId}/commands`, { headers: adminHeaders });
      expect(r.status).toBe(200);
      const row = (r.json as { commands: Array<{ commandId: string; status: string; result?: { model?: string } }> }).commands.find((c) => c.commandId === commandId);
      expect(row?.status).toBe('completed');
      expect(row?.result?.model).toBe('mock-model-id');

      // 9. Heartbeat — inbox poll bumped lastSeenAt.
      r = await httpJson(base, 'GET', '/api/admin/fleet/devices', { headers: adminHeaders });
      const after = (r.json as { devices: Array<{ deviceId: string; lastSeenAt: string | null }> }).devices.find((d) => d.deviceId === deviceId);
      expect(typeof after?.lastSeenAt).toBe('string');
      expect((after?.lastSeenAt ?? '').length).toBeGreaterThan(0);

      // 10. Admin revoke.
      r = await httpJson(base, 'POST', `/api/admin/fleet/devices/${deviceId}/revoke`, { headers: adminHeaders, body: {} });
      expect(r.status).toBe(200);
      expect((r.json as { admissionStatus: string }).admissionStatus).toBe('revoked');

      // 11. Revoked device blocked from back-channel.
      r = await httpJson(base, 'GET', `${inboxPath}?wait=0`, { headers: signHeaders('GET', inboxPath) });
      expect(r.status).toBe(403);
      expect((r.json as { error: string }).error).toBe('device_revoked');

      // 12. Admin dispatch to revoked device refused.
      r = await httpJson(base, 'POST', '/api/admin/fleet/dispatch', {
        headers: adminHeaders,
        body: { deviceId, command: { kind: 'model.get' } },
      });
      expect(r.status).toBe(403);
      expect((r.json as { error: string }).error).toBe('device_revoked');
    } finally {
      await teardown();
    }
  });
});
