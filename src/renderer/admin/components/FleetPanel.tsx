import React, { useState } from 'react';
import { Panel } from './shared/Panel';
import { useFleet, type FleetDevice, type FleetCommand } from '../hooks/useFleet';

/**
 * Gap #28c slice 3 — fleet admin panel.
 *
 * Layout (single wide panel):
 *   [device list ...........] [selected device's command history ...........]
 *                              [dispatch form ............................]
 *
 * Lives at the bottom of the dashboard. The panel only renders when the
 * registrar mode is enabled on the server; a 503 from the devices endpoint
 * collapses it to a single-line "fleet registrar not enabled" note so the
 * Dashboard.tsx can include <FleetPanel /> unconditionally.
 */

interface FleetPanelProps {
  token: string;
}

const statusPill: Record<FleetCommand['status'], string> = {
  queued:     'bg-[#21262d] text-[#8b949e] border border-[#30363d]',
  in_flight:  'bg-[#1f3d5d] text-[#79c0ff] border border-[#1f6feb]',
  completed:  'bg-[#0d4429] text-[#3fb950] border border-[#1a7f37]',
  failed:     'bg-[#3d0000] text-[#f85149] border border-[#b62324]',
  timeout:    'bg-[#3d2900] text-[#d29922] border border-[#9e6a03]',
};

