/**
 * @file gdrive/control-panel.ts
 * @description F7 — tune the agent from a phone; includes a remote PAUSE.
 *
 * Sheet tabs: Config (key|value|type|min|max|appliedAt|status), Control
 * (PAUSE cell B2), Frozen (display-only — the harness WRITES current
 * frozen-surface values for visibility and NEVER reads this tab back).
 *
 * Enforcement is HARNESS-SIDE (Sheet permissions can't protect against the
 * owner): every value validates against the typed whitelist below with hard
 * bounds; frozen keys appearing in Config are rejected; unknown keys are
 * flagged. PAUSE=TRUE writes the same pause flag canaries use, so every
 * gdrive job idles while heartbeats continue (heartbeat checks nothing).
 */

import { createLogger } from '../shared/logger.js';
import { PROTECTED_PATHS } from '../self-build/protected-paths.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import { setGdrivePaused, clearGdrivePause, isGdrivePaused } from './canary.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';

const log = createLogger('gdrive:control-panel');

export const CONTROL_PANEL_NAME = 'control-panel';

// ---------------------------------------------------------------------------
// Typed tunable-key whitelist (hard bounds, harness-side)
// ---------------------------------------------------------------------------

export interface TunableSpec {
  key: string;
  type: 'number' | 'boolean';
  min?: number;
  max?: number;
  /** Applies a validated value to the running process. */
  apply: (value: number | boolean) => void;
}

/**
 * Default tunables: env-backed knobs that jobs read at call time. Cron
 * cadence changes take effect on next boot (re-upsert) — noted in status
 * writeback so the operator isn't misled.
 */
export function defaultTunables(env: NodeJS.ProcessEnv = process.env): TunableSpec[] {
  const envApply = (name: string) => (v: number | boolean) => {
    env[name] = String(typeof v === 'boolean' ? (v ? '1' : '0') : v);
  };
  return [
    { key: 'gdrive.rps', type: 'number', min: 1, max: 50, apply: envApply('GDRIVE_RPS') },
    { key: 'gdrive.burst', type: 'number', min: 1, max: 100, apply: envApply('GDRIVE_BURST') },
    { key: 'gdrive.inboxMs', type: 'number', min: 10_000, max: 3_600_000, apply: envApply('SUDO_GDRIVE_INBOX_MS') },
    { key: 'gdrive.checkpointMs', type: 'number', min: 60_000, max: 86_400_000, apply: envApply('SUDO_GDRIVE_CHECKPOINT_MS') },
    { key: 'gdrive.heartbeatMs', type: 'number', min: 10_000, max: 3_600_000, apply: envApply('GDRIVE_HEARTBEAT_MS') },
    { key: 'quarantine.threshold', type: 'number', min: 0.1, max: 0.9, apply: envApply('GDRIVE_QUARANTINE_THRESHOLD') },
  ];
}

/** Frozen keys: never tunable via the Sheet, rejected on sight. */
export function frozenKeySet(): Set<string> {
  return new Set([
    ...PROTECTED_PATHS.map((p) => `path:${p}`),
    'BRAIN_HMAC_KEY_PATH',
    'BRAIN_ENC_KEY_PATH',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GDRIVE_CANARY_CONFIG',
    'SUDO_GDRIVE', // the master switch is operator-only, not phone-tunable
  ]);
}

// ---------------------------------------------------------------------------
// Sheet bootstrap
// ---------------------------------------------------------------------------

function panelIdCachePath(): string {
  return dataPath('gdrive', 'control-panel-id.json');
}

export function loadControlPanelId(): string | null {
  try {
    return (JSON.parse(readFileSync(panelIdCachePath(), 'utf-8')) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

function savePanelId(id: string): void {
  const p = panelIdCachePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ id }), { mode: 0o600 });
}

