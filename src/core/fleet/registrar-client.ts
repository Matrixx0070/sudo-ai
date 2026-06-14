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

  const payload: RegistrationPayload = {
    version: 1,
    deviceId: opts.identity.deviceId,
    publicKeyPem: opts.identity.publicKeyPem,
    hostname,
    version_str: opts.versionStr,
    ts: now(),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  const canonical = canonicalizePayload(payload);
  const signature = opts.identity.sign(canonical);
  const body: RegistrationRequestBody = { payload, signature };

  // Build URL; reject malformed registrar URL early with a structural err.
  let url: string;
  try {
    const u = new URL('/api/fleet/register', opts.registrarUrl);
    url = u.toString();
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_registrar_url',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

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
