import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Gap #28c slice 3 — UI side of the fleet admin endpoints.
 *
 * Three thin wrappers around the slice-1 + slice-2 routes:
 *   GET  /api/admin/fleet/devices
 *   GET  /api/admin/fleet/devices/:id/commands
 *   POST /api/admin/fleet/dispatch
 *
 * `useFleet` glues them into a tiny store: device list + per-device
 * commands + dispatch action + refresh action. Auto-polls every 5s while
 * the panel is mounted (matches the rest of the dashboard's poll cadence).
 *
 * The hook does NOT throw — fetch errors are surfaced as a string in
 * `error`. The panel renders the last-good data even while the latest
 * poll is errored, which mirrors the AlignmentPanel/VetoPanel posture.
 */

export interface FleetDevice {
  deviceId: string;
  hostname: string;
  versionStr: string;
  firstRegisteredAt: string;
  lastRegisteredAt: string;
  /** Slice 4 — null for devices that haven't yet polled the inbox. */
  lastSeenAt: string | null;
  /**
   * Slice 4 — admin can revoke a device's access. Slice-4 follow-up
   * adds `pending` for devices that registered but are waiting for
   * the admin to explicitly admit them before first dispatch.
   */
  admissionStatus: 'approved' | 'revoked' | 'pending';
  publicKeyFingerprint: string;
  metadata: Record<string, string> | null;
}

export interface FleetCommand {
  commandId: string;
  deviceId: string;
  kind: string;
  args?: Record<string, unknown>;
  status: 'queued' | 'in_flight' | 'completed' | 'failed' | 'timeout';
  dispatchedAt: string;
  pickedUpAt: string | null;
  completedAt: string | null;
  result?: unknown;
  error?: string;
}

export interface UseFleetReturn {
  devices: FleetDevice[];
  selectedDeviceId: string | null;
  selectDevice(deviceId: string | null): void;
  commands: FleetCommand[];
  loading: boolean;
  error: string | null;
  /** True iff the registrar mode is OFF on the server (503 fleet_registrar_not_enabled). */
  registrarOff: boolean;
  /** Trigger a manual refresh. */
  refresh(): Promise<void>;
  /** Send a dispatch POST + refresh commands history. */
  dispatch(input: { deviceId: string; kind: 'model.get' | 'model.set'; args?: Record<string, unknown> }): Promise<string | null>;
  /** Slice 4 — admit a device (flip admission_status → approved). */
  admit(deviceId: string): Promise<boolean>;
  /** Slice 4 — revoke a device (flip admission_status → revoked). */
  revoke(deviceId: string): Promise<boolean>;
}

const POLL_INTERVAL_MS = 5000;

export function useFleet(token: string): UseFleetReturn {
  const [devices, setDevices] = useState<FleetDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [commands, setCommands] = useState<FleetCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrarOff, setRegistrarOff] = useState(false);
  // Stale-poll guard: discard responses that arrived after a newer poll fired.
  const generation = useRef(0);

  const fetchDevices = useCallback(async (): Promise<FleetDevice[] | null> => {
    const res = await fetch('/api/admin/fleet/devices', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 503) {
      setRegistrarOff(true);
      return null;
    }
    if (!res.ok) throw new Error(`devices HTTP ${res.status}`);
    setRegistrarOff(false);
    const json = (await res.json()) as { devices: FleetDevice[] };
    return json.devices;
  }, [token]);

  const fetchCommands = useCallback(async (deviceId: string): Promise<FleetCommand[]> => {
    const res = await fetch(`/api/admin/fleet/devices/${encodeURIComponent(deviceId)}/commands?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return []; // device unregistered or just removed
    if (!res.ok) throw new Error(`commands HTTP ${res.status}`);
    const json = (await res.json()) as { commands: FleetCommand[] };
    return json.commands;
  }, [token]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) return;
    const myGen = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const list = await fetchDevices();
      if (myGen !== generation.current) return; // stale
      if (list === null) {
        setDevices([]);
        setCommands([]);
        return;
      }
      setDevices(list);
      // Auto-select first device if nothing is selected.
      const targetId = selectedDeviceId ?? list[0]?.deviceId ?? null;
      if (selectedDeviceId !== targetId) setSelectedDeviceId(targetId);
      if (targetId) {
        const cmds = await fetchCommands(targetId);
        if (myGen !== generation.current) return;
        setCommands(cmds);
      } else {
        setCommands([]);
      }
    } catch (err) {
      if (myGen !== generation.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (myGen === generation.current) setLoading(false);
    }
  }, [token, fetchDevices, fetchCommands, selectedDeviceId]);

  const dispatch = useCallback(async (input: { deviceId: string; kind: 'model.get' | 'model.set'; args?: Record<string, unknown> }): Promise<string | null> => {
    if (!token) return null;
    try {
      const res = await fetch('/api/admin/fleet/dispatch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: input.deviceId, command: { kind: input.kind, ...(input.args ? { args: input.args } : {}) } }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setError(`dispatch failed: HTTP ${res.status} ${body.slice(0, 120)}`);
        return null;
      }
      const json = (await res.json()) as { commandId: string };
      // Refresh history so the operator sees the queued row immediately.
      await refresh();
      return json.commandId;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [token, refresh]);

  const selectDevice = useCallback((deviceId: string | null) => {
    setSelectedDeviceId(deviceId);
  }, []);

  const flipAdmission = useCallback(async (deviceId: string, action: 'admit' | 'revoke'): Promise<boolean> => {
    if (!token) return false;
    try {
      const res = await fetch(`/api/admin/fleet/devices/${encodeURIComponent(deviceId)}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setError(`${action} failed: HTTP ${res.status} ${body.slice(0, 120)}`);
        return false;
      }
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [token, refresh]);

  const admit = useCallback((id: string) => flipAdmission(id, 'admit'), [flipAdmission]);
  const revoke = useCallback((id: string) => flipAdmission(id, 'revoke'), [flipAdmission]);

  // Initial load + poll.
  useEffect(() => {
    if (!token) return;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [token, refresh]);

  // Refresh commands when the selected device changes.
  useEffect(() => {
    if (!token || !selectedDeviceId) return;
    let cancelled = false;
    fetchCommands(selectedDeviceId)
      .then((cmds) => { if (!cancelled) setCommands(cmds); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [token, selectedDeviceId, fetchCommands]);

  return { devices, selectedDeviceId, selectDevice, commands, loading, error, registrarOff, refresh, dispatch, admit, revoke };
}
