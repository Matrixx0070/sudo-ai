/**
 * @file gdrive/mirror.ts
 * @description F37 — world mirror: beliefs track external reality's documents.
 *
 * Config lists external references (URLs) + cadence. The job snapshots each
 * into knowledge/mirror/<ref> as text — the SAME file updated in place, so
 * Drive revisions are the change history. Changed content diffs against the
 * previous snapshot; changed sections route through quarantine (F18, external
 * tier) and dependent beliefs get flagged (F22). Bounded fetch budget; a
 * conservative robots/ToS posture is the operator's responsibility when
 * configuring references (documented).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { dataPath, projectPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import { inspectContent, type InspectOptions } from './quarantine.js';
import { loadBeliefs, saveBeliefs, flagSourceChanged } from './beliefs.js';
import { emitGdriveAudit } from './audit.js';
import type { AuditTrail } from '../security/audit-trail.js';

const log = createLogger('gdrive:mirror');

export interface MirrorRef {
  name: string; // filename-safe reference name
  url: string;
  /** Minimum hours between fetches (default 24). */
  cadenceHours?: number;
}

export interface MirrorConfig {
  refs: MirrorRef[];
  /** Max fetches per sweep (budget; default 5). */
  budgetPerSweep?: number;
  /** Max bytes per fetch (default 2 MB). */
  maxBytes?: number;
}

export function mirrorConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['GDRIVE_MIRROR_CONFIG'] ?? projectPath('config', 'gdrive-mirror.json');
}

export function loadMirrorConfig(env: NodeJS.ProcessEnv = process.env): MirrorConfig {
  try {
    const parsed = JSON.parse(readFileSync(mirrorConfigPath(env), 'utf-8')) as MirrorConfig;
    return {
      refs: (parsed.refs ?? []).filter((r) => /^[\w.-]{1,64}$/.test(r.name) && /^https:\/\//.test(r.url)),
      budgetPerSweep: parsed.budgetPerSweep ?? 5,
      maxBytes: parsed.maxBytes ?? 2 * 1024 * 1024,
    };
  } catch {
    return { refs: [], budgetPerSweep: 5, maxBytes: 2 * 1024 * 1024 };
  }
}

interface MirrorState {
  /** ref name -> { lastFetch, driveFileId, contentSha } */
  refs: Record<string, { lastFetch: string; driveFileId?: string; contentSha?: string }>;
}

function statePath(): string {
  return dataPath('gdrive', 'mirror-state.json');
}

function loadState(): MirrorState {
  try {
    return { refs: (JSON.parse(readFileSync(statePath(), 'utf-8')) as MirrorState).refs ?? {} };
  } catch {
    return { refs: {} };
  }
}

function saveState(state: MirrorState): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Injectable fetcher for tests. Returns text or null on failure. */
export type MirrorFetcher = (url: string, maxBytes: number) => Promise<string | null>;

export const defaultFetcher: MirrorFetcher = async (url, maxBytes) => {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30_000);
    (t as { unref?: () => void }).unref?.();
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'sudo-ai-world-mirror/1.0 (+drive memory substrate)' },
      redirect: 'follow',
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  }
};

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface MirrorSweepResult {
  fetched: string[];
  changed: string[];
  flaggedBeliefs: string[];
  held: string[];
}

/** One mirror sweep, budget-bounded. */
export async function runMirrorSweep(
  client: DriveClient,
  folders: FolderIdMap,
  audit: AuditTrail | null,
  opts: {
    config?: MirrorConfig;
    fetcher?: MirrorFetcher;
    inspect?: InspectOptions;
    now?: () => Date;
  } = {},
): Promise<MirrorSweepResult> {
  const result: MirrorSweepResult = { fetched: [], changed: [], flaggedBeliefs: [], held: [] };
  const config = opts.config ?? loadMirrorConfig();
  if (!config.refs.length) return result;
  const mirrorFolder = folders['knowledge/mirror'];
  if (!mirrorFolder) throw new Error('gdrive mirror: knowledge/mirror folder id missing');
  const fetcher = opts.fetcher ?? defaultFetcher;
  const now = opts.now?.() ?? new Date();
  const state = loadState();
  let budget = config.budgetPerSweep ?? 5;

  for (const ref of config.refs) {
    if (budget <= 0) break;
    const refState = state.refs[ref.name] ?? { lastFetch: '1970-01-01T00:00:00Z' };
    const cadenceMs = (ref.cadenceHours ?? 24) * 3_600_000;
    if (now.getTime() - Date.parse(refState.lastFetch) < cadenceMs) continue;

    budget--;
    const text = await fetcher(ref.url, config.maxBytes ?? 2 * 1024 * 1024);
    refState.lastFetch = now.toISOString();
    state.refs[ref.name] = refState;
    if (text === null) {
      log.warn({ ref: ref.name }, 'mirror fetch failed — will retry next cadence');
      continue;
    }
    result.fetched.push(ref.name);
    const contentSha = sha(text);
    if (contentSha === refState.contentSha) continue; // unchanged

    // Changed content is EXTERNAL-tier input: inspect before it goes anywhere.
    const verdict = await inspectContent(text, opts.inspect ?? {});
    if (verdict.verdict === 'hold') {
      result.held.push(ref.name);
      emitGdriveAudit(audit, {
        job: 'mirror',
        outcome: 'denied',
        durationMs: 0,
        detail: { ref: ref.name, riskScore: verdict.riskScore, reasons: verdict.reasons.slice(0, 8) },
      });
      continue; // do not snapshot injected content into the tree
    }

    // Same file updated in place -> Drive revisions = change history.
    if (refState.driveFileId) {
      try {
        await client.filesUpdate(refState.driveFileId, {}, { mimeType: 'text/plain', body: text });
      } catch {
        refState.driveFileId = undefined;
      }
    }
    if (!refState.driveFileId) {
      const existing = (await client.listChildren(mirrorFolder)).find((f) => f.name === `${ref.name}.txt`);
      if (existing) {
        await client.filesUpdate(existing.id, {}, { mimeType: 'text/plain', body: text });
        refState.driveFileId = existing.id;
      } else {
        const created = await client.filesCreate(
          { name: `${ref.name}.txt`, parents: [mirrorFolder] },
          { mimeType: 'text/plain', body: text },
        );
        refState.driveFileId = created.id;
      }
    }

    if (refState.contentSha) {
      // Not the first snapshot: dependents of this mirror file go stale (F22).
      result.changed.push(ref.name);
      const graph = loadBeliefs();
      const flagged = flagSourceChanged(graph, refState.driveFileId);
      if (flagged.length) {
        saveBeliefs(graph);
        result.flaggedBeliefs.push(...flagged);
      }
    }
    refState.contentSha = contentSha;
  }
  saveState(state);
  if (result.changed.length || result.held.length) log.info(result, 'mirror sweep complete');
  return result;
}

/** Test/ops probe. */
export function hasMirrorState(): boolean {
  return existsSync(statePath());
}
