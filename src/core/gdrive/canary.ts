/**
 * @file gdrive/canary.ts
 * @description F19 — canary tripwires.
 *
 * HUMAN plants 2-3 decoy files that look real; their fileIds + unique UUID
 * markers live ONLY in a local config file (never in Drive, never in the
 * canonical tree, never committed). Every Drive-derived payload is checked;
 * any hit => CRITICAL audit + immediate local pause flag (harness-side; the
 * Sheet cannot pause us, F7 note) + incident bundle.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import { emitGdriveAudit } from './audit.js';

const log = createLogger('gdrive:canary');

export interface CanaryConfig {
  canaries: Array<{ fileId: string; marker: string; label?: string }>;
}

export function canaryConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['GDRIVE_CANARY_CONFIG'] ?? dataPath('gdrive', 'canaries.json');
}

export function loadCanaryConfig(env: NodeJS.ProcessEnv = process.env): CanaryConfig {
  try {
    const parsed = JSON.parse(readFileSync(canaryConfigPath(env), 'utf-8')) as CanaryConfig;
    return { canaries: Array.isArray(parsed.canaries) ? parsed.canaries : [] };
  } catch {
    return { canaries: [] };
  }
}

export interface CanaryHit {
  kind: 'fileId' | 'marker';
  label?: string;
}

/** Check a Drive fileId against the canary list. */
export function checkCanaryFileId(fileId: string, config: CanaryConfig): CanaryHit | null {
  // Guard: marker-only canaries store an empty fileId — never match a real file.
  const c = config.canaries.find((x) => x.fileId !== '' && x.fileId === fileId);
  return c ? { kind: 'fileId', label: c.label } : null;
}

/**
 * G-CANARYWRITE: register a canary LOCALLY (never in Drive, never committed —
 * same invariant as the human-planted ones). F67 uses this to watermark an
 * outbound embassy pack: the marker is registered here, so if that watermarked
 * text ever returns as inbound content, checkCanaryPayload trips F19. Idempotent
 * by marker. `fileId` is optional (marker-only watermark canaries omit it).
 */
export function registerCanary(
  entry: { marker: string; fileId?: string; label?: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!entry.marker) throw new Error('registerCanary: marker required');
  const config = loadCanaryConfig(env);
  if (config.canaries.some((c) => c.marker === entry.marker)) return; // dedupe
  config.canaries.push({ fileId: entry.fileId ?? '', marker: entry.marker, ...(entry.label ? { label: entry.label } : {}) });
  const p = canaryConfigPath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2), { mode: 0o600 });
  log.info({ label: entry.label }, 'canary registered locally (G-CANARYWRITE)');
}

/** Check any Drive-derived payload / outbound argument for canary markers. */
export function checkCanaryPayload(text: string, config: CanaryConfig): CanaryHit | null {
  for (const c of config.canaries) {
    if (c.marker && text.includes(c.marker)) return { kind: 'marker', label: c.label };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pause flag (harness-side kill: gdrive jobs no-op while present)
// ---------------------------------------------------------------------------

export function pauseFlagPath(): string {
  return dataPath('gdrive', 'PAUSED');
}

export function isGdrivePaused(): boolean {
  return existsSync(pauseFlagPath());
}

export function setGdrivePaused(reason: string): void {
  const p = pauseFlagPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ pausedAt: new Date().toISOString(), reason }, null, 2), {
    mode: 0o600,
  });
}

/** Operator-only unpause (documented in gdrive-setup.md). */
export function clearGdrivePause(): void {
  rmSync(pauseFlagPath(), { force: true });
}

/**
 * Trip the alarm: CRITICAL audit + pause flag. The caller aborts its pipeline
 * immediately after (and attaches an incident bundle where a run context
 * exists, F10).
 */
export function tripCanary(audit: AuditTrail | null, hit: CanaryHit, context: string): void {
  log.error({ hit, context }, 'CANARY TRIPPED — pausing all gdrive jobs');
  emitGdriveAudit(audit, {
    job: 'canary-trip',
    outcome: 'denied',
    durationMs: 0,
    detail: { severity: 'CRITICAL', kind: hit.kind, label: hit.label, context },
  });
  setGdrivePaused(`canary ${hit.kind}${hit.label ? `:${hit.label}` : ''} in ${context}`);
}