export const FleetPanel: React.FC<FleetPanelProps> = ({ token }) => {
  const fleet = useFleet(token);
  const [kind, setKind] = useState<'model.get' | 'model.set'>('model.get');
  const [modelArg, setModelArg] = useState<string>('');
  const [busy, setBusy] = useState(false);

  if (fleet.registrarOff) {
    return (
      <Panel title="Fleet" wide>
        <div className="text-[#8b949e] text-[12px]">
          Fleet registrar not enabled. Set{' '}
          <code className="bg-[#21262d] px-[4px] py-[2px] rounded">SUDO_FLEET_REGISTRAR_MODE=1</code>{' '}
          on this host to accept device registrations and serve admin endpoints.
        </div>
      </Panel>
    );
  }

  const selected = fleet.devices.find((d) => d.deviceId === fleet.selectedDeviceId) ?? null;

  const onDispatch = async (): Promise<void> => {
    if (!selected || busy) return;
    const args: Record<string, unknown> | undefined =
      kind === 'model.set' ? { model: modelArg.trim() } : undefined;
    if (kind === 'model.set' && (!args || typeof args['model'] !== 'string' || (args['model'] as string).length === 0)) {
      return; // disabled via the submit guard below
    }
    setBusy(true);
    try {
      await fleet.dispatch({ deviceId: selected.deviceId, kind, ...(args ? { args } : {}) });
    } finally {
      setBusy(false);
    }
  };

  const onAdmissionToggle = async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      if (selected.admissionStatus === 'revoked') await fleet.admit(selected.deviceId);
      else await fleet.revoke(selected.deviceId);
    } finally {
      setBusy(false);
    }
  };

  const dispatchDisabled = !selected || busy
    || (kind === 'model.set' && modelArg.trim().length === 0)
    || (selected?.admissionStatus === 'revoked'); // can't dispatch to revoked devices

  return (
    <Panel title={`Fleet (${fleet.devices.length} device${fleet.devices.length === 1 ? '' : 's'})`} wide>
      {fleet.error && (
        <div className="mb-[10px] text-[#f85149] text-[12px]">⚠ {fleet.error}</div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-[260px,1fr] gap-[16px]">
        <DeviceList
          devices={fleet.devices}
          selectedDeviceId={fleet.selectedDeviceId}
          onSelect={fleet.selectDevice}
        />
        <div className="flex flex-col gap-[12px]">
          <DispatchForm
            selected={selected}
            kind={kind}
            setKind={setKind}
            modelArg={modelArg}
            setModelArg={setModelArg}
            onDispatch={onDispatch}
            disabled={dispatchDisabled}
            busy={busy}
            onAdmissionToggle={onAdmissionToggle}
          />
          <CommandHistory commands={fleet.commands} loading={fleet.loading} />
        </div>
      </div>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// sub-components
// ---------------------------------------------------------------------------

interface DeviceListProps {
  devices: FleetDevice[];
  selectedDeviceId: string | null;
  onSelect(id: string | null): void;
}
const DeviceList: React.FC<DeviceListProps> = ({ devices, selectedDeviceId, onSelect }) => {
  if (devices.length === 0) {
    return (
      <div className="text-[#6e7681] italic text-[12px]">
        No devices registered yet. Devices appear here after they POST{' '}
        <code className="bg-[#21262d] px-[3px] py-[1px] rounded">/api/fleet/register</code>{' '}
        with a signed payload.
      </div>
    );
  }
  return (
    <ul className="list-none p-0 m-0 flex flex-col gap-[4px] max-h-[280px] overflow-y-auto">
      {devices.map((d) => {
        const selected = d.deviceId === selectedDeviceId;
        // Slice 4 — prefer the heartbeat (last_seen_at) over the
        // register timestamp for the "last seen" line. Devices that
        // haven't polled yet still surface "registered N ago".
        const heartbeatIso = d.lastSeenAt ?? d.lastRegisteredAt;
        const online = d.lastSeenAt !== null && (Date.now() - Date.parse(d.lastSeenAt)) < 60_000;
        return (
          <li key={d.deviceId}>
            <button
              type="button"
              onClick={() => onSelect(d.deviceId)}
              className={`w-full text-left px-[10px] py-[6px] rounded border ${
                selected
                  ? 'bg-[#1f3d5d] border-[#1f6feb] text-[#e6edf3]'
                  : 'bg-[#0d1117] border-[#30363d] text-[#c9d1d9] hover:bg-[#161b22]'
              } cursor-pointer text-[12px]`}
              aria-pressed={selected}
            >
              <div className="flex items-center gap-[6px]">
                <span
                  aria-label={online ? 'online' : 'offline'}
                  className={`inline-block w-[8px] h-[8px] rounded-full ${
                    online ? 'bg-[#3fb950]' : 'bg-[#6e7681]'
                  }`}
                />
                <span className="font-bold break-all">{d.hostname}</span>
                {d.admissionStatus === 'revoked' && (
                  <span className="inline-block px-[6px] py-[1px] rounded-[10px] text-[10px] font-bold bg-[#3d0000] text-[#f85149] border border-[#b62324]">
                    revoked
                  </span>
                )}
              </div>
              <div className="text-[10px] text-[#8b949e] break-all">{d.deviceId}</div>
              <div className="text-[10px] text-[#6e7681]">
                v{d.versionStr} · {d.lastSeenAt ? 'last seen' : 'registered'} {formatRelative(heartbeatIso)}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
};

interface DispatchFormProps {
  selected: FleetDevice | null;
  kind: 'model.get' | 'model.set';
  setKind(k: 'model.get' | 'model.set'): void;
  modelArg: string;
  setModelArg(s: string): void;
  onDispatch(): void;
  disabled: boolean;
  busy: boolean;
  /** Slice 4 — flip admission state on the selected device. */
  onAdmissionToggle(): void;
}
const DispatchForm: React.FC<DispatchFormProps> = ({ selected, kind, setKind, modelArg, setModelArg, onDispatch, disabled, busy, onAdmissionToggle }) => {
  return (
    <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-[10px]">
      <div className="text-[#8b949e] text-[11px] uppercase tracking-wider mb-[8px]">Dispatch</div>
      {!selected && (
        <div className="text-[#6e7681] italic text-[12px]">Select a device from the list.</div>
      )}
      {selected && (
        <div className="flex flex-wrap gap-[8px] items-center">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'model.get' | 'model.set')}
            disabled={busy}
            className="bg-[#161b22] text-[#c9d1d9] border border-[#30363d] rounded px-[8px] py-[4px] text-[12px]"
            aria-label="Command kind"
          >
            <option value="model.get">model.get</option>
            <option value="model.set">model.set</option>
          </select>
          {kind === 'model.set' && (
            <input
              type="text"
              value={modelArg}
              placeholder="e.g. claude-sonnet-4-6"
              onChange={(e) => setModelArg(e.target.value)}
              disabled={busy}
              className="bg-[#161b22] text-[#c9d1d9] border border-[#30363d] rounded px-[8px] py-[4px] text-[12px] flex-1 min-w-[200px]"
              aria-label="Model name"
            />
          )}
          <button
            type="button"
            onClick={onDispatch}
            disabled={disabled}
            className={`px-[12px] py-[4px] text-[12px] rounded border ${
              disabled
                ? 'bg-[#21262d] text-[#6e7681] border-[#30363d] cursor-not-allowed'
                : 'bg-[#1f6feb] text-white border-[#1f6feb] cursor-pointer hover:bg-[#388bfd]'
            }`}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            onClick={onAdmissionToggle}
            disabled={busy}
            className={`px-[12px] py-[4px] text-[12px] rounded border ${
              busy
                ? 'bg-[#21262d] text-[#6e7681] border-[#30363d] cursor-not-allowed'
                : selected.admissionStatus === 'revoked'
                ? 'bg-[#0d4429] text-[#3fb950] border-[#1a7f37] cursor-pointer hover:opacity-80'
                : 'bg-[#3d0000] text-[#f85149] border-[#b62324] cursor-pointer hover:opacity-80'
            }`}
            aria-label={selected.admissionStatus === 'revoked' ? 'Admit device' : 'Revoke device'}
          >
            {selected.admissionStatus === 'revoked' ? 'Admit' : 'Revoke'}
          </button>
          <div className="text-[10px] text-[#6e7681] basis-full">
            → {selected.hostname} ({selected.deviceId.slice(0, 12)}…)
            {selected.admissionStatus === 'revoked' && ' · revoked — dispatch disabled'}
          </div>
        </div>
      )}
    </div>
  );
};

interface CommandHistoryProps {
  commands: FleetCommand[];
  loading: boolean;
}
const CommandHistory: React.FC<CommandHistoryProps> = ({ commands, loading }) => {
  if (commands.length === 0) {
    return (
      <div className="text-[#6e7681] italic text-[12px]">
        {loading ? 'Loading…' : 'No commands dispatched to this device yet.'}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="text-[#8b949e] text-left">
            <th className="font-normal pb-[6px] pr-[8px]">Status</th>
            <th className="font-normal pb-[6px] pr-[8px]">Kind</th>
            <th className="font-normal pb-[6px] pr-[8px]">Dispatched</th>
            <th className="font-normal pb-[6px] pr-[8px]">Completed</th>
            <th className="font-normal pb-[6px]">Result / Error</th>
          </tr>
        </thead>
        <tbody>
          {commands.map((c) => (
            <tr key={c.commandId} className="border-t border-[#21262d]">
              <td className="py-[4px] pr-[8px]">
                <span className={`inline-block px-[6px] py-[1px] rounded-[10px] text-[10px] font-bold ${statusPill[c.status]}`}>
                  {c.status}
                </span>
              </td>
              <td className="py-[4px] pr-[8px] text-[#c9d1d9]">{c.kind}</td>
              <td className="py-[4px] pr-[8px] text-[#8b949e]">{formatRelative(c.dispatchedAt)}</td>
              <td className="py-[4px] pr-[8px] text-[#8b949e]">
                {c.completedAt ? formatRelative(c.completedAt) : '—'}
              </td>
              <td className="py-[4px] text-[#c9d1d9] break-all max-w-[420px]">
                {c.error
                  ? <span className="text-[#f85149]">{c.error}</span>
                  : c.result !== undefined
                  ? <code className="text-[10px]">{JSON.stringify(c.result)}</code>
                  : <span className="text-[#6e7681]">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** Human-readable relative timestamp (s/m/h/d). */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  if (abs < 5_000) return 'just now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ago`;
  if (abs < 60 * 60_000) return `${Math.round(abs / 60_000)}m ago`;
  if (abs < 24 * 60 * 60_000) return `${Math.round(abs / 3_600_000)}h ago`;
  return `${Math.round(abs / 86_400_000)}d ago`;
}
