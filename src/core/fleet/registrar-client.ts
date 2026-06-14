/**
 * @file src/core/fleet/registrar-client.ts
 * @description Gap #28c slice 1 — device-side HTTP client that posts a
 * signed registration to a configured central registrar.
 *
 * This runs once at boot (best-effort — if the registrar is unreachable
 * the device keeps running, the next boot retries). Slice 2 will add a
 * periodic heartbeat-re-register so the registrar's last_seen tracks
 * liveness, not just last-boot.
 */

import os from 'node:os';
import type { DeviceIdentity } from './device-identity.js';
import {
  canonicalizePayload,
  type RegistrationPayload,
  type RegistrationRequestBody,
} from './registration.js';

/** Options for `registerWithRegistrar`. */
export interface RegistrarClientOptions {
  /** Base URL of the registrar, e.g. `http://registrar.internal:18910`. */
  registrarUrl: string;
  /** Loaded device identity (slice 1 — keeps signing material in memory). */
  identity: DeviceIdentity;
  /** sudo-ai version string (`package.json` "version"). */
  versionStr: string;
  /** Free-form metadata bag stored alongside the device row. */
  metadata?: Record<string, string>;
  /** Hostname override (testing). Defaults to os.hostname(). */
  hostname?: string;
  /** Wall-clock override (testing). Defaults to Date.now(). */
  now?: () => number;
  /** Total HTTP timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Custom fetch impl (testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Result tier. */
export type RegistrarClientResult =
  | { ok: true; status: number; deviceId: string; registeredAt: string }
  | { ok: false; reason: string; status?: number; detail?: string };

/**
 * Build the signed envelope and POST it to the registrar. Errors are
 * caught + reported structurally; this function NEVER throws so boot
 * code can call it without a try/catch.
 */
export async function registerWithRegistrar(opts: RegistrarClientOptions): Promise<RegistrarClientResult> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hostname = opts.hostname ?? os.hostname();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Slice 4: fetch a single-use nonce first. The registrar's
  // verifyRegistrationRequest rejects payloads without a current nonce, so
  // we MUST do this round-trip even though it costs an extra RTT. The
  // operator-facing API stays unchanged — callers don't see the challenge.
  let challengeUrl: string;
  let registerUrl: string;
  try {
    challengeUrl = new URL(
      `/api/fleet/challenge?deviceId=${encodeURIComponent(opts.identity.deviceId)}`,
      opts.registrarUrl,
    ).toString();
    registerUrl = new URL('/api/fleet/register', opts.registrarUrl).toString();
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_registrar_url',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const challengeController = new AbortController();
  const challengeTimer = setTimeout(() => challengeController.abort(), timeoutMs);
  let nonce: string;
  try {
    const challengeRes = await fetchImpl(challengeUrl, {
      method: 'GET',
      signal: challengeController.signal,
    });
    if (!challengeRes.ok) {
      const detail = await challengeRes.text().catch(() => '');
      return {
        ok: false,
        reason: 'challenge_rejected',
        status: challengeRes.status,
        detail: detail.slice(0, 200) || `HTTP ${challengeRes.status}`,
      };
    }
    const challengeJson = (await challengeRes.json()) as { nonce?: string };
    if (typeof challengeJson.nonce !== 'string' || challengeJson.nonce.length === 0) {
      return { ok: false, reason: 'challenge_invalid_response' };
    }
    nonce = challengeJson.nonce;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (challengeController.signal.aborted) {
      return { ok: false, reason: 'timeout', detail: `challenge aborted after ${timeoutMs}ms` };
    }
    return { ok: false, reason: 'network_error', detail: msg };
  } finally {
    clearTimeout(challengeTimer);
  }

  const payload: RegistrationPayload = {
    version: 2,
    deviceId: opts.identity.deviceId,
    publicKeyPem: opts.identity.publicKeyPem,
    hostname,
    version_str: opts.versionStr,
    ts: now(),
    nonce,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  const canonical = canonicalizePayload(payload);
  const signature = opts.identity.sign(canonical);
  const body: RegistrationRequestBody = { payload, signature };
  const url = registerUrl;

  // AbortController for timeout. `AbortSignal.timeout` is Node 16.14+ but
  // older Node deployments still see this code, so use AbortController
  // explicitly for max compatibility.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json: { ok?: boolean; deviceId?: string; registeredAt?: string; error?: string } = {};
    try {
      json = await res.json() as typeof json;
    } catch {
      // Empty / non-JSON body is fine for non-200s; we'll report status.
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: 'registrar_rejected',
        status: res.status,
        detail: json.error ?? `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      status: res.status,
      deviceId: json.deviceId ?? opts.identity.deviceId,
      registeredAt: json.registeredAt ?? new Date(now()).toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return { ok: false, reason: 'timeout', detail: `aborted after ${timeoutMs}ms` };
    }
    return { ok: false, reason: 'network_error', detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