export async function ensureControlPanel(
  client: DriveClient,
  folders: FolderIdMap,
  tunables: TunableSpec[] = defaultTunables(),
): Promise<string> {
  const cached = loadControlPanelId();
  if (cached) return cached;
  const opsId = folders['ops'];
  if (!opsId) throw new Error('gdrive control-panel: ops folder id missing');

  let id: string;
  const existing = (await client.listChildren(opsId)).find((f) => f.name === CONTROL_PANEL_NAME);
  if (existing) {
    id = existing.id;
  } else {
    const created = await client.sheetsCreateSpreadsheet(CONTROL_PANEL_NAME, opsId);
    id = created.id;
  }

  const meta = await client.sheetsGetMeta(id);
  const have = new Set(meta.sheets.map((s) => s.title));
  const wanted = ['Config', 'Control', 'Frozen'];
  const add = wanted.filter((t) => !have.has(t)).map((t) => ({ addSheet: { properties: { title: t } } }));
  if (add.length) await client.sheetsBatchUpdate(id, add);

  if (!have.has('Config')) {
    await client.sheetsValuesUpdate(id, 'Config!A1', [
      ['key', 'value', 'type', 'min', 'max', 'appliedAt', 'status'],
      ...tunables.map((t) => [t.key, '', t.type, t.min ?? '', t.max ?? '', '', 'unset']),
    ]);
  }
  if (!have.has('Control')) {
    await client.sheetsValuesUpdate(id, 'Control!A1', [
      ['control', 'value'],
      ['PAUSE', 'FALSE'],
    ]);
  }
  if (!have.has('Frozen')) {
    // Display-only; the poll loop never reads this tab back.
    await client.sheetsValuesUpdate(id, 'Frozen!A1', [
      ['frozen surface (read-only display — edits here do NOTHING)'],
      ...[...frozenKeySet()].map((k) => [k]),
    ]);
  }
  savePanelId(id);
  log.info({ id, created: !existing }, 'control panel ensured');
  return id;
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

export interface PanelPollResult {
  applied: string[];
  rejected: Array<{ key: string; reason: string }>;
  paused: boolean;
}

export async function pollControlPanel(
  client: DriveClient,
  spreadsheetId: string,
  tunables: TunableSpec[] = defaultTunables(),
  now: () => Date = () => new Date(),
): Promise<PanelPollResult> {
  const result: PanelPollResult = { applied: [], rejected: [], paused: isGdrivePaused() };
  const byKey = new Map(tunables.map((t) => [t.key, t]));
  const frozen = frozenKeySet();

  const rows = await client.sheetsValuesGet(spreadsheetId, 'Config!A2:G');
  const statusUpdates: unknown[][] = [];
  for (const row of rows) {
    const [key, rawValue] = [String(row[0] ?? ''), String(row[1] ?? '')];
    const prevStatus = String(row[6] ?? '');
    if (!key) {
      statusUpdates.push([row[5] ?? '', prevStatus]);
      continue;
    }
    if (rawValue === '') {
      statusUpdates.push(['', 'unset']);
      continue;
    }
    if (frozen.has(key)) {
      statusUpdates.push([now().toISOString(), 'rejected: FROZEN key — not tunable via Sheet']);
      result.rejected.push({ key, reason: 'frozen' });
      continue;
    }
    const spec = byKey.get(key);
    if (!spec) {
      statusUpdates.push([now().toISOString(), 'rejected: unknown key']);
      result.rejected.push({ key, reason: 'unknown' });
      continue;
    }
    let value: number | boolean;
    if (spec.type === 'number') {
      value = Number(rawValue);
      if (!Number.isFinite(value)) {
        statusUpdates.push([now().toISOString(), 'rejected: not a number']);
        result.rejected.push({ key, reason: 'not a number' });
        continue;
      }
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
        statusUpdates.push([now().toISOString(), `rejected: out of bounds [${spec.min}, ${spec.max}]`]);
        result.rejected.push({ key, reason: 'out of bounds' });
        continue;
      }
    } else {
      const norm = rawValue.trim().toUpperCase();
      if (norm !== 'TRUE' && norm !== 'FALSE') {
        statusUpdates.push([now().toISOString(), 'rejected: not TRUE/FALSE']);
        result.rejected.push({ key, reason: 'not boolean' });
        continue;
      }
      value = norm === 'TRUE';
    }
    spec.apply(value);
    const note = key.endsWith('Ms') ? 'applied (cron cadence: takes effect on next boot)' : 'applied';
    statusUpdates.push([now().toISOString(), note]);
    result.applied.push(key);
  }
  if (statusUpdates.length) {
    await client.sheetsValuesUpdate(spreadsheetId, `Config!F2:G${1 + statusUpdates.length}`, statusUpdates);
  }

  // Control tab — PAUSE.
  const control = await client.sheetsValuesGet(spreadsheetId, 'Control!A2:B2');
  const pauseRaw = String(control[0]?.[1] ?? 'FALSE').trim().toUpperCase();
  if (pauseRaw === 'TRUE' && !isGdrivePaused()) {
    setGdrivePaused('control-panel PAUSE');
    result.paused = true;
    log.warn('PAUSE engaged from control panel');
  } else if (pauseRaw === 'FALSE' && isGdrivePaused()) {
    // Only clear a panel-originated pause; canary pauses need operator action.
    try {
      const flag = JSON.parse(readFileSync(dataPath('gdrive', 'PAUSED'), 'utf-8')) as { reason?: string };
      if (flag.reason?.startsWith('control-panel')) {
        clearGdrivePause();
        result.paused = false;
        log.info('PAUSE released from control panel');
      }
    } catch {
      /* unreadable flag: leave it — fail toward staying paused */
    }
  } else {
    result.paused = isGdrivePaused();
  }
  return result;
}

/** Test/ops probe. */
export function hasControlPanelIdCache(): boolean {
  return existsSync(panelIdCachePath());
}
