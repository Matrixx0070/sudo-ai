/**
 * @file notebooklm/probe-store.ts
 * @description On-disk persistence for E4 self runs and F63 identity baselines,
 * under data/notebooklm/. The self run is recorded when the export job asks the
 * self reader the probe questions; the matching external paste (E2 return)
 * later loads it back by set id to run the comparison. Local JSON only — no
 * Drive, no memory writes (invariant: memory mutates via the memory API alone).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../shared/paths.js';
import type { SelfRunResult } from './probe.js';

function runsDir(): string {
  const d = join(dataPath('notebooklm'), 'probe-runs');
  mkdirSync(d, { recursive: true });
  return d;
}
function baselinesDir(): string {
  const d = join(dataPath('notebooklm'), 'probe-baselines');
  mkdirSync(d, { recursive: true });
  return d;
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, '_');

export function saveSelfRun(run: SelfRunResult): void {
  writeFileSync(join(runsDir(), `${safe(run.setId)}.json`), JSON.stringify(run, null, 2));
}

export function loadSelfRun(setId: string): SelfRunResult | null {
  const p = join(runsDir(), `${safe(setId)}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SelfRunResult;
  } catch {
    return null;
  }
}

/** F63: pin the current run as the identity baseline (only if none exists). */
export function ensureBaseline(run: SelfRunResult): SelfRunResult {
  const p = join(baselinesDir(), `${safe(run.setId)}.json`);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as SelfRunResult;
    } catch {
      /* rewrite below */
    }
  }
  writeFileSync(p, JSON.stringify(run, null, 2));
  return run;
}

export function loadBaseline(setId: string): SelfRunResult | null {
  const p = join(baselinesDir(), `${safe(setId)}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SelfRunResult;
  } catch {
    return null;
  }
}
